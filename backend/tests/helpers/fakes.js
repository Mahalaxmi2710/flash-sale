import { randomUUID } from 'node:crypto';
import { config } from '../../src/shared/config.js';
import { makeTrackingId } from '../../src/shared/tracking.js';

export const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Records every publish. `failNext(n)` makes the next n publishes reject. */
export function fakePublisher() {
  const jobs = [];
  const retries = [];
  const dead = [];
  let failures = 0;
  const maybeFail = () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('broker unavailable');
    }
  };
  return {
    jobs,
    retries,
    dead,
    failNext: (n = 1) => {
      failures = n;
    },
    publishJob: async (job) => {
      maybeFail();
      jobs.push(job);
    },
    publishRetry: async (job, nextAttempt) => {
      maybeFail();
      retries.push({ job, nextAttempt });
    },
    publishDead: async (job, attempt, reason) => {
      maybeFail();
      dead.push({ job, attempt, reason });
    },
    ping: async () => {},
  };
}

/** A fake amqplib channel that records ack/nack calls. */
export function fakeChannel() {
  const calls = [];
  return {
    calls,
    ack: (msg) => calls.push(['ack', msg]),
    nack: (msg, allUpTo, requeue) => calls.push(['nack', msg, allUpTo, requeue]),
  };
}

export function makeTestJob({ productId = config.productId, userId = randomUUID(), idempotencyKey = randomUUID() } = {}) {
  return {
    v: 1,
    trackingId: makeTrackingId(config.sessionSecret, userId, idempotencyKey),
    userId,
    productId,
    idempotencyKey,
    createdAt: Date.now(),
  };
}

/** Wrap a job as an amqplib message (content buffer + headers). */
export function asMessage(job, attempt = 1) {
  return { content: Buffer.from(JSON.stringify(job)), properties: { headers: { 'x-attempt': attempt } } };
}
