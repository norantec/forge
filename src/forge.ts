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
import * as crypto from 'node:crypto';

const FORGE_OPTIONS_SCHEMA = z.object({
  bundleDependencies: z.union([z.boolean().optional().default(false), z.undefined()]),
  cwd: z.string().nonempty(),
  define: z.array(z.string().nonempty()).optional(),
  definitionsFile: z.string().nonempty().optional(),
  entry: z.string().nonempty(),
  executeAfterBuild: z.union([z.boolean().optional().default(true), z.undefined()]),
  externals: z.array(z.string().nonempty()).optional(),
  obfuscate: z.union([z.boolean().optional().default(false), z.undefined()]),
  obfuscatorConfigFilePath: z.string().optional(),
  outputFile: z.string().nonempty(),
  tsProject: z.union([z.string().nonempty().default('tsconfig.json'), z.undefined()]),
  watch: z.union([z.boolean().optional().default(false), z.undefined()]),
});

export type ForgeSerializableOptions = z.infer<typeof FORGE_OPTIONS_SCHEMA>;

export type Watcher = {
  close: () => void | Promise<void>;
};

export interface ForgeUnserializableOptions {
  customTransformers?: (program: ts.Program) => ts.CustomTransformers;
  getVirtualEntryFileContent?: (buildEntryFilePath: string) => string | Promise<string>;
  getWatcher?: (callback: (filePath: string) => void | Promise<void>) => Watcher;
  onGetFileContent: (filePath: string) => string;
  onOutputFile: (filePath: string, content: string) => void;
  onLog?: (level: Schema.LogLevel, message?: string) => void;
  rewriteOutputFile?: (code: string) => string | Promise<string>;
}

export type ForgeOptions = ForgeSerializableOptions & ForgeUnserializableOptions;

function maybeESModule(code: string) {
  const [imports, exports] = parseESModuleLex(code);
  return imports.length > 0 || exports.length > 0;
}

export class Forge {
  protected readonly WORKERS = new Set<Worker>();
  protected readonly CONCERNED_FILES = new Map<string, string>();

  protected readonly options: ForgeSerializableOptions = ((originalOptions: ForgeOptions) => {
    return FORGE_OPTIONS_SCHEMA.parse(originalOptions);
  })(this.originalOptions);

  protected readonly watcher =
    typeof this.originalOptions.getWatcher !== 'function' || !this.options?.watch
      ? { close: () => {} }
      : ((originalOptions: ForgeOptions, CONCERNED_FILES: typeof this.CONCERNED_FILES, run: typeof this.run) => {
          const rerun = _.debounce(run.bind(this), 500);
          return originalOptions.getWatcher!(async (filePath) => {
            if (
              !CONCERNED_FILES.has(filePath) ||
              crypto.createHash('sha256').update(originalOptions.onGetFileContent(filePath)).digest('hex') ===
                CONCERNED_FILES.get(filePath)
            ) {
              return;
            }
            await rerun();
          });
        })(this.originalOptions, this.CONCERNED_FILES, this.run.bind(this));

  protected readonly configPath = ((tsProject: string) => ts.findConfigFile('.', ts.sys.fileExists, tsProject!)!)(
    this.options.tsProject!,
  );

  public constructor(protected readonly originalOptions: ForgeOptions) {}

  public async run() {
    await init;

    const outputMap = new Map<string, string>();
    const tsConfig = ((configPath: string) => {
      return ts.parseJsonConfigFileContent(
        ts.readConfigFile(configPath, ts.sys.readFile).config,
        ts.sys,
        path.dirname(configPath),
      );
    })(this.configPath);

    if (!!this.options.watch) {
      Array.from(this.CONCERNED_FILES.keys()).forEach((filePath) => this.CONCERNED_FILES.delete(filePath));
      tsConfig.fileNames.forEach((fileName) => {
        const filePath = this.pathResolve(fileName);
        this.CONCERNED_FILES.set(
          filePath,
          crypto.createHash('sha256').update(this.originalOptions.onGetFileContent(filePath)).digest('hex'),
        );
      });
    }

    tsConfig.options.configFilePath = this.configPath;
    const buildEntryFilePath = ((parsedCommandLine: ts.ParsedCommandLine) => {
      const result = _.attempt(() =>
        ts
          .getOutputFileNames(
            parsedCommandLine,
            path.relative(this.options.cwd, this.pathResolve(this.options.entry)),
            false,
          )
          .find((filePath) => filePath.endsWith('.js')),
      );
      if (result instanceof Error) return undefined;
      return result;
    })(tsConfig);
    const virtualEntryFileContent = await (async (entryFilePath) => {
      if (StringUtil.isFalsyString(entryFilePath)) return undefined;
      if (typeof this.originalOptions.getVirtualEntryFileContent !== 'function') return undefined;
      return this.originalOptions.getVirtualEntryFileContent!(entryFilePath!);
    })(this.pathResolve(buildEntryFilePath!));

    const finalBuildEntryFilePath =
      typeof buildEntryFilePath === 'undefined'
        ? null
        : StringUtil.isFalsyString(virtualEntryFileContent)
          ? buildEntryFilePath
          : this.pathResolve(
              path.dirname(buildEntryFilePath),
              `entry-${Date.now()}-${Math.random().toString(16).slice(2)}.js`,
            );
    const virtualEntryMode = buildEntryFilePath !== finalBuildEntryFilePath;

    if (finalBuildEntryFilePath === null) {
      this.log(
        'error',
        `Failed to determine entry output path: No .js output file found for entry ${this.options.entry}`,
      );
      return;
    }

    this.log('info', `Using entry file: ${finalBuildEntryFilePath}`);

    const loadObfuscatorConfig = (): ObfuscatorOptions => {
      if (StringUtil.isFalsyString(this.options.obfuscatorConfigFilePath)) return {};

      const absoluteObfuscatorConfigFilePath = this.pathResolve(this.options.obfuscatorConfigFilePath!);
      const obfuscatorConfig = _.attempt(() =>
        requireFromString(this.originalOptions.onGetFileContent(absoluteObfuscatorConfigFilePath)),
      );

      if (obfuscatorConfig instanceof Error) return {};

      return obfuscatorConfig;
    };

    const esbuildContext = await AttemptUtil.execPromise(
      esbuild.context({
        entryPoints: [this.pathResolve(finalBuildEntryFilePath)],
        bundle: true,
        platform: 'node',
        loader: {
          '.node': 'base64',
        },
        logLevel: 'silent',
        external: this.options.externals,
        format: 'cjs',
        write: false,
        define: (() => {
          const definitions: Record<string, string> = {};

          if (!StringUtil.isFalsyString(this.options.definitionsFile)) {
            _.attempt(() => {
              const definitionsContent = JSON.parse(
                this.originalOptions.onGetFileContent(path.resolve(this.options.definitionsFile!)),
              );
              if (!_.isPlainObject(definitionsContent)) return;
              Object.entries(definitionsContent).forEach(([key, value]) => {
                if (StringUtil.isFalsyString(key)) return;
                definitions[key] = JSON.stringify(value);
              });
            });
          }

          if (Array.isArray(this.options.define)) {
            this.options.define.forEach((defineItem) => {
              const [key, value] = defineItem.split('=');
              const parsedValue = _.attempt(() => JSON.parse(value));
              if (StringUtil.isFalsyString(key) || parsedValue instanceof Error) return;
              definitions[key] = JSON.stringify(parsedValue);
            });
          }

          this.log('info', `Using definitions: ${JSON.stringify(definitions)}`);

          return definitions;
        })(),
        plugins: [
          {
            name: 'tsconfig-paths',
            setup: (build) => {
              build.onResolve({ filter: /.*/ }, (args) => {
                const hasMatchingPath = Object.keys(tsConfig.options?.paths || {}).some((path) =>
                  new RegExp(path.replace('*', '\\w*')).test(args.path),
                );

                if (!hasMatchingPath) {
                  return null;
                }

                const { resolvedModule } = ts.nodeModuleNameResolver(
                  args.path,
                  args.importer,
                  tsConfig.options || {},
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
              build.onEnd(async (result) => {
                if (result.errors.length > 0) {
                  this.log('error', `Build failed with ${result.errors.length} errors`);
                  result.errors.forEach((error) => this.log('error', error.text));
                  return;
                }

                const absoluteOutputFile = this.pathResolve(this.options.outputFile);
                let resultCode = result.outputFiles?.[0]?.text;

                if (StringUtil.isFalsyString(resultCode)) {
                  this.log('error', 'No output code generated');
                  return;
                }

                if (this.options.obfuscate) {
                  resultCode = (() => {
                    const obfuscatedCode = _.attempt(() => {
                      return obfuscate(resultCode!, loadObfuscatorConfig()).getObfuscatedCode();
                    });
                    if (obfuscatedCode instanceof Error) return resultCode;
                    return obfuscatedCode;
                  })();
                }

                if (typeof this.originalOptions.rewriteOutputFile === 'function') {
                  resultCode = await Promise.resolve(this.originalOptions.rewriteOutputFile!(resultCode!));
                }

                this.handleOutputFile(absoluteOutputFile, resultCode!, !!this.options.watch);
              });

              build.onResolve({ filter: /.*/ }, async (args) => {
                if (virtualEntryMode && StringUtil.isFalsyString(args.importer)) {
                  return { path: args.path, namespace: 'virtual-entry' };
                }

                if (
                  args.path.startsWith('node:') ||
                  module.builtinModules.some((moduleName) => moduleName === args.path.split('/')[0])
                ) {
                  return { path: args.path, external: true };
                }

                if (outputMap.has(args.path)) return { path: args.path, namespace: 'vfs' };

                if (outputMap.has(args.importer)) {
                  const targetPaths: string[] = [];
                  const absoluteImportPath = this.pathResolve(path.dirname(args.importer), args.path);

                  if (!['.js', '.cjs'].includes(path.extname(absoluteImportPath))) {
                    targetPaths.push(absoluteImportPath + '.js');
                    targetPaths.push(absoluteImportPath + '.cjs');
                    targetPaths.push(this.pathResolve(absoluteImportPath, 'index.js'));
                    targetPaths.push(this.pathResolve(absoluteImportPath, 'index.cjs'));
                  } else {
                    targetPaths.push(absoluteImportPath);
                  }

                  for (const targetPath of targetPaths) {
                    if (outputMap.has(targetPath)) {
                      return { path: targetPath, namespace: 'vfs' };
                    }
                  }
                }

                if (this.options.bundleDependencies) {
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
                    return { path: requiredPath, namespace: outputMap.has(requiredPath) ? 'vfs' : undefined };
                  }
                }

                this.log('warn', `[EXTERNAL] ${args.path} from ${args.importer}`);

                return { path: args.path, external: true };
              });

              build.onLoad({ filter: /.*/, namespace: 'virtual-entry' }, () => {
                return {
                  contents: virtualEntryFileContent!,
                  loader: 'js',
                };
              });

              build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
                const contents = outputMap.get(args.path);
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

    const tsProgram = ts.createProgram({ rootNames: tsConfig.fileNames, options: tsConfig.options });

    tsProgram.emit(
      undefined,
      (fileName, data) => {
        const absolutePath = this.pathResolve(fileName);
        outputMap.set(absolutePath, data);
        this.log('info', `Compiled ${absolutePath}`);
      },
      undefined,
      false,
      this.originalOptions?.customTransformers?.(tsProgram),
    );
    await esbuildContext.rebuild();
    await esbuildContext.dispose();
  }

  protected log(level: Schema.LogLevel, ...messages: string[]) {
    _.attempt(() => this.originalOptions?.onLog?.(level, messages?.join?.(' ')));
  }

  protected handleOutputFile(filePath: string, content: string, watchMode = false) {
    _.attempt(() => this.originalOptions.onOutputFile(filePath, content));

    if (!watchMode || !this.options.executeAfterBuild) return;

    Array.from(this.WORKERS).forEach((worker) => {
      _.attempt(() => worker.terminate());
    });

    this.log('info', `Executing output file ${filePath}`);

    const worker = new Worker(content!, { eval: true });

    this.WORKERS.add(worker);

    worker.on('error', (error) => {
      this.log('error', `Bundle execution error: ${error.message}`);
      _.attempt(() => worker.terminate());
    });

    worker.on('exit', (code) => {
      this.log('info', `Current bundle execution exited (${code}), waiting for next execution...`);
      this.WORKERS.delete(worker);
    });
  }

  protected pathResolve(...pathSegments: string[]) {
    return path.resolve(this.options.cwd, ...pathSegments);
  }
}
