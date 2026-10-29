import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginProcessing, getTracking, markQueued, reserve } from '../../src/shared/reservation.js';
import { expireStaleReservations } from '../../src/worker/reconciler.js';
import { cleanupSale, connectTestRedis, newProductId, seedSale, stockOf } from '../helpers/redis.js';

let redis;
const productIds = [];
async function newSale(stock = 5) {
  const productId = newProductId();
  productIds.push(productId);
  const k = await seedSale(redis, productId, { stock });
  return { productId, k };
}
const expireNow = (productId, k, trackingId) => redis.zadd(k.reservations, 1, trackingId); // deadline in the past

beforeAll(async () => {
  redis = await connectTestRedis();
});
afterAll(async () => {
  for (const id of productIds) await cleanupSale(redis, id);
  await redis.quit();
});

describe('expireStaleReservations', () => {
  it('returns the unit of a RESERVED attempt whose deadline passed, and lets the same key retry', async () => {
    const { productId, k } = await newSale();
    const idemKey = randomUUID();
    const r = await reserve(redis, { productId, userId: 'u1', idemKey });
    await expireNow(productId, k, r.trackingId);
    expect(await stockOf(redis, k)).toBe(4);

    expect(await expireStaleReservations(redis, { productId })).toBe(1);
    expect(await stockOf(redis, k)).toBe(5);
    expect(await getTracking(redis, { productId, trackingId: r.trackingId })).toBeNull();
    expect(await redis.zcard(k.reservations)).toBe(0);

    expect((await reserve(redis, { productId, userId: 'u1', idemKey })).code).toBe('RESERVED');
  });

  it('leaves reservations that have not expired yet', async () => {
    const { productId, k } = await newSale();
    await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    expect(await expireStaleReservations(redis, { productId })).toBe(0);
    expect(await stockOf(redis, k)).toBe(4);
  });

  it('never touches an attempt that is QUEUED or PROCESSING, even with a stale index entry', async () => {
    const { productId, k } = await newSale();
    const queued = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    await markQueued(redis, { productId, trackingId: queued.trackingId });
    const processing = await reserve(redis, { productId, userId: 'u2', idemKey: randomUUID() });
    await beginProcessing(redis, { productId, trackingId: processing.trackingId });
    await expireNow(productId, k, queued.trackingId);
    await expireNow(productId, k, processing.trackingId);

    expect(await expireStaleReservations(redis, { productId })).toBe(0);
    expect(await stockOf(redis, k)).toBe(3);
    expect((await getTracking(redis, { productId, trackingId: queued.trackingId })).state).toBe('QUEUED');
    expect((await getTracking(redis, { productId, trackingId: processing.trackingId })).state).toBe('PROCESSING');
  });

  it('removes orphan index entries and is safe to run on two workers at once', async () => {
    const { productId, k } = await newSale();
    await redis.zadd(k.reservations, 1, 'trk_orphan');
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    await expireNow(productId, k, r.trackingId);

    const counts = await Promise.all([
      expireStaleReservations(redis, { productId }),
      expireStaleReservations(redis, { productId }),
    ]);
    expect(counts[0] + counts[1]).toBe(1); // cancelled exactly once
    expect(await stockOf(redis, k)).toBe(5); // and the unit came back exactly once
    expect(await redis.zcard(k.reservations)).toBe(0);
  });
});
