/**
 * Shared Logger Configuration
 *
 * Creates module-specific loggers using pino.
 *
 * Usage:
 *   import { createModuleLogger } from '../lib/logger.js';
 *   const log = createModuleLogger('my-module');
 *   log.info('Hello');
 */

import pino from 'pino';

const baseLogger = pino({
  level: process.env.LOG_LEVEL?.toLowerCase() || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
    : undefined,
});

/**
 * Create a child logger for a specific module.
 *
 * @param module - Module name (appears in log output)
 * @returns Pino logger instance
 */
export function createModuleLogger(module: string) {
  return baseLogger.child({ module });
}

export default baseLogger;
