import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { config } from '../../src/shared/config.js';
import { keys } from '../../src/shared/keys.js';
import { processJob } from '../../src/worker/processor.js';
import { cleanupInventory, connectTestDb, seedInventory } from '../helpers/db.js';
import { fakePublisher } from '../helpers/fakes.js';
import { cleanupSale, connectTestRedis, seedSale, stockOf } from '../helpers/redis.js';

// vitest.config.js sets PRODUCT_ID=test-api-product, so these tests never touch the demo sale.
// The broker is replaced by a fake publisher; RabbitMQ itself is covered by tests/unit/rabbit.test.js.
let redis;
let pool;
let publisher;
const k = keys(config.productId);

const makeApp = () =>
  createApp({
    redis,
    pool,
    publisher,
    readinessChecks: { redis: () => redis.ping(), rabbitmq: () => publisher.ping() },
  });

async function newAgent(app) {
  const agent = request.agent(app); // keeps the session cookie
  await agent.post('/api/session').expect(200);
  return agent;
}

const checkout = (agent, key = randomUUID(), body = { productId: config.productId }) =>
  agent.post('/api/checkout').set('Idempotency-Key', key).send(body);

beforeAll(async () => {
  redis = await connectTestRedis();
  pool = await connectTestDb();
});
afterAll(async () => {
  await cleanupSale(redis, config.productId);
  await cleanupInventory(pool, config.productId);
  await redis.quit();
  await pool.end();
});
beforeEach(async () => {
  publisher = fakePublisher();
  await cleanupInventory(pool, config.productId);
  await seedInventory(pool, config.productId, 3);
  await seedSale(redis, config.productId, { stock: 3 });
});

describe('GET /api/health', () => {
  it('reports live and ready', async () => {
    const app = makeApp();
    await request(app).get('/api/health/live').expect(200);
    const ready = await request(app).get('/api/health/ready').expect(200);
    expect(ready.body.checks.redis.ok).toBe(true);
    expect(ready.body.checks.rabbitmq.ok).toBe(true);
  });
});

describe('GET /api/sale', () => {
  it('returns LIVE with product info and server time', async () => {
    const res = await request(makeApp()).get('/api/sale').expect(200);
    expect(res.body.status).toBe('LIVE');
    expect(res.body.product.id).toBe(config.productId);
    expect(typeof res.body.serverTime).toBe('number');
  });

  it('returns UPCOMING before the start time', async () => {
    await seedSale(redis, config.productId, { stock: 3, startsInMs: 60_000 });
    const res = await request(makeApp()).get('/api/sale').expect(200);
    expect(res.body.status).toBe('UPCOMING');
  });

  it('returns SOLD_OUT when stock is exhausted', async () => {
    await seedSale(redis, config.productId, { stock: 0 });
    const res = await request(makeApp()).get('/api/sale').expect(200);
    expect(res.body.status).toBe('SOLD_OUT');
  });
});

describe('POST /api/checkout', () => {
  it('requires a session', async () => {
    const res = await request(makeApp())
      .post('/api/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({ productId: config.productId });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REQUIRED');
  });

  it('rejects a missing or malformed idempotency key, a bad body and an unknown product without reserving anything', async () => {
    const app = makeApp();
    const agent = await newAgent(app);

    const missing = await agent.post('/api/checkout').send({ productId: config.productId });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');

    expect((await checkout(agent, 'not-a-uuid')).body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect((await checkout(agent, randomUUID(), { productId: config.productId, extra: 1 })).body.error.code).toBe(
      'INVALID_REQUEST',
    );
    expect((await checkout(agent, randomUUID(), {})).body.error.code).toBe('INVALID_REQUEST');
    expect((await checkout(agent, randomUUID(), { productId: 'other' })).status).toBe(404);

    const notJson = await agent.post('/api/checkout').set('Idempotency-Key', randomUUID()).set('Content-Type', 'application/json').send('{oops');
    expect(notJson.status).toBe(400);
    expect(notJson.body.error.code).toBe('INVALID_JSON');

    expect(await stockOf(redis, k)).toBe(3);
    expect(publisher.jobs).toHaveLength(0);
  });

  it('rejects a cross-site Origin before doing any work', async () => {
    const agent = await newAgent(makeApp());
    const res = await agent
      .post('/api/checkout')
      .set('Origin', 'https://evil.example')
      .set('Idempotency-Key', randomUUID())
      .send({ productId: config.productId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
    expect(await stockOf(redis, k)).toBe(3);
  });

  it('answers 202 only after the job is queued, and a repeated key returns the same reference without reserving again', async () => {
    const agent = await newAgent(makeApp());
    const key = randomUUID();
    const first = await checkout(agent, key);
    expect(first.status).toBe(202);
    expect(first.body.state).toBe('QUEUED');
    expect(first.headers.location).toBe(`/api/checkout/${first.body.trackingId}`);
    expect(first.body.duplicate).toBeUndefined();
    expect(publisher.jobs).toHaveLength(1);

    const second = await checkout(agent, key);
    expect(second.status).toBe(202);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.trackingId).toBe(first.body.trackingId);
    expect(publisher.jobs).toHaveLength(1);
    expect(await stockOf(redis, k)).toBe(2);
  });

  it('20 concurrent requests with one key consume a single unit', async () => {
    const agent = await newAgent(makeApp());
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 20 }, () => checkout(agent, key)));
    expect(responses.every((r) => r.status === 202)).toBe(true);
    expect(new Set(responses.map((r) => r.body.trackingId)).size).toBe(1);
    expect(await stockOf(redis, k)).toBe(2);
  });

  it('returns a retryable 503 when the broker is down, and nothing stays reserved', async () => {
    const agent = await newAgent(makeApp());
    const key = randomUUID();
    publisher.failNext(1);
    const res = await checkout(agent, key);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('QUEUE_UNAVAILABLE');
    expect(res.body.error.retryable).toBe(true);
    expect(res.headers['retry-after']).toBe('2');
    expect(await stockOf(redis, k)).toBe(3);

    expect((await checkout(agent, key)).status).toBe(202); // same key, broker back
  });

  it('returns 409 SOLD_OUT once stock is gone, and 409 ALREADY_PURCHASED for a second key', async () => {
    const app = makeApp();
    const agents = await Promise.all([newAgent(app), newAgent(app), newAgent(app), newAgent(app)]);
    const results = await Promise.all(agents.map((a) => checkout(a)));
    expect(results.filter((r) => r.status === 202)).toHaveLength(3);
    const rejected = results.find((r) => r.status === 409);
    expect(rejected.body.error.code).toBe('SOLD_OUT');
    expect(await stockOf(redis, k)).toBe(0);

    await seedSale(redis, config.productId, { stock: 3 });
    const agent = await newAgent(app);
    expect((await checkout(agent)).status).toBe(202);
    const again = await checkout(agent, randomUUID());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_PURCHASED');
  });

  it('returns 409 SALE_NOT_STARTED with Retry-After before the sale', async () => {
    await seedSale(redis, config.productId, { stock: 3, startsInMs: 60_000 });
    const agent = await newAgent(makeApp());
    const res = await checkout(agent);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SALE_NOT_STARTED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(await stockOf(redis, k)).toBe(3);
  });
});

describe('GET /api/checkout/:trackingId', () => {
  it('requires a session and a well-formed reference', async () => {
    const app = makeApp();
    expect((await request(app).get(`/api/checkout/trk_${'a'.repeat(32)}`)).status).toBe(401);
    const agent = await newAgent(app);
    const bad = await agent.get('/api/checkout/not-a-reference');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_TRACKING_ID');
  });

  it('returns 404 for an unknown reference', async () => {
    const agent = await newAgent(makeApp());
    const res = await agent.get(`/api/checkout/trk_${'f'.repeat(32)}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TRACKING_NOT_FOUND');
  });

  it('follows the attempt from QUEUED to CONFIRMED, and hides it from other users', async () => {
    const app = makeApp();
    const agent = await newAgent(app);
    const { body } = await checkout(agent);

    const queued = await agent.get(`/api/checkout/${body.trackingId}`).expect(200);
    expect(queued.body).toEqual({ trackingId: body.trackingId, state: 'QUEUED' });

    await processJob({ pool, redis }, publisher.jobs[0]); // what the worker does after consuming the message
    const done = await agent.get(`/api/checkout/${body.trackingId}`).expect(200);
    expect(done.body.state).toBe('CONFIRMED');
    expect(done.body.orderRef).toMatch(/^[0-9a-f-]{36}$/);

    const stranger = await newAgent(app);
    expect((await stranger.get(`/api/checkout/${body.trackingId}`)).status).toBe(404);
  });
});
