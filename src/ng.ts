import { z } from 'zod';
import { init, parse as parseESModuleLex } from 'es-module-lexer';
import { Schema } from '@open-norantec/utilities/dist/schema-util.class';
import * as _ from 'lodash';
import * as ts from 'typescript';
import * as esbuild from 'esbuild';
import * as path from 'path';
import { AttemptUtil } from '@open-norantec/utilities/dist/attempt-util.class';
import * as module from 'node:module';
import * as babel from '@babel/core';
import { ObfuscatorOptions, obfuscate } from 'javascript-obfuscator';
import * as requireFromString from 'require-from-string';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'eventemitter3';

const FORGE_OPTIONS_SCHEMA = z.object({
  entry: z.string().nonempty(),
  executeAfterBuild: z.union([z.boolean().optional().default(true), z.undefined()]),
  outputFile: z.string().nonempty(),
  tsProject: z.union([z.string().nonempty().default('tsconfig.json'), z.undefined()]),
});

export type ForgeSerializableOptions = z.infer<typeof FORGE_OPTIONS_SCHEMA>;

export interface ForgeUnserializableOptions {
  typescript?: {
    customTransformers?: ts.CustomTransformers;
  };
  getVirtualEntryFileContent?: (buildEntryFilePath: string) => string;
  onGetFileContent: (filePath: string) => string;
  onOutputFile: (filePath: string, content: string) => void;
  onLog?: (level: Schema.LogLevel, message?: string) => void;
  rewriteOutputFile?: (code: string) => string;
}

export type ForgeOptions = ForgeSerializableOptions & ForgeUnserializableOptions;

const RUN_OPTIONS_SCHEMA = z.object({
  bundleDependencies: z.union([z.boolean().optional().default(false), z.undefined()]),
  definitions: z.record(z.string()).optional().default({}),
  obfuscate: z.union([z.boolean().optional().default(false), z.undefined()]),
  obfuscatorConfigFilePath: z.string().optional(),
  watch: z.union([z.boolean().optional().default(false), z.undefined()]),
});

export type RunOptions = z.infer<typeof RUN_OPTIONS_SCHEMA>;

function maybeESModule(code: string) {
  const [imports, exports] = parseESModuleLex(code);
  return imports.length > 0 || exports.length > 0;
}

const RUNNER_EXIT = Symbol();

export class Forge {
  protected readonly emitter = new EventEmitter();
  protected readonly outputMap = new Map<string, string>();

  protected readonly options: ForgeSerializableOptions = ((originalOptions: ForgeOptions) => {
    return FORGE_OPTIONS_SCHEMA.parse(originalOptions);
  })(this.originalOptions);

  protected readonly configPath = ((tsProject: string) => ts.findConfigFile('.', ts.sys.fileExists, tsProject!)!)(
    this.options.tsProject!,
  );

  protected readonly tsConfig = ((configPath: string) => {
    return ts.parseJsonConfigFileContent(
      ts.readConfigFile(configPath, ts.sys.readFile).config,
      ts.sys,
      path.dirname(configPath),
    );
  })(this.configPath);

  protected readonly buildEntryFilePath = ((parsedCommandLine: ts.ParsedCommandLine, configPath: string) => {
    this.tsConfig.options.configFilePath = configPath;
    const tsProgram = ts.createProgram({ rootNames: parsedCommandLine.fileNames, options: parsedCommandLine.options });
    tsProgram.emit(
      undefined,
      (fileName, data) => {
        const absolutePath = path.resolve(fileName);
        this.outputMap.set(absolutePath, data);
        this.log('info', `Compiled ${absolutePath}`);
      },
      undefined,
      false,
      this.originalOptions?.typescript?.customTransformers,
    );
    const result = _.attempt(() =>
      ts
        .getOutputFileNames(parsedCommandLine, path.relative(process.cwd(), path.resolve(this.options.entry)), false)
        .find((filePath) => filePath.endsWith('.js')),
    );
    if (result instanceof Error) return undefined;
    return result;
  })(this.tsConfig, this.configPath);

  protected readonly virtualEntryFileContent = ((entryFilePath) => {
    if (StringUtil.isFalsyString(entryFilePath)) return undefined;
    if (typeof this.originalOptions.getVirtualEntryFileContent !== 'function') return undefined;
    return this.originalOptions.getVirtualEntryFileContent!(entryFilePath!);
  })(path.resolve(this.buildEntryFilePath!));

  protected readonly finalBuildEntryFilePath =
    typeof this.buildEntryFilePath === 'undefined'
      ? null
      : StringUtil.isFalsyString(this.virtualEntryFileContent)
        ? this.buildEntryFilePath
        : path.resolve(
            path.dirname(this.buildEntryFilePath),
            `entry-${Date.now()}-${Math.random().toString(16).slice(2)}.js`,
          );

  protected readonly virtualEntryMode = this.buildEntryFilePath !== this.finalBuildEntryFilePath;

  public constructor(protected readonly originalOptions: ForgeOptions) {}

  public async run(options?: RunOptions) {
    await init;

    const runOptions = _.attempt(() => RUN_OPTIONS_SCHEMA.parse(options || {}));

    if (runOptions instanceof Error) {
      this.log('error', `Invalid build options: ${runOptions.message}`);
      return;
    }

    if (this.finalBuildEntryFilePath === null) {
      this.log(
        'error',
        `Failed to determine entry output path: No .js output file found for entry ${this.options.entry}`,
      );
      return;
    }

    this.log('info', `Using entry file: ${this.finalBuildEntryFilePath}`);

    const loadObfuscatorConfig = (): ObfuscatorOptions => {
      if (StringUtil.isFalsyString(runOptions.obfuscatorConfigFilePath)) return {};

      const absoluteObfuscatorConfigFilePath = path.resolve(runOptions.obfuscatorConfigFilePath!);
      const obfuscatorConfig = _.attempt(() =>
        requireFromString(this.originalOptions.onGetFileContent(absoluteObfuscatorConfigFilePath)),
      );

      if (obfuscatorConfig instanceof Error) return {};

      return obfuscatorConfig;
    };

    const esbuildContext = await AttemptUtil.execPromise(
      esbuild.context({
        entryPoints: [path.resolve(this.finalBuildEntryFilePath)],
        bundle: true,
        platform: 'node',
        loader: {
          '.node': 'base64',
        },
        logLevel: 'silent',
        format: 'cjs',
        write: false,
        define: runOptions.definitions,
        plugins: [
          {
            name: 'watch-result',
            setup: (build) => {
              build.onEnd((result) => {
                if (result.errors.length > 0) {
                  this.log('error', `Build failed with ${result.errors.length} errors`);
                  result.errors.forEach((error) => this.log('error', error.text));
                  return;
                }

                const absoluteOutputFile = path.resolve(this.options.outputFile);
                let resultCode = result.outputFiles?.[0]?.text;

                if (StringUtil.isFalsyString(resultCode)) {
                  this.log('error', 'No output code generated');
                  return;
                }

                if (runOptions.obfuscate) {
                  resultCode = (() => {
                    const obfuscatedCode = _.attempt(() => {
                      return obfuscate(resultCode!, loadObfuscatorConfig()).getObfuscatedCode();
                    });
                    if (obfuscatedCode instanceof Error) return resultCode;
                    return obfuscatedCode;
                  })();
                }

                if (typeof this.originalOptions.rewriteOutputFile === 'function') {
                  resultCode = this.originalOptions.rewriteOutputFile!(resultCode!);
                }

                this.handleOutputFile(absoluteOutputFile, resultCode!, !!runOptions.watch);
              });
            },
          },
          {
            name: 'tsconfig-paths',
            setup: (build) => {
              build.onResolve({ filter: /.*/ }, (args) => {
                const hasMatchingPath = Object.keys(this.tsConfig.options?.paths || {}).some((path) =>
                  new RegExp(path.replace('*', '\\w*')).test(args.path),
                );

                if (!hasMatchingPath) {
                  return null;
                }

                const { resolvedModule } = ts.nodeModuleNameResolver(
                  args.path,
                  args.importer,
                  this.tsConfig.options || {},
                  ts.sys,
                );

                if (!resolvedModule) return null;

                const { resolvedFileName } = resolvedModule;

                if (!resolvedFileName || resolvedFileName.endsWith('.d.ts')) return null;

                const resolved = ts.sys.resolvePath(resolvedFileName);

                this.log('info', `Resolved file using TypeScript paths: ${args.path} -> ${resolved})`);

                return { path: resolved };
              });
            },
          },
          {
            name: 'forge',
            setup: (build) => {
              build.onResolve({ filter: /.*/ }, async (args) => {
                if (this.virtualEntryMode && StringUtil.isFalsyString(args.importer)) {
                  return { path: args.path, namespace: 'virtual-entry' };
                }

                if (
                  args.path.startsWith('node:') ||
                  module.builtinModules.some(
                    (moduleName) => args.path.startsWith(moduleName) || args.path.startsWith(`${moduleName}/`),
                  )
                ) {
                  return { path: args.path, external: true };
                }

                if (this.outputMap.has(args.path)) return { path: args.path, namespace: 'vfs' };

                if (this.outputMap.has(args.importer)) {
                  const targetPaths: string[] = [];
                  const absoluteImportPath = path.resolve(path.dirname(args.importer), args.path);

                  if (!['.js', '.cjs'].includes(path.extname(absoluteImportPath))) {
                    targetPaths.push(absoluteImportPath + '.js');
                    targetPaths.push(absoluteImportPath + '.cjs');
                    targetPaths.push(path.resolve(absoluteImportPath, 'index.js'));
                    targetPaths.push(path.resolve(absoluteImportPath, 'index.cjs'));
                  } else {
                    targetPaths.push(absoluteImportPath);
                  }

                  for (const targetPath of targetPaths) {
                    if (this.outputMap.has(targetPath)) {
                      return { path: targetPath, namespace: 'vfs' };
                    }
                  }
                }

                if (runOptions.bundleDependencies) {
                  const requiredPath = _.attempt(() =>
                    require.resolve(args.path, {
                      paths: [
                        ...(() => {
                          const result: string[] = [];
                          let currentDir = path.dirname(args.importer);

                          result.push(currentDir);

                          while (currentDir !== path.dirname(currentDir)) {
                            result.push(path.dirname(currentDir));
                            currentDir = path.dirname(currentDir);
                          }

                          return result;
                        })(),
                        ...(require.resolve.paths('') || []),
                      ],
                    }),
                  );

                  if (!(requiredPath instanceof Error)) {
                    return { path: requiredPath, namespace: this.outputMap.has(requiredPath) ? 'vfs' : undefined };
                  }
                }

                return { path: args.path, external: true };
              });

              build.onLoad({ filter: /.*/, namespace: 'virtual-entry' }, () => {
                return {
                  contents: this.virtualEntryFileContent!,
                  loader: 'js',
                };
              });

              build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
                const contents = this.outputMap.get(args.path);
                return {
                  contents,
                  loader: 'js',
                };
              });

              build.onLoad({ filter: /node_modules\/.*.(mjs|js)$/ }, (args) => {
                const code = _.attempt(() => this.originalOptions.onGetFileContent(args.path));

                if (code instanceof Error) {
                  this.log('error', `Failed to read file content for ${args.path}: ${code.message}`);
                  return null;
                }

                if (maybeESModule(code)) {
                  const transformed = _.attempt(() => {
                    return babel.transformSync(code, {
                      plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
                    });
                  });

                  if (transformed instanceof Error) {
                    this.log('error', `Failed to transform ES module for ${args.path}: ${transformed.message}`);
                    return {
                      contents: code,
                      loader: 'js',
                    };
                  }

                  return {
                    contents: transformed?.code || code,
                    loader: 'js',
                  };
                }

                return {
                  contents: code,
                  loader: 'js',
                };
              });

              build.onLoad({ filter: /.*/, namespace: 'json' }, (args) => {
                const contents = _.attempt(() => this.originalOptions.onGetFileContent(args.path));

                if (contents instanceof Error) {
                  this.log('error', `Failed to read file content for ${args.path}: ${contents.message}`);
                  return null;
                }

                return {
                  contents: `module.exports = ${JSON.stringify(contents)}`,
                  loader: 'js',
                };
              });
            },
          },
        ],
      }),
    );

    if (esbuildContext instanceof Error) {
      this.log('error', `Failed to create build context: ${esbuildContext.message}`);
      return;
    }

    if (runOptions.watch) {
      await esbuildContext.watch();
      this.emitter.on(RUNNER_EXIT, async () => {
        await esbuildContext.rebuild();
      });
    } else {
      await esbuildContext.rebuild();
      await esbuildContext.dispose();
    }
  }

  protected log(level: Schema.LogLevel, ...messages: string[]) {
    _.attempt(() => this.originalOptions?.onLog?.(level, messages?.join?.(' ')));
  }

  protected handleOutputFile(filePath: string, content: string, watchMode = false) {
    _.attempt(() => this.originalOptions.onOutputFile(filePath, content));

    if (!watchMode || !this.options.executeAfterBuild) return;

    this.log('info', `Executing output file ${filePath}`);

    const worker = new Worker(content!, { eval: true });

    worker.on('error', (error) => {
      this.log('error', `Bundle execution error: ${error.message}`);
      _.attempt(() => worker.terminate());
    });

    worker.on('exit', (code) => {
      this.log('info', `Bundle execution exited with code ${code}`);
      this.emitter.emit(RUNNER_EXIT);
    });
  }
}
