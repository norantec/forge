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

const FORGE_OPTIONS_SCHEMA = z.object({
  entry: z.string().nonempty(),
  outputFile: z.string().nonempty(),
  tsProject: z.union([z.string().nonempty().default('tsconfig.json'), z.undefined()]),
});

export type ForgeSerializableOptions = z.infer<typeof FORGE_OPTIONS_SCHEMA>;

export interface ForgeUnserializableOptions {
  typescript: {
    customTransformers?: ts.CustomTransformers;
  };
  onGetFileContent: (filePath: string) => string;
  onOutputFile: (filePath: string, content: string) => void;
  onLog?: (level: Schema.LogLevel, message?: string) => void;
}

export type ForgeOptions = ForgeSerializableOptions & ForgeUnserializableOptions;

const BUILD_OPTIONS_SCHEMA = z.object({
  bundleDependencies: z.union([z.boolean().optional().default(false), z.undefined()]),
  defines: z.record(z.string()).optional().default({}),
  obfuscate: z.union([z.boolean().optional().default(false), z.undefined()]),
  obfuscatorConfigFilePath: z.string().optional(),
});

export type BuildOptions = z.infer<typeof BUILD_OPTIONS_SCHEMA>;

function maybeESModule(code: string) {
  const [imports, exports] = parseESModuleLex(code);
  return imports.length > 0 || exports.length > 0;
}

export class Forge {
  protected readonly outputMap = new Map<string, string>();

  protected readonly options: ForgeSerializableOptions = FORGE_OPTIONS_SCHEMA.parse(this.originalOptions);

  protected readonly configPath = ts.findConfigFile('.', ts.sys.fileExists, this.options.tsProject!)!;

  protected readonly tsConfig = ts.parseJsonConfigFileContent(
    ts.readConfigFile(this.configPath, ts.sys.readFile),
    ts.sys,
    path.dirname(this.configPath),
  );

  protected readonly entryOutputPath = _.attempt(() =>
    ts
      .getOutputFileNames(this.tsConfig, path.relative(process.cwd(), path.resolve(this.options.entry)), false)
      .find((filePath) => filePath.endsWith('.js')),
  );

  public constructor(protected readonly originalOptions: ForgeOptions) {
    const tsProgram = ts.createProgram({ rootNames: this.tsConfig.fileNames, options: this.tsConfig.options });
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
  }

  public async build(options?: BuildOptions) {
    await init;

    const buildOptions = _.attempt(() => BUILD_OPTIONS_SCHEMA.parse(options || {}));

    if (buildOptions instanceof Error) {
      this.log('error', `Invalid build options: ${buildOptions.message}`);
      return;
    }

    if (this.entryOutputPath instanceof Error) {
      this.log('error', `Failed to determine entry output path: ${this.entryOutputPath.message}`);
      return;
    }

    if (typeof this.entryOutputPath === 'undefined') {
      this.log(
        'error',
        `Failed to determine entry output path: No .js output file found for entry ${this.options.entry}`,
      );
      return;
    }

    const loadObfuscatorConfig = (): ObfuscatorOptions => {
      if (StringUtil.isFalsyString(buildOptions.obfuscatorConfigFilePath)) return {};

      const absoluteObfuscatorConfigFilePath = path.resolve(buildOptions.obfuscatorConfigFilePath!);
      const obfuscatorConfig = _.attempt(() =>
        requireFromString(this.originalOptions.onGetFileContent(absoluteObfuscatorConfigFilePath)),
      );

      if (obfuscatorConfig instanceof Error) return {};

      return obfuscatorConfig;
    };

    const esbuildResult = await AttemptUtil.execPromise(
      esbuild.build({
        entryPoints: [path.resolve(this.entryOutputPath!)],
        bundle: true,
        platform: 'node',
        loader: {
          '.node': 'base64',
        },
        logLevel: 'silent',
        format: 'cjs',
        write: false,
        define: buildOptions.defines,
        plugins: [
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

                if (buildOptions.bundleDependencies) {
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

    if (esbuildResult instanceof Error) {
      this.log('error', `Failed to build client code: ${esbuildResult.message}`);
      return;
    }

    if (esbuildResult.errors.length > 0) {
      this.log('error', `Builder built with error: ${esbuildResult.errors[0].text}`);
      return;
    }

    const absoluteOutputFile = path.resolve(this.options.outputFile);
    let resultCode = esbuildResult.outputFiles[0].text;

    if (buildOptions.obfuscate) {
      resultCode = (() => {
        const obfuscatedCode = _.attempt(() => {
          return obfuscate(resultCode, loadObfuscatorConfig()).getObfuscatedCode();
        });

        if (obfuscatedCode instanceof Error) return resultCode;

        return obfuscatedCode;
      })();
    }

    _.attempt(() => this.originalOptions.onOutputFile(absoluteOutputFile, resultCode));
  }

  protected log(level: Schema.LogLevel, ...messages: string[]) {
    _.attempt(() => this.originalOptions?.onLog?.(level, messages?.join?.(' ')));
  }
}
