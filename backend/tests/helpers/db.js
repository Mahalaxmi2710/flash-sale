import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/shared/db.js';
import { runMigrations } from '../../src/scripts/migrate.js';

/** Connects to the Compose PostgreSQL (published on localhost) and makes sure the schema exists. */
export async function connectTestDb() {
  const pool = createPool({ max: 20 });
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end().catch(() => {});
    throw new Error(
      'Cannot reach PostgreSQL. Start it first with "npm run up" (or "docker compose up -d postgres"). ' +
        'The tests read POSTGRES_PORT/POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB from your .env.',
    );
  }
  await runMigrations(pool); // no-op when already applied
  return pool;
}

/** Each test sale uses its own product id, so tests never touch the demo sale (phone-x). */
export const newTestProductId = () => `test-${randomUUID().slice(0, 8)}`;

export async function seedInventory(pool, productId, stock) {
  await pool.query(
    `INSERT INTO inventory (product_id, name, price_cents, initial_stock, stock, sale_starts_at)
     VALUES ($1, 'Test phone', 100, $2, $2, now() - interval '1 minute')
     ON CONFLICT (product_id) DO UPDATE SET initial_stock = $2, stock = $2`,
    [productId, stock],
  );
}

export async function cleanupInventory(pool, productId) {
  await pool.query('DELETE FROM orders WHERE product_id = $1', [productId]);
  await pool.query('DELETE FROM inventory WHERE product_id = $1', [productId]);
}

export async function dbStock(pool, productId) {
  const { rows } = await pool.query('SELECT stock FROM inventory WHERE product_id = $1', [productId]);
  return rows[0].stock;
}

/** { CONFIRMED: n, SOLD_OUT: n, FAILED: n } (only statuses that exist). */
export async function orderCounts(pool, productId) {
  const { rows } = await pool.query(
    'SELECT status, count(*)::int AS n FROM orders WHERE product_id = $1 GROUP BY status',
    [productId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export async function orderRows(pool, productId) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE product_id = $1', [productId]);
  return rows;
}
