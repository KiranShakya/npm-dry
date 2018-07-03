import {Cli} from './cli';
import {DryDependencies} from './dry-dependencies';

/**
 * Resolves dry dependencies
 */
export class DependencyResolver {
    /**
     * @param {Cli} cli The cli to use
     */
    constructor(private readonly cli: Cli) {
    }

    /**
     * Resolves provided dry dependencies by fetching them if necessary.
     * The resolution success means that all requested depencies are available in the current work directory.
     * @param {DryDependencies} dependencies The dependencies to resolve
     * @return {Promise<void>} A resolved promise on success, rejected promise on failure.
     */
    public resolve(dependencies: DryDependencies): Promise<void> {

        const args: string[] = [];
        Object.keys(dependencies).forEach((dependencyName) => {
            const dependencyVersion = dependencies[dependencyName];
            if (dependencyVersion && dependencyVersion.indexOf(':') !== -1) {
                args.push(dependencyVersion);
            } else {
                let arg = dependencyName;
                if (dependencyVersion) {
                    arg += '@' + dependencyVersion;
                }
                args.push(arg);
            }
        });
        if (args.length === 0) {
            return Promise.resolve();
        }

        if (args.length > 0) {
            return this.cli.execute('npm install --no-save ' + args.join(' '));
        } else {
            return Promise.resolve(null);
        }
    }

    public resolveRaw(args: string[]): Promise<void> {
        console.info('resolving', args);

        if (args.length > 0) {
            let commandLine = 'git clone ' + args.join(' ');

            return this.cli.execute(commandLine)
                .catch((error) => {
                    throw error;
                });
        } else {
            return Promise.resolve(null);
        }
    }
}
