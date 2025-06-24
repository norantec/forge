#!/usr/bin/env node

import * as winston from 'winston';
import { createForgeCommand } from './forge';

const logger = winston.createLogger({
    level: 'verbose',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss',
        }),
        winston.format.printf(
            (info) =>
                `${info.timestamp} - ${info.level}: ${info.message}` +
                (info.splat !== undefined ? `${info.splat}` : ' '),
        ),
    ),
    transports: [new winston.transports.Console()],
});

createForgeCommand({
    onLog: (level, message) => {
        logger[level](message);
    },
}).parse(process.argv);
