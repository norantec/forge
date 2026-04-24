#!/usr/bin/env node

import { createCommand } from './create-command';

createCommand('forge', {
  onLog: (level, message) => console.log(`[${new Date().toISOString()}]`, `- ${level} -`, message),
})?.parse?.(process.argv);
