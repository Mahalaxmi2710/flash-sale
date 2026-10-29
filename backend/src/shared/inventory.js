import { keys } from './keys.js';

const IN_FLIGHT = new Set(['RESERVED', 'QUEUED', 'PROCESSING']);

/**
 * Compare PostgreSQL (the authority) with Redis (the admission gate) for one product.
 *   problems  = invariants that must never be false (overselling, negative stock, lost units)
 *   warnings  = Redis drift, which is safe (PostgreSQL still decides) but worth fixing
 * Read-only.
 */
export async function inventorySnapshot({ pool, redis, productId }) {
  const inv = (
    await pool.query('SELECT initial_stock, stock FROM inventory WHERE product_id = $1', [productId])
  ).rows[0];
  if (!inv) throw new Error(`No inventory row for product "${productId}"`);

  const { rows } = await pool.query(
    'SELECT status, count(*)::int AS n FROM orders WHERE product_id = $1 GROUP BY status',
    [productId],
  );
  const orders = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const confirmed = orders.CONFIRMED ?? 0;

  const k = keys(productId);
  const redisStockRaw = await redis.get(k.stock);
  const redisStock = redisStockRaw == null ? null : Number(redisStockRaw);

  const redisStates = {};
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', k.tracking('*'), 'COUNT', 1000);
    cursor = next;
    for (const key of batch) {
      const state = (await redis.hget(key, 'state')) ?? 'GONE';
      redisStates[state] = (redisStates[state] ?? 0) + 1;
    }
  } while (cursor !== '0');
  const inFlight = Object.entries(redisStates)
    .filter(([state]) => IN_FLIGHT.has(state))
    .reduce((sum, [, n]) => sum + n, 0);

  const problems = [];
  const warnings = [];
  if (inv.stock < 0) problems.push(`database stock is negative (${inv.stock})`);
  if (confirmed > inv.initial_stock) {
    problems.push(`OVERSOLD: ${confirmed} confirmed orders for ${inv.initial_stock} units`);
  }
  if (inv.stock + confirmed !== inv.initial_stock) {
    problems.push(
      `stock (${inv.stock}) + confirmed (${confirmed}) != initial stock (${inv.initial_stock}): ` +
        'a unit was decremented without an order, or an order exists without a decrement',
    );
  }

  const expectedRedis = Math.max(0, inv.stock - inFlight);
  if (redisStock == null) warnings.push('redis stock counter is missing');
  else if (redisStock !== expectedRedis) {
    warnings.push(`redis stock counter is ${redisStock}, expected ${expectedRedis} (database ${inv.stock} - in flight ${inFlight})`);
  }

  return {
    productId,
    database: { initialStock: inv.initial_stock, stock: inv.stock, orders },
    redis: { stock: redisStock, states: redisStates, inFlight, expectedStock: expectedRedis },
    problems,
    warnings,
    ok: problems.length === 0,
    inSync: problems.length === 0 && warnings.length === 0,
  };
}

/** Rebuild the Redis admission counter from PostgreSQL. Only safe when nothing is in flight. */
export async function repairRedisStock({ redis, productId, snapshot }) {
  if (snapshot.redis.inFlight > 0) {
    throw new Error(`${snapshot.redis.inFlight} attempts are still in flight; wait for the worker to drain the queue`);
  }
  await redis.set(keys(productId).stock, String(snapshot.redis.expectedStock));
  return snapshot.redis.expectedStock;
}
