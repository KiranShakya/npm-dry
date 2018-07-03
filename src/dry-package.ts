import * as deepDiff from 'deep-diff';
import * as merge from 'deepmerge';
import * as fs from 'fs';
import * as requireCwd from 'import-cwd';
import { DependencyResolver } from './dependency-resolver';
import { DryPackageContent } from './dry-package-content';
import { JsonUtils } from './json-utils';
import { NpmPackage } from './npm-package';

// TODO: consider adding a type to 'any'
// tslint:disable-next-line:no-any
export type WeakDryPackageContent = DryPackageContent & any;

/**
 * The dry package (i.e. package-dry.json) is the pendant of the npm package (i.e. package.json).
 * A dry package is an npm package added of a DryPackageDescriptor.
 */
export class DryPackage {
    private static readonly PACKAGE_DRY_JSON = 'package-dry.json';

    private static readonly MANAGED_DEPENDENCY = 'MANAGED';

    private constructor(
        private readonly dependencyResolver: DependencyResolver,
        private readonly location: string,
        // tslint:disable-next-line:variable-name
        private _content: WeakDryPackageContent,
    ) {}

    public static readFromDisk(dependencyResolver: DependencyResolver): DryPackage {
        const location = './' + DryPackage.PACKAGE_DRY_JSON;
        let fileContent = '{}';
        try {
            fileContent = fs.readFileSync(location, 'utf8');
        } catch (e) {
            // TODO: Bad practice to silence exception
        }
        const baseDryPackage = JSON.parse(fileContent);
        return new DryPackage(dependencyResolver, location, baseDryPackage);
    }

    public applyDiff(oldContent: WeakDryPackageContent, newContent: WeakDryPackageContent): void {
        const diffs = deepDiff.diff(oldContent, newContent);
        if (!diffs) {
            return;
        }
        diffs.forEach((diff) => deepDiff.applyChange(this._content, this._content, diff));
        fs.writeFileSync(this.location, JsonUtils.prettyStringify(this._content));
    }

    public exists(): boolean {
        return fs.existsSync(this.location);
    }

    /**
     * Builds a NpmPackage
     * @return {Promise<NpmPackage>} The NpmPackage
     */
    public buildNpmPackage(): Promise<NpmPackage> {
        return this.doBuildNpmPackage();
    }

    /**
     * Merge DryPackage content into the current DryPackage content
     * @param {DryPackage} dryPackage The DryPackage content to append
     */
    private merge(dryPackage: DryPackage): void {
        this._content = merge(this._content, dryPackage._content);
    }

    /**
     * Recursive method.
     * Walks the DryPackage tree to build a full NpmPackage.
     *
     * @param {DryPackage} currentPackage The DryPackage to walk
     * @param {DryPackage[]} collectedPackages The walked DryPackages
     * @return {Promise<NpmPackage>} The full NpmPackage
     */
    private doBuildNpmPackage(currentPackage?: DryPackage, collectedPackages?: DryPackage[]): Promise<NpmPackage> {
        currentPackage = currentPackage || this;
        collectedPackages = collectedPackages || [];

        collectedPackages.push(currentPackage);

        return currentPackage.getParent().then<NpmPackage>((parents) => {
            if (parents) {
                const mergedParents: DryPackage = parents.reduce((prev: DryPackage, current: DryPackage): DryPackage => {
                    prev.merge(current);
                    return prev;
                });
                return this.doBuildNpmPackage(mergedParents, collectedPackages);
            } else {
                const mergedPackage = collectedPackages.pop();
                while (collectedPackages.length > 0) {
                    mergedPackage.merge(collectedPackages.pop());
                }
                mergedPackage.resolveManagedDependencies();
                return new NpmPackage(mergedPackage);
            }
        });
    }

    private loadFromFile(path: string): Promise<DryPackage> {
        console.info('loading dry from path', path);
        try {
            const content: string = fs.readFileSync(path, 'utf8');

            return Promise.resolve(new DryPackage(this.dependencyResolver, path, JSON.parse(content)));
        } catch (e) {
            console.error('error', e);

            throw e;
        }
    }

    private getParent(): Promise<DryPackage[]> {
        const dry = this._content.dry;
        if (!dry) {
            return Promise.resolve(null);
        }
        if (!dry.extends) {
            return Promise.resolve(null);
        }
        // simply load a package-dry.json (most likely in the same repository)
        if (typeof dry.extends === 'string') {
            return this.handlePackages([dry.extends], []);
        } else if (typeof dry.extends === 'object' && dry.extends.length) {
            return this.handlePackages(dry.extends, []);
        }
        return Promise.resolve(null);
    }

    private handlePackages(extendsArray: string[], allParentPackages?: DryPackage[]): Promise<DryPackage[]> {
        const loadingPackages: Promise <DryPackage[]> = new Promise((resolvePromise) => {
            this.handleExtend(extendsArray.shift()).then((pkg: DryPackage) => {
                allParentPackages.push(pkg);
                if (extendsArray.length > 0) {
                    this.handlePackages(extendsArray, allParentPackages).then((returnedParentPackages: DryPackage[]) => {
                        resolvePromise(returnedParentPackages);
                    });
                } else {
                    resolvePromise(allParentPackages);
                }
            });
        });
        return loadingPackages;
    }

    private handleExtend(extend: string): Promise<DryPackage> {
        if (extend.startsWith('file://')) {
            return this.loadFromFile(extend.replace('file://', ''));
        } else {
            console.info('resolving the dry.extends', extend);

            let packageName: string = '';
            let packageFile: string = '/' + DryPackage.PACKAGE_DRY_JSON;
            let realGitRepoUrl: string = extend;
            let branch: string = '';
            const matched: string[] = extend.match('([\\w|\\-|_]+)\\.git');
            if (matched.length && matched.length === 2) {
                // assume that the reponame is the packageName
                packageName = matched[1];
                const splitExtend: string[] = extend.split(packageName + '.git', 2);
                if (splitExtend.length > 1) {
                    packageFile = splitExtend[1];
                    const matchedbranch: string[] = packageFile.match('^#([\\w|\\-|_]*)');
                    if (matchedbranch.length && matchedbranch.length === 2) {
                        branch = matchedbranch[1];
                        packageFile = packageFile.substr(matchedbranch[0].length);
                    }
                    realGitRepoUrl = splitExtend[0].concat(packageName, '.git');
                }
            } else {
                throw new Error('couldn\'t extract packageName from:' + extend);
            }

            const packagePath = './cloned-repos/'.concat(packageName, branch ? '/'.concat(branch) : '') ;

            if (fs.existsSync(packagePath)) {
                console.info('using existing package', packagePath);

                return this.loadFromFile(packagePath + '/' + packageFile);
            } else {
                return this.dependencyResolver.resolveRaw([branch ? '-b '.concat(branch) : '', realGitRepoUrl, packagePath])
                    .then(() => {
                        return this.loadFromFile(packagePath + '/' + packageFile);
                    });
            }
        }
    }

    public get content(): WeakDryPackageContent {
        return JSON.parse(JSON.stringify(this._content));
    }

    /**
     * This method will resolve managed version of dependencies
     */
    private resolveManagedDependencies(): void {
        let dependencies = this._content.dependencies;
        const dependencyMgmt = this._content.dependencyManagement;
        this.resolveManaged(dependencies, dependencyMgmt);

        dependencies = this._content.devDependencies;
        this.resolveManaged(dependencies, dependencyMgmt);
    }

    /**
     * This method will replace any value equals to "managed" provided
     * in dependencies parameter by the value of the same key provided
     * in dependenciesManagement parameter
     * @param {any} dependencies object containing a list of key/value
     * @param {any} dependencyManagement object containing a list of key/value
     */
    private resolveManaged(dependencies: { [s: string]: string }, dependencyManagement: { [s: string]: string }): void {
        if (!dependencies || !dependencyManagement) {
            return;
        }

        Object.getOwnPropertyNames(dependencies)
            .filter((key) => DryPackage.MANAGED_DEPENDENCY === dependencies[key].toUpperCase())
            .forEach((key) => {
                const managedVersion = dependencyManagement[key];
                if (managedVersion) {
                    dependencies[key] = managedVersion;
                } else {
                    throw new Error(`Package ${key} must inherit a version but none are provided!`);
                }
            });
    }
}
