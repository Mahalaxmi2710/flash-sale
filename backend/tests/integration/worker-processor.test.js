import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentJobError } from '../../src/shared/jobs.js';
import { getTracking, markQueued, reserve } from '../../src/shared/reservation.js';
import { decideOrder, failExhausted, processJob } from '../../src/worker/processor.js';
import { mapLimit } from '../helpers/async.js';
import {
  cleanupInventory,
  connectTestDb,
  dbStock,
  newTestProductId,
  orderCounts,
  orderRows,
  seedInventory,
} from '../helpers/db.js';
import { makeTestJob } from '../helpers/fakes.js';
import { cleanupSale, connectTestRedis, seedSale, stockOf } from '../helpers/redis.js';

let pool;
let redis;
const productIds = [];

/** A sale with `dbStock` units in PostgreSQL and `redisStock` admission tokens in Redis. */
async function newSale({ dbStock: dbUnits, redisStock = dbUnits }) {
  const productId = newTestProductId();
  productIds.push(productId);
  await seedInventory(pool, productId, dbUnits);
  const k = await seedSale(redis, productId, { stock: redisStock });
  return { productId, k };
}

/** What the API does: reserve in Redis, then mark QUEUED. Returns the job the worker would receive. */
async function admit(productId, userId = randomUUID()) {
  const job = makeTestJob({ productId, userId });
  const r = await reserve(redis, { productId, userId, idemKey: job.idempotencyKey });
  expect(r.code).toBe('RESERVED');
  expect(r.trackingId).toBe(job.trackingId);
  await markQueued(redis, { productId, trackingId: job.trackingId });
  return job;
}

const stateOf = async (productId, trackingId) => (await getTracking(redis, { productId, trackingId }))?.state;

beforeAll(async () => {
  redis = await connectTestRedis();
  pool = await connectTestDb();
});
afterAll(async () => {
  for (const id of productIds) {
    await cleanupSale(redis, id);
    await cleanupInventory(pool, id);
  }
  await redis.quit();
  await pool.end();
});

describe('processJob: the database decides', () => {
  it('confirms an order: one stock unit, one order row, Redis mirrors it', async () => {
    const { productId, k } = await newSale({ dbStock: 5 });
    const job = await admit(productId);

    const out = await processJob({ pool, redis }, job);
    expect(out.result).toBe('PROCESSED');
    expect(out.status).toBe('CONFIRMED');
    expect(await dbStock(pool, productId)).toBe(4);
    expect(await orderCounts(pool, productId)).toEqual({ CONFIRMED: 1 });
    expect(await stateOf(productId, job.trackingId)).toBe('CONFIRMED');
    expect(await stockOf(redis, k)).toBe(4); // the Redis unit stays consumed; it is not decremented twice
  });

  it('sold out in the database: SOLD_OUT order, stock stays at zero, user is freed in Redis', async () => {
    const { productId, k } = await newSale({ dbStock: 0, redisStock: 3 }); // Redis over-admitted on purpose
    const job = await admit(productId);

    const out = await processJob({ pool, redis }, job);
    expect(out.status).toBe('SOLD_OUT');
    expect(await dbStock(pool, productId)).toBe(0);
    expect(await orderCounts(pool, productId)).toEqual({ SOLD_OUT: 1 });
    expect(await stateOf(productId, job.trackingId)).toBe('SOLD_OUT');
    expect(await stockOf(redis, k)).toBe(0);
    expect(await redis.get(`fs:${productId}:user:${job.userId}`)).toBeNull();
  });

  it('never confirms more than the stock even if Redis admitted more (and stock never goes negative)', async () => {
    const { productId } = await newSale({ dbStock: 5, redisStock: 20 });
    const jobs = [];
    for (let i = 0; i < 20; i += 1) jobs.push(await admit(productId));

    await mapLimit(jobs, 10, (job) => processJob({ pool, redis }, job));

    expect(await orderCounts(pool, productId)).toEqual({ CONFIRMED: 5, SOLD_OUT: 15 });
    expect(await dbStock(pool, productId)).toBe(0);
  });

  it('500 units, 700 buyers through the real Redis gate: exactly 500 confirmed, stock exactly 0', async () => {
    const { productId, k } = await newSale({ dbStock: 500 });
    const attempts = await Promise.all(
      Array.from({ length: 700 }, async () => {
        const job = makeTestJob({ productId });
        const r = await reserve(redis, { productId, userId: job.userId, idemKey: job.idempotencyKey });
        if (r.code === 'RESERVED') await markQueued(redis, { productId, trackingId: job.trackingId });
        return { job, code: r.code };
      }),
    );
    const admitted = attempts.filter((a) => a.code === 'RESERVED');
    expect(admitted).toHaveLength(500);
    expect(attempts.filter((a) => a.code === 'SOLD_OUT')).toHaveLength(200);

    await mapLimit(admitted, 20, (a) => processJob({ pool, redis }, a.job));

    expect(await orderCounts(pool, productId)).toEqual({ CONFIRMED: 500 });
    expect(await dbStock(pool, productId)).toBe(0);
    expect(await stockOf(redis, k)).toBe(0);
  });
});

describe('processJob: duplicates, redelivery and crashes', () => {
  it('the same message delivered 10 times at once decrements stock exactly once', async () => {
    const { productId } = await newSale({ dbStock: 5 });
    const job = await admit(productId);

    const outs = await Promise.all(Array.from({ length: 10 }, () => processJob({ pool, redis }, job)));

    expect(outs.filter((o) => o.result === 'PROCESSED')).toHaveLength(1);
    expect(await dbStock(pool, productId)).toBe(4);
    expect(await orderCounts(pool, productId)).toEqual({ CONFIRMED: 1 });
    expect(await stateOf(productId, job.trackingId)).toBe('CONFIRMED');
  });

  it('redelivery after the commit (crash before the ack) changes nothing', async () => {
    const { productId } = await newSale({ dbStock: 5 });
    const job = await admit(productId);
    await processJob({ pool, redis }, job);

    const again = await processJob({ pool, redis }, job);
    expect(again.result).toBe('DUPLICATE');
    expect(again.status).toBe('CONFIRMED');
    expect(await dbStock(pool, productId)).toBe(4);
    expect(await orderRows(pool, productId)).toHaveLength(1);
  });

  it('crash after the database commit but before Redis is updated: the retry finishes the job, no second decrement', async () => {
    const { productId } = await newSale({ dbStock: 5 });
    const job = await admit(productId);

    let failures = 1;
    const flakyRedis = {
      fsBegin: (...a) => redis.fsBegin(...a),
      fsRelease: (...a) => redis.fsRelease(...a),
      fsFinalize: (...a) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('redis connection lost'));
        }
        return redis.fsFinalize(...a);
      },
    };

    await expect(processJob({ pool, redis: flakyRedis }, job)).rejects.toThrow('redis connection lost');
    // The database decision is already durable; Redis still says PROCESSING.
    expect(await dbStock(pool, productId)).toBe(4);
    expect(await stateOf(productId, job.trackingId)).toBe('PROCESSING');

    // RabbitMQ redelivers (worker restarted / retry): the order is found and Redis is brought up to date.
    const retry = await processJob({ pool, redis: flakyRedis }, job);
    expect(retry.result).toBe('DUPLICATE');
    expect(await dbStock(pool, productId)).toBe(4);
    expect(await orderCounts(pool, productId)).toEqual({ CONFIRMED: 1 });
    expect(await stateOf(productId, job.trackingId)).toBe('CONFIRMED');
  });

  it('crash after Redis said PROCESSING but before any database work: the retry processes normally', async () => {
    const { productId } = await newSale({ dbStock: 5 });
    const job = await admit(productId);
    await redis.fsBegin(`fs:${productId}:trk:${job.trackingId}`, `fs:${productId}:reservations`, job.trackingId);

    const out = await processJob({ pool, redis }, job);
    expect(out.result).toBe('PROCESSED');
    expect(await dbStock(pool, productId)).toBe(4);
  });

  it('drops a stale job whose reservation was cancelled: no order, no stock change', async () => {
    const { productId } = await newSale({ dbStock: 5 });
    const job = makeTestJob({ productId }); // never reserved in Redis

    const out = await processJob({ pool, redis }, job);
    expect(out.result).toBe('STALE');
    expect(await dbStock(pool, productId)).toBe(5);
    expect(await orderRows(pool, productId)).toHaveLength(0);
  });
});

describe('PostgreSQL transaction behaviour', () => {
  it('rolls back the stock decrement when the order insert fails, and a retry then succeeds once', async () => {
    const { productId } = await newSale({ dbStock: 5 });
    const job = await admit(productId);

    // A pool whose connections fail on the order INSERT (after the stock UPDATE already ran in the transaction).
    const failingPool = {
      query: (...a) => pool.query(...a),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql, params) =>
            /INSERT INTO orders/.test(sql) ? Promise.reject(new Error('disk full')) : client.query(sql, params),
          release: () => client.release(),
        };
      },
    };

    await expect(processJob({ pool: failingPool, redis }, job)).rejects.toThrow('disk full');
    expect(await dbStock(pool, productId)).toBe(5); // the decrement was rolled back
    expect(await orderRows(pool, productId)).toHaveLength(0);

    const retry = await processJob({ pool, redis }, job);
    expect(retry.status).toBe('CONFIRMED');
    expect(await dbStock(pool, productId)).toBe(4);
  });

  it('a second purchase by the same user fails cleanly: stock rolled back to the savepoint, FAILED order recorded', async () => {
    const { productId, k } = await newSale({ dbStock: 5 });
    const userId = randomUUID();
    const first = await admit(productId, userId);
    await processJob({ pool, redis }, first);
    expect(await dbStock(pool, productId)).toBe(4);

    // Simulate Redis having lost its per-user guard, so the second attempt gets past admission.
    await redis.del(k.user(userId));
    const second = await admit(productId, userId);
    const out = await processJob({ pool, redis }, second);

    expect(out.status).toBe('FAILED');
    expect(await dbStock(pool, productId)).toBe(4); // not decremented a second time
    const counts = await orderCounts(pool, productId);
    expect(counts).toEqual({ CONFIRMED: 1, FAILED: 1 });
    expect(await stateOf(productId, second.trackingId)).toBe('FAILED');
    expect(await stockOf(redis, k)).toBe(4); // the second reservation's unit went back to Redis
  });

  it('an unknown product is a permanent error (retrying cannot help)', async () => {
    const productId = newTestProductId();
    productIds.push(productId);
    await seedSale(redis, productId, { stock: 1 }); // Redis knows it, PostgreSQL does not
    const job = await admit(productId);
    await expect(decideOrder(pool, job)).rejects.toThrow(PermanentJobError);
  });

  it('the schema itself refuses negative stock, even for a buggy unconditional UPDATE', async () => {
    const { productId } = await newSale({ dbStock: 0 });
    await expect(pool.query('UPDATE inventory SET stock = stock - 1 WHERE product_id = $1', [productId])).rejects.toThrow(
      /inventory_stock_range/,
    );
  });
});

describe('failExhausted (last step before the dead-letter queue)', () => {
  it('records FAILED, returns the Redis unit once, and is safe to repeat', async () => {
    const { productId, k } = await newSale({ dbStock: 5 });
    const job = await admit(productId);
    expect(await stockOf(redis, k)).toBe(4);

    await failExhausted({ pool, redis }, job, 'gave up');
    await failExhausted({ pool, redis }, job, 'gave up');

    expect(await orderCounts(pool, productId)).toEqual({ FAILED: 1 });
    expect(await stateOf(productId, job.trackingId)).toBe('FAILED');
    expect(await stockOf(redis, k)).toBe(5);
    expect(await dbStock(pool, productId)).toBe(5);
  });

  it('never turns an already confirmed order into a failure', async () => {
    const { productId, k } = await newSale({ dbStock: 5 });
    const job = await admit(productId);
    await processJob({ pool, redis }, job);

    await failExhausted({ pool, redis }, job, 'late failure');

    expect(await orderCounts(pool, productId)).toEqual({ CONFIRMED: 1 });
    expect(await stateOf(productId, job.trackingId)).toBe('CONFIRMED');
    expect(await stockOf(redis, k)).toBe(4);
  });
});
