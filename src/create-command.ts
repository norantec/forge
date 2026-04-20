import { Command } from 'commander';
import { z } from 'zod';
import * as _ from 'lodash';

interface CommandOption {
  flags: string;
  defaultValue?: string | boolean | string[];
  description: string;
  parser?: (value: string, previous: string[]) => any;
}

function collect(value: string, previous: string[]) {
  return Array.isArray(previous) ? previous.concat(value.split(',')) : [value];
}

const CREATE_COMMAND_OPTIONS = z.object({
  hiddenOptions: z.array(z.string().nonempty()).optional(),
  name: z.string().optional(),
});

export const createCommand = (
  rawOptions: z.infer<typeof CREATE_COMMAND_OPTIONS> & {
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
        flags: '--log-level',
        description: 'Log level',
        defaultValue: 'info',
      },
      {
        flags: '--definitions <string>',
        description: 'Path for definitions JSON file',
      },
      {
        flags: '--define <string>',
        description: 'Define a single definition, e.g. --define FOO=1, prior to --definitions',
        parser: collect,
      },
    ] as CommandOption[]
  ).forEach(() => {});

  command
    .argument('<source>', 'The source code file to be processed')
    .argument('<output>', 'The output file for the generated code');

  return command;
};
