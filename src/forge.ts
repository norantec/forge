/* eslint-disable @typescript-eslint/no-this-alias */
import * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import * as webpack from 'webpack';
import TerserPlugin = require('terser-webpack-plugin');
import VirtualModulesPlugin = require('webpack-virtual-modules');
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import * as _ from 'lodash';
import * as memfs from 'memfs';
import { Worker } from 'node:worker_threads';
import * as chokidar from 'chokidar';
import * as ignore from 'ignore';
import * as readline from 'node:readline';
import * as chalk from 'chalk';
import { Schema } from '@open-norantec/utilities/dist/schema-util.class';
import { Command } from 'commander';

export type LogHandler = (level: Schema.LogLevel, message?: string) => void;

function renderProgressBar(percent, message, file) {
    const barLength = 40;
    const filledLength = Math.round((percent / 100) * barLength);
    const bar = `${'█'.repeat(filledLength)}${'-'.repeat(barLength - filledLength)}`;

    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(
        `${chalk.green(`[${bar}]`)} ${chalk.yellow(`${percent}%`)} ${chalk.gray(message)} ${chalk.cyan(file)}`,
    );

    if (percent === 100) {
        process.stdout.write('\n');
    }
}

class CatchNotFoundPlugin {
    public constructor(private onLog?: LogHandler) {}
    public apply(resolver: webpack.Resolver) {
        const resolve = resolver.resolve;
        resolver.resolve = function (context: Record<string, any>, currentPath, request, resolveContext, callback) {
            const self: CatchNotFoundPlugin = this;
            resolve.call(self, context, currentPath, request, resolveContext, (error, innerPath, result) => {
                const notfoundPathname = path.resolve(__dirname, '../../preserved/@@notfound.js') + `?${request}`;
                if (result) {
                    return callback(null, innerPath, result);
                }
                if (error && !error.message.startsWith("Can't resolve")) {
                    return callback(error);
                }
                // Allow .js resolutions to .tsx? from .tsx?
                if (
                    request.endsWith('.js') &&
                    context.issuer &&
                    (context.issuer.endsWith('.ts') || context.issuer.endsWith('.tsx'))
                ) {
                    return resolve.call(
                        self,
                        context,
                        currentPath,
                        request.slice(0, -3),
                        resolveContext,
                        (error1, innerPath, result) => {
                            if (result) return callback(null, innerPath, result);
                            if (error1 && !error1.message.startsWith("Can't resolve")) return callback(error1);
                            // make not found errors runtime errors
                            callback(null, notfoundPathname, {
                                path: result,
                                context,
                            });
                        },
                    );
                }
                self?.onLog?.('warn', `Notfound '${context.issuer}' from '${request}', skipping...`);
                // make not found errors runtime errors
                callback(null, notfoundPathname, {
                    path: result,
                    context,
                });
            });
        };
    }
}

class CleanNonJSFilePlugin {
    public apply(compiler: webpack.Compiler) {
        compiler.hooks.compilation.tap(CleanNonJSFilePlugin.name, (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: CleanNonJSFilePlugin.name,
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
                },
                (assets) => {
                    Object.keys(assets).forEach((key) => {
                        if (!key?.endsWith?.('.js')) {
                            _.unset(assets, key);
                        }
                    });
                },
            );
        });
    }
}

class VirtualFilePlugin {
    public constructor(private readonly volume: memfs.IFs) {}

    public apply(compiler: webpack.Compiler) {
        compiler.outputFileSystem = this.volume as webpack.OutputFileSystem;
    }
}

class ForceWriteBundlePlugin {
    public constructor(private readonly outputPath: string) {}

    public apply(compiler: webpack.Compiler) {
        compiler.hooks.compilation.tap(ForceWriteBundlePlugin.name, (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: ForceWriteBundlePlugin.name,
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
                },
                (assets) => {
                    Object.entries(assets).forEach(([pathname, asset]) => {
                        const absolutePath = path.resolve(this.outputPath, pathname);
                        _.attempt(() => {
                            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
                        });
                        fs.writeFileSync(absolutePath, asset?.buffer?.());
                    });
                },
            );
        });
    }
}

interface AutoRunPluginOptions {
    parallel?: boolean;
    onAfterStart?: (worker: Worker) => void | Promise<void>;
    onBeforeStart?: () => void | Promise<void>;
    onLog?: LogHandler;
}

class AutoRunPlugin {
    public constructor(
        private readonly options: AutoRunPluginOptions = {},
        private readonly volume: memfs.IFs,
    ) {}

    public apply(compiler: webpack.Compiler) {
        compiler.hooks.beforeCompile.tapAsync('AutoRunPlugin', async (compilationParams, callback) => {
            if (this.options.onBeforeStart) {
                await this.options?.onBeforeStart?.();
            }
            callback();
        });
        compiler.hooks.afterEmit.tapAsync('AutoRunPlugin', async (compilation: webpack.Compilation, callback) => {
            const assets = compilation.getAssets();

            if (assets.length === 0) {
                this.options?.onLog?.('warn', 'No output file was found, skipping...');
                callback();
                return;
            }

            const bundledScriptFile = assets?.find?.((item) => item?.name?.endsWith?.('.js'))?.name;

            if (StringUtil.isFalsyString(bundledScriptFile)) {
                this.options?.onLog?.('warn', 'No output file was found, skipping...');
                callback();
                return;
            }

            const outputPath = path.resolve(compilation.options.output.path!, bundledScriptFile!);

            this.options?.onLog?.('info', `Prepared to run file: ${outputPath}`);

            const worker = new Worker(this.volume.readFileSync(outputPath).toString(), {
                eval: true,
            });

            if (this.options.onAfterStart) {
                await this.options?.onAfterStart?.(worker);
            }

            worker.on('exit', (code) => {
                if (code !== 0) {
                    this.options?.onLog?.('error', `Process exited with code: ${code}`);
                }
                if (!this.options?.parallel) {
                    callback();
                }
            });
            worker.on('error', (error) => {
                this.options?.onLog?.('error', 'Worker error:');
                this.options?.onLog?.('error', error?.message);
                this.options?.onLog?.('error', error?.stack?.toString?.());
                if (!this.options?.parallel) {
                    callback();
                }
            });

            if (this.options?.parallel) {
                callback();
            }
        });
    }
}

class RunOncePlugin {
    public constructor(private readonly onLog?: LogHandler) {}

    public apply(compiler: webpack.Compiler) {
        compiler.hooks.compilation.tap(RunOncePlugin.name, (compilation) => {
            compilation.hooks.processAssets.tapAsync(
                {
                    name: RunOncePlugin.name,
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
                },
                (assets, callback) => {
                    const targetAsset = Object.entries(assets)?.find?.(([pathname]) => pathname?.endsWith?.('.js'));

                    if (!targetAsset) {
                        throw new Error('Not found any JS bundle file, exitting...');
                    }

                    this.onLog?.('info', `Found bundle file: ${targetAsset?.[0]}, executing...`);

                    const worker = new Worker(targetAsset?.[1]?.buffer?.()?.toString?.(), {
                        eval: true,
                    });

                    worker.on('exit', (code) => {
                        if (code !== 0) {
                            this?.onLog?.('error', `Process exited with code: ${code}`);
                        }
                        callback();
                    });

                    worker.on('error', (error) => {
                        this?.onLog?.('error', 'Worker error:');
                        this?.onLog?.('error', error?.message);
                        this?.onLog?.('error', error?.stack?.toString?.());
                        callback(error);
                    });
                },
            );
        });
    }
}

const AFTER_EMIT_ACTION_SCHEMA = z.enum(['watch', 'run-once', 'none']).default('none');

const FORGE_OPTIONS_SCHEMA = z.object({
    binary: z.boolean().optional(),
    clean: z.boolean().optional().default(true),
    debug: z.union([z.boolean().default(false), z.undefined()]),
    entry: z.union([z.string().default('main.ts'), z.undefined()]),
    mode: z.union([z.enum(['development', 'production']).default('production'), z.undefined()]),
    outputDir: z.union([z.string().default('dist'), z.undefined()]),
    outputName: z.union([z.string().default('main'), z.undefined()]),
    outputNameFormat: z.union([z.string().default('[name].js'), z.undefined()]),
    sourceDir: z.union([z.string().default('src'), z.undefined()]),
    tsProject: z.union([z.string().default('tsconfig.json'), z.undefined()]),
    workDir: z.union([z.string().default(process.cwd()), z.undefined()]),
});

type ForgeBaseOptions = z.infer<typeof FORGE_OPTIONS_SCHEMA>;
type AfterEmitAction = z.infer<typeof AFTER_EMIT_ACTION_SCHEMA>;

export interface ForgeGetEntryFileContentContext {
    entryDirPath: string;
    entryFilePath: string;
    options: ForgeBaseOptions;
    outputPath: string;
    tsConfig: ts.ParsedCommandLine;
    virtualEntryFilePath: string;
}

export type ForgeOptions = ForgeBaseOptions & {
    getEntryFileContent?: (context: ForgeGetEntryFileContentContext) => string;
    onLog?: LogHandler;
    onProgress?: (percentage: number, message: string, ...params: string[]) => void;
};

export class Forge {
    protected options: ForgeOptions;
    protected tsConfig: ts.ParsedCommandLine;
    protected entryFilePath: string;
    protected entryDirPath: string;
    protected outputPath: string;
    protected virtualEntryFilePath: string;

    public constructor(private readonly inputOptions: ForgeOptions) {
        this.options = FORGE_OPTIONS_SCHEMA.parse(this.inputOptions);
        const configPath = ts.findConfigFile(this.options.workDir!, ts.sys.fileExists, this.options.tsProject!);

        if (!configPath) throw new Error('Could not find a valid tsconfig.json.');

        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

        if (configFile.error) {
            throw new Error(
                ts.formatDiagnosticsWithColorAndContext([configFile.error], {
                    getCanonicalFileName: (f) => f,
                    getCurrentDirectory: ts.sys.getCurrentDirectory,
                    getNewLine: () => ts.sys.newLine,
                }),
            );
        }

        this.tsConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
        this.entryFilePath = path.resolve(this.options.workDir!, this.options.sourceDir!, this.options.entry!);
        this.entryDirPath = path.dirname(this.entryFilePath);
        this.outputPath = path.resolve(this.options.workDir!, this.options.outputDir!);
        this.virtualEntryFilePath = path.resolve(
            this.entryDirPath,
            `virtual_${Math.random().toString(32).slice(2)}.ts`,
        );
    }

    public run(inputAfterEmitActionType: AfterEmitAction) {
        const afterEmitActionType = AFTER_EMIT_ACTION_SCHEMA.parse(inputAfterEmitActionType);

        if (StringUtil.isFalsyString(this.options.outputName!)) throw new Error(`Invalid generate type`);

        let currentWorker: Worker | null = null;
        const compiler = webpack({
            cache: false,
            optimization: {
                minimize: false,
                minimizer: [
                    new TerserPlugin({
                        terserOptions: {
                            keep_classnames: true,
                            keep_fnames: true,
                        },
                    }),
                ],
            },
            entry: {
                [name!]: this.virtualEntryFilePath,
            },
            target: 'node',
            mode: this.options.mode,
            output: {
                devtoolModuleFilenameTemplate: '[absolute-resource-path]',
                filename: this.options.outputNameFormat,
                path: this.outputPath,
                libraryTarget: 'commonjs',
            },
            resolve: {
                extensions: ['.js', '.cjs', '.mjs', '.ts', '.tsx'],
                alias: {
                    src: path.resolve(this.options.workDir!, this.options.sourceDir!),
                    UNKNOWN: false,
                },
                plugins: [new CatchNotFoundPlugin(this.inputOptions?.onLog)],
            },
            module: {
                rules: [
                    {
                        test: /\.ts$/,
                        use: {
                            loader: require.resolve('ts-loader'),
                            options: {
                                compiler: require.resolve('ts-patch/compiler', {
                                    paths: [__dirname, process.cwd()],
                                }),
                                configFile: path.resolve(this.options.workDir!, this.options.tsProject!),
                            },
                        },
                        exclude: /node_modules/,
                    },
                ],
            },
            plugins: [
                new webpack.ProgressPlugin((percentage, message, ...args) => {
                    if (typeof this.inputOptions?.onProgress === 'function') {
                        this.inputOptions.onProgress(percentage, message, ...args);
                    } else {
                        renderProgressBar(Math.floor(percentage * 100), message, args[0] || '');
                    }
                }),
                ...(() => {
                    const result: any[] = [];

                    result.push(
                        new CleanNonJSFilePlugin(),
                        new VirtualModulesPlugin({
                            [this.virtualEntryFilePath]: (() => {
                                if (typeof this.inputOptions?.getEntryFileContent === 'function') {
                                    return this.inputOptions.getEntryFileContent({
                                        entryDirPath: this.entryDirPath,
                                        entryFilePath: this.entryFilePath,
                                        options: this.options,
                                        outputPath: this.outputPath,
                                        tsConfig: this.tsConfig,
                                        virtualEntryFilePath: this.virtualEntryFilePath,
                                    });
                                }
                                return fs.readFileSync(this.entryFilePath).toString();
                            })(),
                        }),
                    );

                    if (
                        !(['run-once', 'watch'] as AfterEmitAction[]).includes(afterEmitActionType) ||
                        this.options?.debug
                    ) {
                        result.push(new ForceWriteBundlePlugin(this.outputPath));
                        if (this.options?.debug) return result;
                    }

                    if (afterEmitActionType === 'run-once') {
                        result.push(new RunOncePlugin(this.options?.onLog));
                    }

                    if (afterEmitActionType === 'watch') {
                        const volume = new memfs.Volume() as memfs.IFs;
                        result.push(
                            new VirtualFilePlugin(volume),
                            new AutoRunPlugin(
                                {
                                    parallel: true,
                                    onAfterStart: (worker) => {
                                        currentWorker = worker;
                                    },
                                    onBeforeStart: () => {
                                        _.attempt(() => {
                                            currentWorker!.terminate();
                                        });
                                    },
                                    onLog: this.options?.onLog,
                                },
                                volume,
                            ),
                        );
                    }

                    return result;
                })(),
            ],
        });

        const runCompiler = () => {
            compiler.run((error) => {
                if (error) {
                    this.inputOptions?.onLog?.(
                        'error',
                        `Builder finished with error: ${error?.message}, stack: ${error?.stack?.toString?.()}`,
                    );
                }
            });
        };
        const watchHandler = () => {
            _.attempt(() => currentWorker!.terminate());
            currentWorker = null;
            _.attempt(() => {
                compiler.close(() => {
                    runCompiler();
                });
            });
        };

        if (afterEmitActionType === 'watch') {
            const ig = ignore().add(
                (() => {
                    const gitIgnorePath = path.resolve('.gitignore');
                    if (fs.existsSync(gitIgnorePath) && fs.statSync(gitIgnorePath).isFile()) {
                        return fs.readFileSync(gitIgnorePath).toString();
                    }
                    return '';
                })(),
            );
            const watcher = chokidar.watch(process.cwd(), {
                persistent: true,
                ignoreInitial: true,
                ignored: (pathname) => {
                    const relativePath = path.relative(process.cwd(), pathname);
                    if (StringUtil.isFalsyString(relativePath)) return false;
                    if (relativePath.startsWith('.git')) return true;
                    return ig.ignores(relativePath);
                },
            });
            watcher.on('change', watchHandler);
            watcher.on('add', watchHandler);
            watcher.on('unlink', watchHandler);
        }

        if (this.options?.clean) {
            this.inputOptions?.onLog?.('info', `Cleaning output directory: ${this.outputPath}`);
            _.attempt(() => fs.rmSync(this.outputPath, { recursive: true, force: true }));
            this.inputOptions?.onLog?.('info', 'Output directory cleaned');
        }

        runCompiler();
    }
}

export const createForgeCommand = (options?: Pick<ForgeOptions, 'getEntryFileContent' | 'onLog'>) => {
    const command = new Command();
    command
        .argument('<entry>', 'Entry path relative to work-dir and source-dir, e.g. main.ts')
        .option('--after-emit-action <string>', 'Action after emitting, e.g. watch/run-once')
        .option('--binary', 'Compile output JavaScript bundle to an executable')
        .option('--clean', 'Clean legacy output', true)
        .option('--work-dir <string>', 'Work directory path', process.cwd())
        .option('--source-dir <string>', 'Source directory path', 'src')
        .option('--output-dir <string>', 'Output directory path', 'dist')
        .option('--output-name <string>', 'Output file name', 'main')
        .option('--output-name-format <string>', 'Ouptput file name format', '[name].js')
        .option('--ts-project <string>', 'Path for TypeScript config file', 'tsconfig.json')
        .option('--debug', 'Debug mode', false)
        .action((entry, commandOptions) => {
            new Forge({
                entry,
                ..._.omit(commandOptions, ['afterEmitAction']),
                ..._.pick(options, ['onLog', 'getEntryFileContent']),
            } as unknown as ForgeOptions).run(commandOptions?.afterEmitAction);
        });
    return command;
};
