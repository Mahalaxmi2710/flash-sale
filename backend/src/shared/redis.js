import Redis from 'ioredis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';

const luaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lua');
const lua = (name) => fs.readFileSync(path.join(luaDir, name), 'utf8');

// Each script runs atomically inside Redis. ioredis uses EVALSHA and falls back to EVAL on NOSCRIPT.
const SCRIPTS = {
  fsReserve: { numberOfKeys: 5, lua: lua('reserve.lua') },
  fsMarkQueued: { numberOfKeys: 2, lua: lua('mark_queued.lua') },
  fsRelease: { numberOfKeys: 4, lua: lua('release.lua') },
  // Batch 2
  fsBegin: { numberOfKeys: 2, lua: lua('begin_processing.lua') },
  fsFinalize: { numberOfKeys: 4, lua: lua('finalize.lua') },
  fsCancel: { numberOfKeys: 4, lua: lua('cancel_reserved.lua') },
};

export function createRedis(name = config.serviceName) {
  const client = new Redis(config.redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: 2,
    commandTimeout: 2000, // fail fast: if Redis is down we refuse admission (fail closed)
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });
  client.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
  client.on('ready', () => logger.info('redis ready'));
  for (const [command, definition] of Object.entries(SCRIPTS)) {
    client.defineCommand(command, definition);
  }
  return client;
}