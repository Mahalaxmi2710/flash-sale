import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool } from '../shared/db.js';
import { logger } from '../shared/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCK_ID = 727001; // arbitrary constant: serialises concurrent migration runs

function migrationsDir() {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(here, '../../db/migrations'), // inside the Docker image: /app/db/migrations
    path.resolve(here, '../../../db/migrations'), // in the repo: <root>/db/migrations
  ].filter(Boolean);
  const found = candidates.find((dir) => fs.existsSync(dir));
  if (!found) throw new Error(`Migrations directory not found. Tried: ${candidates.join(', ')}`);
  return found;
}

export async function runMigrations(pool) {
  const dir = migrationsDir();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        count += 1;
        logger.info({ file }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    logger.info({ applied: count, total: files.length }, 'migrations complete');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool({ max: 2 });
  try {
    await runMigrations(pool);
  } catch (err) {
    logger.error({ err }, 'migration run failed');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}