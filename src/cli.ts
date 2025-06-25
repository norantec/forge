#!/usr/bin/env node

import { createForgeCommand } from './forge';

createForgeCommand({
    onLog: (level, message) => {
        console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
    },
}).parse(process.argv);
