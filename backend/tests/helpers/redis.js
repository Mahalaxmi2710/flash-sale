import { randomUUID } from 'node:crypto';
import { keys } from '../../src/shared/keys.js';
import { createRedis } from '../../src/shared/redis.js';

export async function connectTestRedis() {
  const redis = createRedis('test');
  try {
    await redis.ping();
  } catch {
    const { host, port } = redis.options;
    redis.disconnect();
    throw new Error(
      `Cannot reach Redis at ${host}:${port}. Start it first with "docker compose up -d redis" ` +
        '(or "npm run up"), and set REDIS_PORT if you changed it in .env.',
    );
  }
  return redis;
}

export const newProductId = () => `test-${randomUUID().slice(0, 8)}`;

export async function cleanupSale(redis, productId) {
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `fs:${productId}:*`, 'COUNT', 500);
    cursor = next;
    if (batch.length) await redis.unlink(...batch);
  } while (cursor !== '0');
}

/** startsInMs < 0 means the sale started that long ago. Uses the Redis clock, like the Lua script. */
export async function seedSale(redis, productId, { stock = 500, startsInMs = -1000 } = {}) {
  const k = keys(productId);
  await cleanupSale(redis, productId);
  const [s, us] = await redis.time();
  const nowMs = Number(s) * 1000 + Math.floor(Number(us) / 1000);
  await redis
    .multi()
    .set(k.stock, String(stock))
    .hset(k.sale, 'startsAt', String(nowMs + startsInMs))
    .exec();
  return k;
}

export const stockOf = async (redis, k) => Number(await redis.get(k.stock));