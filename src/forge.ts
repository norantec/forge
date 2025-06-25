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
import * as originalFs from 'fs';
import * as originalFsPromises from 'fs/promises';
import { VMUtil } from '@open-norantec/utilities/dist/vm-util.class';
import { EventEmitter } from 'eventemitter3';

const EMITTED = Symbol();
const RUN = Symbol();

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

class CompilePlugin {
    public constructor(
        private readonly absoluteOutputPath: string,
        private readonly volume: memfs.IFs,
        private readonly onLog?: LogHandler,
    ) {}

    public apply(compiler: webpack.Compiler) {
        compiler.hooks.compilation.tap(CompilePlugin.name, (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: CompilePlugin.name,
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
                },
                (assets) => {
                    const relativePath = Object.keys(assets).find((currentRelativePath) => {
                        return currentRelativePath?.endsWith?.('.js');
                    });

                    if (StringUtil.isFalsyString(relativePath)) return;

                    try {
                        const nodeVersion = process.version.split('.')[0].replace(/^v/g, '');
                        const absoluteBundlePath = path.resolve(this.absoluteOutputPath, relativePath!);

                        const matchBundlePath = (pathname: originalFs.PathLike) => {
                            return typeof pathname === 'string' && path.resolve(pathname) === absoluteBundlePath;
                        };
                        const createPatchedFsMethod = <T extends (...args: any[]) => any>(
                            proxiedFn: (...args: any[]) => any,
                            originalFn: (...args: Parameters<T>) => ReturnType<T>,
                            isPromise = false,
                        ): T => {
                            return ((pathname: string, ...args) => {
                                if (matchBundlePath(pathname)) {
                                    if (isPromise) {
                                        return new Promise((resolve, reject) => {
                                            try {
                                                resolve(proxiedFn?.(pathname, ...args));
                                            } catch (error) {
                                                reject(error);
                                            }
                                        });
                                    } else {
                                        return proxiedFn?.(pathname, ...args);
                                    }
                                }
                                return originalFn?.(...([pathname, ...args] as Parameters<T>));
                            }) as T;
                        };
                        const proxiedFsPromises: typeof originalFsPromises = {
                            ...originalFsPromises,
                            ...['stat', 'lstat', 'readFile', 'readdir', 'rm'].reduce(
                                (result, methodName) => {
                                    result[methodName] = createPatchedFsMethod(
                                        this.volume[`${methodName}Sync`].bind(this.volume),
                                        originalFsPromises[methodName].bind(originalFsPromises),
                                        true,
                                    );
                                    return result;
                                },
                                {} as Partial<typeof originalFsPromises>,
                            ),
                        };
                        const proxiedFs: typeof originalFs = {
                            ...originalFs,
                            ...['existsSync', 'realpathSync'].reduce((result, methodName) => {
                                result[methodName] = createPatchedFsMethod(
                                    this.volume[methodName].bind(this.volume),
                                    originalFs[methodName].bind(originalFs),
                                );
                                return result;
                            }, {}),
                            promises: {
                                ...originalFs.promises,
                                ...proxiedFsPromises,
                            },
                        };

                        this.volume.mkdirSync(path.dirname(absoluteBundlePath), { recursive: true });
                        this.volume.writeFileSync(absoluteBundlePath, assets[relativePath!]?.buffer?.());
                        VMUtil.runScriptCode(
                            `
                                const Module = require('module');
                                const originalLoad = Module._load;
                                Module._load = function(request, parent) {
                                    if (request === 'fs' || request === 'node:fs') return proxiedFs;
                                    if (request === 'fs/promises' || request === 'node:fs/promises') return proxiedFsPromises;
                                    return originalLoad.apply(this, arguments);
                                };
                                const { exec } = require('@yao-pkg/pkg');
                                exec(['${absoluteBundlePath}', '--target', '${['linux', 'macos', 'win'].map((os) => `node${nodeVersion}-${os}-${process.arch}`)}', '--out-path', '${this.absoluteOutputPath}']);
                                proxiedFs.unlinkSync('${absoluteBundlePath}');
                            `,
                            {
                                volume: this.volume,
                                proxiedFs,
                                proxiedFsPromises,
                            },
                        );

                        _.unset(assets, relativePath!);
                    } catch (error) {
                        this.onLog?.(
                            'error',
                            `Error compiling to binary: ${error?.message}, stack: ${error?.stack?.toString?.()}`,
                        );
                        process.exit(1);
                    }
                },
            );
        });
    }
}

const AFTER_EMIT_ACTION_SCHEMA = z.enum(['watch', 'run-once', 'compile', 'none']).default('none');

const FORGE_OPTIONS_SCHEMA = z.object({
    afterEmitAction: z.union([AFTER_EMIT_ACTION_SCHEMA, z.undefined()]),
    clean: z.boolean().optional().default(true),
    debug: z.union([z.boolean().default(false), z.undefined()]),
    entry: z.union([z.string().default('main.ts'), z.undefined()]),
    outputDir: z.union([z.string().default('dist'), z.undefined()]),
    outputName: z.union([z.string().default('main'), z.undefined()]),
    outputNameFormat: z.union([z.string().default('[name].js'), z.undefined()]),
    sourceDir: z.union([z.string().default('src'), z.undefined()]),
    tsCompiler: z.string().optional(),
    tsProject: z.union([z.string().default('tsconfig.json'), z.undefined()]),
    workDir: z.union([z.string().default(process.cwd()), z.undefined()]),
});

type ForgeBaseOptions = z.infer<typeof FORGE_OPTIONS_SCHEMA>;
type AfterEmitAction = z.infer<typeof AFTER_EMIT_ACTION_SCHEMA>;

export interface ForgeContext {
    entryDirPath: string;
    entryFilePath: string;
    options: ForgeBaseOptions;
    outputPath: string;
    tsConfig: ts.ParsedCommandLine;
    virtualEntryFilePath: string;
}

export type ForgeOptions = ForgeBaseOptions & {
    getEntryFileContent?: (context: ForgeContext) => string;
    onLog?: LogHandler;
    getMode?: (context: ForgeContext) => 'development' | 'production';
    onProgress?: (percentage: number, message: string, ...params: string[]) => void;
};

export class Forge {
    protected options: ForgeOptions;
    protected tsConfig: ts.ParsedCommandLine;
    protected entryFilePath: string;
    protected entryDirPath: string;
    protected outputPath: string;
    protected virtualEntryFilePath: string;
    protected readonly emitter = new EventEmitter();
    protected compiler: webpack.Compiler | null = null;
    protected worker: Worker | null = null;

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

        if (this.options.afterEmitAction! === 'watch') {
            const watchHandler = () => {
                _.attempt(() => this.worker!.terminate());
                this.worker = null;
                _.attempt(() =>
                    this.compiler!.close((error) => {
                        if (!error && !this.compiler?.running) {
                            this.compiler = null;
                            this.emitter.emit(RUN);
                        }
                    }),
                );
            };
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

        this.emitter.addListener(EMITTED, (result: webpack.Stats | undefined) => {
            if ((['watch', 'run-once'] as AfterEmitAction[]).includes(this.options.afterEmitAction!)) {
                const bundleFileSource = Object.entries(result?.compilation?.assets ?? {}).find(([fileName]) =>
                    fileName?.endsWith?.('.js'),
                )?.[1];

                if (!bundleFileSource) {
                    throw new Error('Cannot find any file to run');
                }

                this.worker = new Worker(bundleFileSource.buffer().toString(), {
                    eval: true,
                });
            }
        });
        this.emitter.addListener(RUN, () => {
            this.run();
        });
    }

    public run() {
        const context: ForgeContext = {
            entryDirPath: this.entryDirPath,
            entryFilePath: this.entryFilePath,
            options: this.options,
            outputPath: this.outputPath,
            tsConfig: this.tsConfig,
            virtualEntryFilePath: this.virtualEntryFilePath,
        };

        if (StringUtil.isFalsyString(this.options.outputName!)) throw new Error(`Invalid generate type`);

        const volume = new memfs.Volume() as memfs.IFs;
        this.compiler = webpack({
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
                [this.options.outputName!]: this.virtualEntryFilePath,
            },
            target: 'node',
            mode: this.inputOptions?.getMode?.(context) ?? 'production',
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
                                ...(StringUtil.isFalsyString(this.options?.tsCompiler)
                                    ? {}
                                    : { compiler: this.options.tsCompiler! }),
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
                                    const content = this.inputOptions.getEntryFileContent(context);
                                    if (StringUtil.isFalsyString(content)) {
                                        return fs.readFileSync(this.entryFilePath).toString();
                                    } else {
                                        return content;
                                    }
                                }
                                return fs.readFileSync(this.entryFilePath).toString();
                            })(),
                        }),
                    );

                    if (
                        !(['run-once', 'watch'] as AfterEmitAction[]).includes(this.options.afterEmitAction!) ||
                        this.options?.debug
                    ) {
                        result.push(new ForceWriteBundlePlugin(this.outputPath));
                        if (this.options?.debug) return result;
                    }

                    if (this.options.afterEmitAction! === 'compile') {
                        result.push(new CompilePlugin(this.outputPath, volume, this.options?.onLog));
                    }

                    return result;
                })(),
            ],
        });

        const runCompiler = () => {
            if (this.compiler instanceof webpack.Compiler) {
                this.compiler.run((error, result) => {
                    if (error) {
                        this.inputOptions?.onLog?.(
                            'error',
                            `Builder finished with error: ${error?.message}, stack: ${error?.stack?.toString?.()}`,
                        );
                    } else {
                        this.emitter.emit(EMITTED, result);
                    }
                });
            }
        };

        if (this.options?.clean && (['compile', 'none'] as AfterEmitAction[]).includes(this.options.afterEmitAction!)) {
            this.inputOptions?.onLog?.('info', `Cleaning output directory: ${this.outputPath}`);
            _.attempt(() => fs.rmSync(this.outputPath, { recursive: true, force: true }));
            this.inputOptions?.onLog?.('info', 'Output directory cleaned');
        }

        runCompiler();
    }
}

export interface CreateForgeCommandOptions extends Partial<ForgeOptions> {
    hideOptions?: string[];
}

interface Option {
    flags: string;
    defaultValue?: string | boolean | string[];
    description?: string;
}

export const createForgeCommand = (options?: CreateForgeCommandOptions) => {
    const command = new Command();

    command.argument('<entry>', 'Entry path relative to work-dir and source-dir, e.g. main.ts');

    (
        [
            {
                flags: '--after-emit-action <string>',
                description: 'Action after emitting, e.g. watch/run-once/compile',
                defaultValue: 'none',
            },
            {
                flags: '--clean',
                description: 'Clean legacy output',
                defaultValue: true,
            },
            {
                flags: '--work-dir <string>',
                description: 'Work directory path',
                defaultValue: process.cwd(),
            },
            {
                flags: '--source-dir <string>',
                description: 'Source directory path',
                defaultValue: 'src',
            },
            {
                flags: '--output-dir <string>',
                description: 'Output directory path',
                defaultValue: 'dist',
            },
            {
                flags: '--output-name <string>',
                description: 'Output file name',
                defaultValue: 'main',
            },
            {
                flags: '--output-name-format <string>',
                description: 'Ouptput file name format',
                defaultValue: '[name].js',
            },
            {
                flags: '--ts-project <string>',
                description: 'Path for TypeScript config file',
                defaultValue: 'tsconfig.json',
            },
            {
                flags: '--ts-compiler <string>',
                description: 'Path or module name for TypeScript compiler',
            },
            {
                flags: '--debug',
                description: 'Debug mode',
                defaultValue: false,
            },
        ] as Option[]
    ).forEach((item) => {
        if (options?.hideOptions?.includes?.(item.flags.split(/\s+/g)[0])) return;
        command.option(item.flags, item?.description, item?.defaultValue);
    });

    command.action((entry, commandOptions) => {
        new Forge({
            entry,
            ...options,
            ...commandOptions,
        } as unknown as ForgeOptions).run();
    });

    return command;
};
