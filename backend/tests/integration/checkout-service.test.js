import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCheckoutStatus } from '../../src/api/services/statusService.js';
import { submitCheckout } from '../../src/api/services/checkoutService.js';
import { AppError } from '../../src/shared/errors.js';
import { getTracking, markQueued } from '../../src/shared/reservation.js';
import { processJob } from '../../src/worker/processor.js';
import { mapLimit } from '../helpers/async.js';
import {
  cleanupInventory,
  connectTestDb,
  dbStock,
  newTestProductId,
  orderCounts,
  seedInventory,
} from '../helpers/db.js';
import { fakePublisher, silentLog } from '../helpers/fakes.js';
import { cleanupSale, connectTestRedis, seedSale, stockOf } from '../helpers/redis.js';
import { keys } from '../../src/shared/keys.js';

// These tests drive the checkout and status logic directly (no HTTP). The HTTP layer is covered in checkout-api.test.js.
// Each test file uses its own product id so files can run in parallel without touching each other or the demo sale.
const productId = newTestProductId();
const k = keys(productId);
let redis;
let pool;
let publisher;

const submit = (userId = randomUUID(), idemKey = randomUUID(), overrides = {}) =>
  submitCheckout({ redis, publisher, userId, idemKey, productId, log: silentLog, ...overrides });
const rejection = async (promise) => promise.then(() => null, (err) => err);

beforeAll(async () => {
  redis = await connectTestRedis();
  pool = await connectTestDb();
});
afterAll(async () => {
  await cleanupSale(redis, productId);
  await cleanupInventory(pool, productId);
  await redis.quit();
  await pool.end();
});
beforeEach(async () => {
  publisher = fakePublisher();
  await cleanupInventory(pool, productId);
  await seedInventory(pool, productId, 3);
  await seedSale(redis, productId, { stock: 3 });
});

describe('submitCheckout', () => {
  it('reserves, publishes a job, marks QUEUED and answers 202 with a Location', async () => {
    const userId = randomUUID();
    const out = await submit(userId);
    expect(out.status).toBe(202);
    expect(out.body.state).toBe('QUEUED');
    expect(out.headers.Location).toBe(`/api/checkout/${out.body.trackingId}`);
    expect(publisher.jobs).toHaveLength(1);
    expect(publisher.jobs[0]).toMatchObject({ trackingId: out.body.trackingId, userId, productId });
    expect(await stockOf(redis, k)).toBe(2);
    expect((await getTracking(redis, { productId, trackingId: out.body.trackingId })).state).toBe('QUEUED');
  });

  it('a repeated key returns the same tracking id, publishes nothing new and reserves nothing new', async () => {
    const userId = randomUUID();
    const idemKey = randomUUID();
    const first = await submit(userId, idemKey);
    const second = await submit(userId, idemKey);
    expect(second.status).toBe(202);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.trackingId).toBe(first.body.trackingId);
    expect(publisher.jobs).toHaveLength(1);
    expect(await stockOf(redis, k)).toBe(2);
  });

  it('20 concurrent requests with one key consume a single unit and all point at one tracking id', async () => {
    const userId = randomUUID();
    const idemKey = randomUUID();
    const outs = await Promise.all(Array.from({ length: 20 }, () => submit(userId, idemKey)));
    expect(outs.every((o) => o.status === 202)).toBe(true);
    expect(new Set(outs.map((o) => o.body.trackingId)).size).toBe(1);
    expect(new Set(publisher.jobs.map((j) => j.trackingId)).size).toBe(1); // extra publishes are harmless duplicates
    expect(await stockOf(redis, k)).toBe(2);
  });

  it('broker unavailable: 503, the reservation is cancelled, and the same key works once the broker is back', async () => {
    const userId = randomUUID();
    const idemKey = randomUUID();
    publisher.failNext(1);

    const err = await rejection(submit(userId, idemKey));
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('QUEUE_UNAVAILABLE');
    expect(err.headers['Retry-After']).toBe('2');
    expect(publisher.jobs).toHaveLength(0);
    expect(await stockOf(redis, k)).toBe(3); // unit returned: nothing was accepted
    expect(await redis.exists(k.user(userId))).toBe(0);

    const retry = await submit(userId, idemKey);
    expect(retry.status).toBe(202);
    expect(await stockOf(redis, k)).toBe(2);
  });

  it('if the attempt moved on while our publish failed, it is reported instead of cancelled', async () => {
    const userId = randomUUID();
    const idemKey = randomUUID();
    // Another request for the same key queues it while this one's publish is failing.
    publisher.publishJob = async (job) => {
      await markQueued(redis, { productId, trackingId: job.trackingId });
      throw new Error('confirm lost');
    };
    const out = await submit(userId, idemKey);
    expect(out.status).toBe(202);
    expect(out.body.state).toBe('QUEUED');
    expect(await stockOf(redis, k)).toBe(2); // the unit is kept
  });

  it('publish confirmed but Redis cannot record QUEUED: 503 (never a silent 202), and a retry completes it', async () => {
    const userId = randomUUID();
    const idemKey = randomUUID();
    let failures = 1;
    const flakyRedis = {
      fsReserve: (...a) => redis.fsReserve(...a),
      fsCancel: (...a) => redis.fsCancel(...a),
      fsMarkQueued: (...a) => (failures-- > 0 ? Promise.reject(new Error('redis blip')) : redis.fsMarkQueued(...a)),
    };

    const err = await rejection(submit(userId, idemKey, { redis: flakyRedis }));
    expect(err.code).toBe('QUEUE_UNAVAILABLE');
    expect(publisher.jobs).toHaveLength(1); // the message is durable...
    expect(await stockOf(redis, k)).toBe(2); // ...and the unit is still held, to be completed by the retry

    const retry = await submit(userId, idemKey, { redis: flakyRedis });
    expect(retry.status).toBe(202);
    expect(publisher.jobs).toHaveLength(2); // republished; the worker de-duplicates by tracking id
    expect(new Set(publisher.jobs.map((j) => j.trackingId)).size).toBe(1);
    expect(await stockOf(redis, k)).toBe(2);
  });

  it('Redis unavailable at admission: fails closed with a retryable 503', async () => {
    const brokenRedis = { fsReserve: () => Promise.reject(new Error('ECONNREFUSED')) };
    const err = await rejection(submit(randomUUID(), randomUUID(), { redis: brokenRedis }));
    expect(err.status).toBe(503);
    expect(err.code).toBe('ADMISSION_UNAVAILABLE');
    expect(publisher.jobs).toHaveLength(0);
  });

  it('sold out, already purchased and not started are 409s that publish nothing', async () => {
    await seedSale(redis, productId, { stock: 0 });
    expect((await rejection(submit())).code).toBe('SOLD_OUT');

    await seedSale(redis, productId, { stock: 3, startsInMs: 60_000 });
    expect((await rejection(submit())).code).toBe('SALE_NOT_STARTED');

    await seedSale(redis, productId, { stock: 3 });
    const userId = randomUUID();
    await submit(userId);
    const err = await rejection(submit(userId));
    expect(err.code).toBe('ALREADY_PURCHASED');
    expect(err.details.trackingId).toMatch(/^trk_/);
    expect(publisher.jobs).toHaveLength(1);
  });

  it('end to end: 120 buyers for 50 units never accept more than 50, and the database ends at exactly 0', async () => {
    await seedInventory(pool, productId, 50);
    await seedSale(redis, productId, { stock: 50 });

    const results = await Promise.all(
      Array.from({ length: 120 }, async () => {
        const userId = randomUUID();
        const err = await rejection(submit(userId));
        return err ? err.code : 'ACCEPTED';
      }),
    );
    expect(results.filter((r) => r === 'ACCEPTED')).toHaveLength(50);
    expect(results.filter((r) => r === 'SOLD_OUT')).toHaveLength(70);
    expect(publisher.jobs).toHaveLength(50);

    await mapLimit(publisher.jobs, 20, (job) => processJob({ pool, redis }, job));
    expect(await orderCounts(pool, productId)).toEqual({ CONFIRMED: 50 });
    expect(await dbStock(pool, productId)).toBe(0);
  });
});

describe('getCheckoutStatus', () => {
  const status = (userId, trackingId) => getCheckoutStatus({ redis, pool, userId, trackingId, productId, log: silentLog });

  it('follows the lifecycle: QUEUED, then CONFIRMED with an order reference', async () => {
    const userId = randomUUID();
    const { body } = await submit(userId);
    expect(await status(userId, body.trackingId)).toEqual({ trackingId: body.trackingId, state: 'QUEUED' });

    await processJob({ pool, redis }, publisher.jobs[0]);
    const done = await status(userId, body.trackingId);
    expect(done.state).toBe('CONFIRMED');
    expect(done.orderRef).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports SOLD_OUT when the database ran out although Redis admitted the user', async () => {
    await seedInventory(pool, productId, 0);
    const userId = randomUUID();
    const { body } = await submit(userId);
    await processJob({ pool, redis }, publisher.jobs[0]);
    expect((await status(userId, body.trackingId)).state).toBe('SOLD_OUT');
  });

  it('an unknown reference and someone else\'s reference are both 404', async () => {
    const owner = randomUUID();
    const { body } = await submit(owner);
    const unknown = await rejection(status(owner, `trk_${'0'.repeat(32)}`));
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe('TRACKING_NOT_FOUND');
    const stranger = await rejection(status(randomUUID(), body.trackingId));
    expect(stranger.status).toBe(404);
  });

  it('falls back to PostgreSQL when Redis has no record, and says 503 (not 404) when it cannot look anywhere', async () => {
    const userId = randomUUID();
    const { body } = await submit(userId);
    await processJob({ pool, redis }, publisher.jobs[0]);
    await redis.del(k.tracking(body.trackingId)); // Redis lost the record

    expect((await status(userId, body.trackingId)).state).toBe('CONFIRMED');

    const brokenRedis = { hgetall: () => Promise.reject(new Error('down')) };
    const viaDb = await getCheckoutStatus({ redis: brokenRedis, pool, userId, trackingId: body.trackingId, productId, log: silentLog });
    expect(viaDb.state).toBe('CONFIRMED');

    const err = await rejection(
      getCheckoutStatus({ redis: brokenRedis, pool, userId, trackingId: `trk_${'1'.repeat(32)}`, productId, log: silentLog }),
    );
    expect(err.status).toBe(503);
    expect(err.code).toBe('STATUS_UNAVAILABLE');
  });

  it('503 when PostgreSQL fails and Redis has nothing', async () => {
    const brokenPool = { query: () => Promise.reject(new Error('db down')) };
    const err = await rejection(
      getCheckoutStatus({ redis, pool: brokenPool, userId: randomUUID(), trackingId: `trk_${'2'.repeat(32)}`, productId, log: silentLog }),
    );
    expect(err.status).toBe(503);
  });
});
