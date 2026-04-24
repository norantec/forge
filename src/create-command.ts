import { Command } from 'commander';
import { z } from 'zod';
import * as _ from 'lodash';
import { Forge, ForgeOptions } from './forge';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { Schema, StringUtil } from '@open-norantec/utilities';

interface CommandOption {
  flags: string;
  defaultValue?: string | boolean | string[];
  description: string;
  parser?: (value: string, previous: string[]) => any;
}

function collect(value: string, previous: string[]) {
  return Array.isArray(previous) ? previous.concat(value.split(/,\s*/)) : [value];
}

const CREATE_COMMAND_OPTIONS = z.object({
  hiddenOptions: z.array(z.string().nonempty()).optional(),
});

export type CreateCommandOptions = z.infer<typeof CREATE_COMMAND_OPTIONS> & {
  defaultOptions?: (source: string, output: string | undefined, options: Record<string, any>) => Partial<ForgeOptions>;
  onLog?: (level: Schema.LogLevel, message: string) => void;
};

export interface CreateCommandFactoryContext {
  addArgument: typeof Command.prototype.argument;
  addOption: typeof Command.prototype.option;
  addRequiredOption: typeof Command.prototype.requiredOption;
}

export type CreateCommandInput =
  | CreateCommandOptions
  | ((context: CreateCommandFactoryContext) => CreateCommandOptions);

export const createCommand = (name: string, input: CreateCommandInput) => {
  const command = new Command(name);
  const rawOptions = _.attempt(() => {
    return typeof input === 'function'
      ? input({
          addArgument: command.argument.bind(command),
          addOption: command.option.bind(command),
          addRequiredOption: command.requiredOption.bind(command),
        })
      : input;
  });

  if (rawOptions instanceof Error) return;

  const options = _.attempt(() => CREATE_COMMAND_OPTIONS.parse(rawOptions));
  const log = (level: Schema.LogLevel, ...messages: string[]) => {
    _.attempt(() => rawOptions.onLog?.(level, messages?.join?.(' ')));
  };

  if (options instanceof Error) {
    log('error', 'Invalid options provided to createCommand:', options.message);
    return;
  }

  (
    [
      {
        flags: '--obfuscate',
        description: 'Whether to obfuscate the code',
        defaultValue: false,
      },
      {
        flags: '--obfuscator-config-file <string>',
        description: 'Path to JavaScript obfuscator config file',
      },
      {
        flags: '--ts-project <string>',
        description: 'Path for TypeScript config file',
        defaultValue: 'tsconfig.json',
      },
      {
        flags: '--disable-write-file',
        description: 'Write generated code to file system, only works for non-watch modes',
        defaultValue: false,
      },
      {
        flags: '--bundle-dependencies',
        description: 'Bundle dependencies code into the output file',
        defaultValue: false,
      },
      {
        flags: '--definitions-file <string>',
        description: 'Path for definitions JSON file',
      },
      {
        flags: '--watch',
        description: 'Enable watch mode to automatically rebuild on source file changes',
        defaultValue: false,
      },
      {
        flags: '--execute-after-build',
        description: 'Execute the generated code after rebuild, only works for watch mode',
      },
      {
        flags: '--define <string>',
        description: 'Define a single definition, e.g. --define FOO=1 --define BAR=\"2\". Prior to --definitions',
        parser: collect,
      },
      {
        flags: '--external <string>',
        description:
          'Define a single definition, e.g. --external "*.png" --external "/images/*". Prior to --definitions',
        parser: collect,
      },
    ] as CommandOption[]
  ).forEach((commandOption) => {
    if (options.hiddenOptions?.includes?.(commandOption.flags)) return;
    command.option(
      commandOption.flags,
      commandOption.description,
      typeof commandOption.parser === 'function' ? commandOption.parser : (values) => values,
      commandOption.defaultValue,
    );
  });

  command
    .argument('<source>', 'The source code file to be processed')
    .argument('[output]', 'The output file for the generated code');

  command.action(async (source: string, output: string | undefined, options: Record<string, any> = {}) => {
    const {
      executeAfterBuild,
      tsProject,
      define,
      definitionsFile,
      disableWriteFile = false,
      external,
      obfuscatorConfigFile,
      ...otherOptions
    } = options;

    const forge = new Forge({
      onLog: log,
      onOutputFile: (filePath, content) => {
        if (!disableWriteFile) {
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            _.attempt(() => fs.removeSync(dir));
            _.attempt(() => fs.mkdirpSync(dir));
          }
          _.attempt(() => fs.writeFileSync(filePath, content, 'utf-8'));
          log('info', `Generated file: ${filePath}`);
        }
      },
      onGetFileContent: (filePath) => {
        const content = _.attempt(() => fs.readFileSync(filePath, 'utf-8'));
        if (content instanceof Error) {
          log('error', `Failed to read file content for ${filePath}:`, content.message);
          return '';
        }
        return content;
      },
      getWatcher: (callback) => {
        const watcher = fs.watch(process.cwd(), { recursive: true }, (eventType, filename) => {
          callback(path.resolve(filename));
        });
        return { close: watcher.close.bind(watcher) };
      },
      ...(() => {
        const defaultOptions = rawOptions?.defaultOptions?.(source, output, options);
        return defaultOptions instanceof Error ? {} : defaultOptions || {};
      })(),
      ...otherOptions,
      definitionsFile,
      externals: external,
      define,
      cwd: process.cwd(),
      obfuscatorConfigFilePath: obfuscatorConfigFile,
      entry: source,
      outputFile: StringUtil.isFalsyString(output) ? './bundle.js' : output!,
      tsProject,
      executeAfterBuild,
    });
    await forge.run();
  });

  return command;
};
