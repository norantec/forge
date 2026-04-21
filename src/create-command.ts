import { Command } from 'commander';
import { z } from 'zod';
import * as _ from 'lodash';
import { Forge, ForgeOptions, RunOptions } from './ng';
import * as fs from 'fs-extra';
import * as path from 'node:path';

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
  name: z.string().optional(),
});

export const createCommand = (
  rawOptions: z.infer<typeof CREATE_COMMAND_OPTIONS> & {
    defaultOptions?: Partial<ForgeOptions>;
    defaultRunOptions?: Partial<RunOptions>;
    onLog?: (level: string, message: string) => void;
  },
) => {
  const options = _.attempt(() => CREATE_COMMAND_OPTIONS.parse(rawOptions));
  const log = (level: string, ...messages: string[]) => {
    _.attempt(() => rawOptions.onLog?.(level, messages?.join?.(' ')));
  };

  if (options instanceof Error) {
    log('error', 'Invalid options provided to createCommand:', options.message);
    return;
  }

  const command = new Command(options.name);

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
        flags: '--definitions <string>',
        description: 'Path for definitions JSON file',
      },
      {
        flags: '--watch',
        description: 'Enable watch mode to automatically rebuild on source file changes',
      },
      {
        flags: '--execute-after-build',
        description: 'Execute the generated code after rebuild, only works for watch mode',
      },
      {
        flags: '--define <string>',
        description: 'Define a single definition, e.g. --define FOO=1, BAR=\"2\". Prior to --definitions',
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
    .argument('<output>', 'The output file for the generated code');

  command.action(async (source: string, output: string, options: Record<string, any> = {}) => {
    // TODO: definitions
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { executeAfterBuild, tsProject, define, definitions, disableWriteFile = false, ...runOptions } = options;
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
      ...rawOptions?.defaultOptions,
      entry: source,
      outputFile: output,
      tsProject,
      executeAfterBuild,
    });
    await forge.run({
      ...rawOptions?.defaultRunOptions,
      ...(runOptions as unknown as RunOptions),
    });
  });

  return command;
};
