#!/usr/bin/env node

import { createCommand } from './create-command';

createCommand({
  name: 'forge',
  onLog: (level, message) => console.log(`[${new Date().toISOString()}]`, `- ${level} -`, message),
  defaultOptions: {
    getVirtualEntryFileContent: (entryFilePath) =>
      [
        `const entry = require('${entryFilePath}');`,
        'console.log(new Date().toISOString());',
        'setInterval(() => {}, 1000000);',
      ].join('\n'),
  },
})?.parse?.(process.argv);
