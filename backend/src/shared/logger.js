import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { service: config.serviceName },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'headers.cookie'],
    censor: '[redacted]',
  },
});