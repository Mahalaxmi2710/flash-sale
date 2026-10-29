import { pathToFileURL } from 'node:url';
import { config } from '../shared/config.js';
import { createPool } from '../shared/db.js';
import { keys } from '../shared/keys.js';
import { logger } from '../shared/logger.js';
import { createRedis } from '../shared/redis.js';

export function parseArgs(argv) {
  const out = { ifMissing: false, startIn: null };
  for (const arg of argv) {
    if (arg === '--if-missing') {
      out.ifMissing = true;
    } else if (arg.startsWith('--start-in=')) {
      const seconds = Number(arg.split('=')[1]);
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`Invalid value: ${arg}`);
      out.startIn = seconds;
    } else {
      throw new Error(`Unknown argument: ${arg} (supported: --if-missing, --start-in=<seconds>)`);
    }
  }
  return out;
}

async function redisNowMs(redis) {
  const [s, us] = await redis.time();
  return Number(s) * 1000 + Math.floor(Number(us) / 1000);
}

async function clearRedisKeys(redis, productId) {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `fs:${productId}:*`, 'COUNT', 500);
    cursor = next;
    if (batch.length) {
      await redis.unlink(...batch);
      removed += batch.length;
    }
  } while (cursor !== '0');
  return removed;
}

async function seedRedis(redis, k, stock, startsAtMs) {
  await redis
    .multi()
    .set(k.stock, String(stock))
    .hset(k.sale, 'startsAt', String(startsAtMs))
    .exec();
}

/**
 * Default (no flags): destructive reset of PostgreSQL orders/stock and all Redis state for the product.
 * --if-missing: never destroys anything. Does nothing if the sale exists, rebuilds Redis from
 *               PostgreSQL if only Redis state is missing, seeds both if neither exists.
 * --start-in=N: sale starts N seconds from now (default: SALE_START_AT or SALE_START_DELAY_SECONDS).
 */
export async function resetSale({ pool, redis, args }) {
  const productId = config.productId;
  const k = keys(productId);

  const { rows: existing } = await pool.query(
    'SELECT stock, sale_starts_at FROM inventory WHERE product_id = $1',
    [productId],
  );

  if (args.ifMissing && existing.length > 0) {
    const redisReady = (await redis.exists(k.stock, k.sale)) === 2;
    if (redisReady) {
      logger.info({ productId }, 'sale already initialised; nothing to do');
      return 'unchanged';
    }
    const row = existing[0];
    await seedRedis(redis, k, row.stock, new Date(row.sale_starts_at).getTime());
    logger.warn({ productId, stock: row.stock }, 'redis state was missing; rebuilt from postgres');
    return 'redis-rebuilt';
  }

  const nowMs = await redisNowMs(redis);
  let startsAtMs;
  if (args.startIn !== null) startsAtMs = nowMs + args.startIn * 1000;
  else if (config.saleStartAt) startsAtMs = Date.parse(config.saleStartAt);
  else startsAtMs = nowMs + config.saleStartDelaySeconds * 1000;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM orders WHERE product_id = $1', [productId]);
    await client.query(
      `INSERT INTO inventory (product_id, name, price_cents, initial_stock, stock, sale_starts_at)
       VALUES ($1, $2, $3, $4, $4, $5)
       ON CONFLICT (product_id) DO UPDATE SET
         name = EXCLUDED.name,
         price_cents = EXCLUDED.price_cents,
         initial_stock = EXCLUDED.initial_stock,
         stock = EXCLUDED.initial_stock,
         sale_starts_at = EXCLUDED.sale_starts_at,
         updated_at = now()`,
      [productId, config.productName, config.productPriceCents, config.saleStock, new Date(startsAtMs)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const cleared = await clearRedisKeys(redis, productId);
  await seedRedis(redis, k, config.saleStock, startsAtMs);
  logger.info(
    {
      productId,
      stock: config.saleStock,
      startsAt: new Date(startsAtMs).toISOString(),
      clearedRedisKeys: cleared,
    },
    'sale reset',
  );
  return 'reset';
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool({ max: 2 });
  const redis = createRedis('reset-sale');
  try {
    await resetSale({ pool, redis, args: parseArgs(process.argv.slice(2)) });
  } catch (err) {
    logger.error({ err }, 'reset failed');
    process.exitCode = 1;
  } finally {
    await pool.end();
    await redis.quit().catch(() => redis.disconnect());
  }
}