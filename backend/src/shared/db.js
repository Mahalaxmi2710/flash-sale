import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

export function createPool(overrides = {}) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    ...overrides,
  });
  // An error on an idle client must not crash the process.
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
  return pool;
}