import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginProcessing,
  cancelReserved,
  finalize,
  getTracking,
  markQueued,
  release,
  reserve,
} from '../../src/shared/reservation.js';
import {
  cleanupSale,
  connectTestRedis,
  newProductId,
  seedSale,
  stockOf,
} from '../helpers/redis.js';

let redis;
const productIds = [];

async function newSale(opts) {
  const productId = newProductId();
  productIds.push(productId);
  const k = await seedSale(redis, productId, opts);
  return { productId, k };
}

const count = (results, code) => results.filter((r) => r.code === code).length;

beforeAll(async () => {
  redis = await connectTestRedis();
});

afterAll(async () => {
  for (const id of productIds) await cleanupSale(redis, id);
  await redis.quit();
});

describe('atomic admission (Redis Lua)', () => {
  it('admits exactly the stock count under 1000 parallel requests from distinct users', async () => {
    const { productId, k } = await newSale({ stock: 500 });
    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        reserve(redis, { productId, userId: `user-${i}`, idemKey: randomUUID() }),
      ),
    );
    expect(count(results, 'RESERVED')).toBe(500);
    expect(count(results, 'SOLD_OUT')).toBe(500);
    expect(await stockOf(redis, k)).toBe(0); // never negative
    expect(await redis.zcard(k.reservations)).toBe(500);
    const ids = new Set(results.filter((r) => r.code === 'RESERVED').map((r) => r.trackingId));
    expect(ids.size).toBe(500);
  });

  it('never admits when stock is 0', async () => {
    const { productId, k } = await newSale({ stock: 0 });
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    expect(r.code).toBe('SOLD_OUT');
    expect(await stockOf(redis, k)).toBe(0);
  });

  it('rejects before the sale starts and consumes nothing', async () => {
    const { productId, k } = await newSale({ stock: 10, startsInMs: 60_000 });
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    expect(r.code).toBe('NOT_STARTED');
    expect(Number(r.detail)).toBeGreaterThan(0);
    expect(await stockOf(redis, k)).toBe(10);
    expect(await getTracking(redis, { productId, trackingId: r.trackingId })).toBeNull();
  });

  it('reports SALE_NOT_CONFIGURED when the sale hash is missing', async () => {
    const productId = newProductId();
    productIds.push(productId);
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    expect(r.code).toBe('SALE_NOT_CONFIGURED');
  });
});

describe('idempotency', () => {
  it('50 parallel requests with the same key consume exactly one unit', async () => {
    const { productId, k } = await newSale({ stock: 100 });
    const idemKey = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserve(redis, { productId, userId: 'alice', idemKey })),
    );
    expect(count(results, 'RESERVED')).toBe(1);
    expect(count(results, 'DUPLICATE')).toBe(49);
    expect(new Set(results.map((r) => r.trackingId)).size).toBe(1);
    expect(await stockOf(redis, k)).toBe(99);
    expect(results.filter((r) => r.code === 'DUPLICATE').every((r) => r.detail === 'RESERVED')).toBe(true);
  });

  it('a user using 10 different keys in parallel gets exactly one unit', async () => {
    const { productId, k } = await newSale({ stock: 100 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserve(redis, { productId, userId: 'bob', idemKey: randomUUID() })),
    );
    expect(count(results, 'RESERVED')).toBe(1);
    expect(count(results, 'ALREADY_PURCHASED')).toBe(9);
    expect(await stockOf(redis, k)).toBe(99);
  });

  it('different users may use the same idempotency key independently', async () => {
    const { productId, k } = await newSale({ stock: 10 });
    const idemKey = randomUUID();
    const a = await reserve(redis, { productId, userId: 'user-a', idemKey });
    const b = await reserve(redis, { productId, userId: 'user-b', idemKey });
    expect(a.code).toBe('RESERVED');
    expect(b.code).toBe('RESERVED');
    expect(a.trackingId).not.toBe(b.trackingId);
    expect(await stockOf(redis, k)).toBe(8);
  });
});

describe('reservation lifecycle', () => {
  it('records an expiry in the reservations index equal to the requested ttl', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID(), ttlMs: 7000 });
    const tracking = await getTracking(redis, { productId, trackingId: r.trackingId });
    const score = Number(await redis.zscore(k.reservations, r.trackingId));
    expect(score - Number(tracking.createdAt)).toBe(7000);
  });

  it('markQueued moves RESERVED to QUEUED, leaves the expiry index, and is idempotent', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    expect(await redis.zcard(k.reservations)).toBe(1);

    expect(await markQueued(redis, { productId, trackingId: r.trackingId })).toBe('QUEUED');
    expect(await redis.zcard(k.reservations)).toBe(0);
    expect(await markQueued(redis, { productId, trackingId: r.trackingId })).toBe('QUEUED');
    expect((await getTracking(redis, { productId, trackingId: r.trackingId })).state).toBe('QUEUED');
    expect(await markQueued(redis, { productId, trackingId: 'trk_missing' })).toBe('MISSING');
  });

  it('release restores stock exactly once, even under 5 parallel calls, and frees the user', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const idemKey = randomUUID();
    const first = await reserve(redis, { productId, userId: 'bob', idemKey });
    expect(await stockOf(redis, k)).toBe(4);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        release(redis, { productId, trackingId: first.trackingId, userId: 'bob', finalState: 'FAILED' }),
      ),
    );
    expect(outcomes.filter((o) => o === 'RELEASED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'NOOP')).toHaveLength(4);
    expect(await stockOf(redis, k)).toBe(5);
    expect(await redis.zcard(k.reservations)).toBe(0);
    expect((await getTracking(redis, { productId, trackingId: first.trackingId })).state).toBe('FAILED');

    // Same key now reports the recorded outcome and consumes nothing...
    const same = await reserve(redis, { productId, userId: 'bob', idemKey });
    expect(same.code).toBe('DUPLICATE');
    expect(same.detail).toBe('FAILED');
    expect(await stockOf(redis, k)).toBe(5);

    // ...while a fresh key can reserve again.
    const fresh = await reserve(redis, { productId, userId: 'bob', idemKey: randomUUID() });
    expect(fresh.code).toBe('RESERVED');
    expect(await stockOf(redis, k)).toBe(4);
  });

  it('release without a final state deletes the record so the same key can retry (publish-failure path)', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const idemKey = randomUUID();
    const first = await reserve(redis, { productId, userId: 'carol', idemKey });
    expect(await release(redis, { productId, trackingId: first.trackingId, userId: 'carol' })).toBe('RELEASED');
    expect(await getTracking(redis, { productId, trackingId: first.trackingId })).toBeNull();
    expect(await stockOf(redis, k)).toBe(5);

    const retry = await reserve(redis, { productId, userId: 'carol', idemKey });
    expect(retry.code).toBe('RESERVED');
    expect(retry.trackingId).toBe(first.trackingId);
    expect(await stockOf(redis, k)).toBe(4);
  });

  it('can release a QUEUED attempt, but never a CONFIRMED one', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const queued = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    await markQueued(redis, { productId, trackingId: queued.trackingId });
    expect(
      await release(redis, { productId, trackingId: queued.trackingId, userId: 'u1', finalState: 'FAILED' }),
    ).toBe('RELEASED');
    expect(await stockOf(redis, k)).toBe(5);

    const confirmed = await reserve(redis, { productId, userId: 'u2', idemKey: randomUUID() });
    await redis.hset(k.tracking(confirmed.trackingId), 'state', 'CONFIRMED');
    expect(
      await release(redis, { productId, trackingId: confirmed.trackingId, userId: 'u2', finalState: 'FAILED' }),
    ).toBe('NOOP');
    expect(await stockOf(redis, k)).toBe(4);
  });
});

describe('Batch 2 transitions (worker side)', () => {
  const stateOf = async (productId, trackingId) => (await getTracking(redis, { productId, trackingId }))?.state;

  it('beginProcessing moves RESERVED/QUEUED to PROCESSING, is idempotent, and reports stale records', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    expect(await beginProcessing(redis, { productId, trackingId: r.trackingId })).toBe('PROCESSING');
    expect(await beginProcessing(redis, { productId, trackingId: r.trackingId })).toBe('PROCESSING');
    expect(await redis.zcard(k.reservations)).toBe(0);
    expect(await beginProcessing(redis, { productId, trackingId: 'trk_missing' })).toBe('MISSING');
  });

  it('finalize CONFIRMED keeps the unit consumed and the user guard, with no expiry, and never regresses', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    await beginProcessing(redis, { productId, trackingId: r.trackingId });
    const args = { productId, trackingId: r.trackingId, userId: 'u1' };

    expect(await finalize(redis, { ...args, finalState: 'CONFIRMED' })).toBe('CONFIRMED');
    expect(await redis.ttl(k.tracking(r.trackingId))).toBe(-1);
    expect(await redis.get(k.user('u1'))).toBe(r.trackingId);
    expect(await stockOf(redis, k)).toBe(4);

    // Repeating or contradicting a terminal decision changes nothing.
    expect(await finalize(redis, { ...args, finalState: 'CONFIRMED' })).toBe('CONFIRMED');
    expect(await finalize(redis, { ...args, finalState: 'SOLD_OUT' })).toBe('CONFIRMED');
    expect(await release(redis, { ...args, finalState: 'FAILED' })).toBe('NOOP');
    expect(await stockOf(redis, k)).toBe(4);
    expect(await finalize(redis, { ...args, trackingId: 'trk_missing', finalState: 'CONFIRMED' })).toBe('MISSING');
  });

  it('finalize SOLD_OUT zeroes the counter, frees the user and keeps the record for a while', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    await beginProcessing(redis, { productId, trackingId: r.trackingId });
    expect(await finalize(redis, { productId, trackingId: r.trackingId, userId: 'u1', finalState: 'SOLD_OUT' })).toBe(
      'SOLD_OUT',
    );
    expect(await stockOf(redis, k)).toBe(0);
    expect(await redis.get(k.user('u1'))).toBeNull();
    expect(await redis.ttl(k.tracking(r.trackingId))).toBeGreaterThan(0);
  });

  it('cancelReserved returns the unit once, deletes the record so the same key can retry, and respects deadlines', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const idemKey = randomUUID();
    const r = await reserve(redis, { productId, userId: 'u1', idemKey });
    const args = { productId, trackingId: r.trackingId, userId: 'u1' };

    expect(await cancelReserved(redis, { ...args, onlyIfExpired: true })).toBe('NOT_EXPIRED');
    expect(await stockOf(redis, k)).toBe(4);

    expect(await cancelReserved(redis, args)).toBe('CANCELLED');
    expect(await cancelReserved(redis, args)).toBe('MISSING'); // second call cannot return the unit twice
    expect(await stockOf(redis, k)).toBe(5);
    expect(await getTracking(redis, { productId, trackingId: r.trackingId })).toBeNull();

    const again = await reserve(redis, { productId, userId: 'u1', idemKey });
    expect(again.code).toBe('RESERVED');
    expect(again.trackingId).toBe(r.trackingId);
    expect(await stockOf(redis, k)).toBe(4);
  });

  it('cancelReserved refuses once the attempt is QUEUED or PROCESSING (the worker owns it then)', async () => {
    const { productId, k } = await newSale({ stock: 5 });
    const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
    const args = { productId, trackingId: r.trackingId, userId: 'u1' };
    await markQueued(redis, { productId, trackingId: r.trackingId });
    expect(await cancelReserved(redis, args)).toBe('QUEUED');
    await beginProcessing(redis, { productId, trackingId: r.trackingId });
    expect(await cancelReserved(redis, args)).toBe('PROCESSING');
    expect(await stockOf(redis, k)).toBe(4);
    expect(await stateOf(productId, r.trackingId)).toBe('PROCESSING');
  });

  it('cancel and begin racing on the same attempt: exactly one wins and stock stays consistent', async () => {
    for (let round = 0; round < 40; round += 1) {
      const { productId, k } = await newSale({ stock: 5 });
      const r = await reserve(redis, { productId, userId: 'u1', idemKey: randomUUID() });
      const [cancelled, begun] = await Promise.all([
        cancelReserved(redis, { productId, trackingId: r.trackingId, userId: 'u1' }),
        beginProcessing(redis, { productId, trackingId: r.trackingId }),
      ]);
      if (cancelled === 'CANCELLED') {
        expect(begun).toBe('MISSING');
        expect(await stockOf(redis, k)).toBe(5);
      } else {
        expect(cancelled).toBe('PROCESSING');
        expect(begun).toBe('PROCESSING');
        expect(await stockOf(redis, k)).toBe(4);
      }
    }
  });
});
