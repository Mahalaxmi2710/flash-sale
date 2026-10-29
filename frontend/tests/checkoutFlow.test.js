import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCheckoutFlow } from '../src/lib/checkoutFlow.js';

// ---- deterministic helpers -------------------------------------------------------------------
function fakeTimers() {
  let clock = 0;
  let nextId = 1;
  const queue = new Map();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => clock,
    setTimeout(fn, ms) {
      const id = nextId++;
      queue.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimeout: (id) => queue.delete(id),
    pending: () => queue.size,
    /** Advance the clock, running due timers and letting their async work finish. */
    async advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
        await flush();
      }
      clock = target;
      await flush();
    },
  };
}
const memoryStorage = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k), data };
};
const apiError = (status, code, extra = {}) => Object.assign(new Error(code), { status, code, ...extra });

/** A scripted API: each queue entry is a value (resolve) or an Error (reject). */
function fakeApi({ checkout = [], status = [] } = {}) {
  const calls = { checkout: [], status: [] };
  const take = (list) => {
    const next = list.length > 1 ? list.shift() : list[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return {
    calls,
    checkout: (productId, key) => {
      calls.checkout.push(key);
      return take(checkout);
    },
    getCheckout: (trackingId) => {
      calls.status.push(trackingId);
      return take(status);
    },
  };
}
function setup(apiScript, opts = {}) {
  const timers = fakeTimers();
  const storage = opts.storage ?? memoryStorage();
  let n = 0;
  const api = fakeApi(apiScript);
  const flow = createCheckoutFlow({
    api,
    productId: 'phone-x',
    storage,
    timers,
    now: timers.now,
    uuid: () => `key-${++n}`,
    ...opts.flow,
  });
  return { flow, api, timers, storage };
}
const QUEUED = { trackingId: 'trk_a', state: 'QUEUED' };

describe('duplicate clicks', () => {
  it('sends one request even if submit is called many times before the first answer', async () => {
    const { flow, api } = setup({ checkout: [QUEUED], status: [QUEUED] });
    await Promise.all([flow.submit(), flow.submit(), flow.submit()]);
    assert.equal(api.calls.checkout.length, 1);
    assert.equal(flow.getState().phase, 'queued');
  });

  it('ignores clicks while queued or processing, and after confirmation', async () => {
    const { flow, api, timers } = setup({ checkout: [QUEUED], status: [{ ...QUEUED, state: 'PROCESSING' }, { ...QUEUED, state: 'CONFIRMED', orderRef: 'ord-1' }] });
    await flow.submit();
    await flow.submit();
    assert.equal(api.calls.checkout.length, 1);
    await timers.advance(1000);
    assert.equal(flow.getState().phase, 'processing');
    await flow.submit();
    await timers.advance(1000);
    assert.equal(flow.getState().phase, 'confirmed');
    await flow.submit();
    assert.equal(api.calls.checkout.length, 1);
  });
});

describe('idempotency key', () => {
  it('reuses the same key when a failed submission is retried', async () => {
    const { flow, api, timers } = setup({ checkout: [apiError(0, 'NETWORK'), QUEUED], status: [QUEUED] });
    await flow.submit();
    assert.equal(flow.getState().phase, 'failure');
    await timers.advance(2000); // cooldown over
    await flow.submit();
    assert.deepEqual(api.calls.checkout, ['key-1', 'key-1']);
    assert.equal(flow.getState().phase, 'queued');
  });

  it('survives a page reload: the new page polls the stored reference instead of submitting again', async () => {
    const first = setup({ checkout: [QUEUED], status: [QUEUED] });
    await first.flow.submit();
    first.flow.dispose();

    const second = setup({ checkout: [QUEUED], status: [{ ...QUEUED, state: 'CONFIRMED', orderRef: 'ord-9' }] }, { storage: first.storage });
    second.flow.start();
    assert.equal(second.flow.getState().phase, 'queued');
    await second.timers.advance(1000);
    assert.equal(second.api.calls.checkout.length, 0);
    assert.equal(second.flow.getState().phase, 'confirmed');
    assert.equal(second.flow.getState().orderRef, 'ord-9');
  });

  it('uses a new key for the next attempt after the order failed', async () => {
    const { flow, api, timers } = setup({ checkout: [QUEUED, QUEUED], status: [{ ...QUEUED, state: 'FAILED' }] });
    await flow.submit();
    await timers.advance(1000);
    assert.equal(flow.getState().phase, 'failure');
    await timers.advance(2000);
    await flow.submit();
    assert.deepEqual(api.calls.checkout, ['key-1', 'key-2']);
  });
});

describe('polling', () => {
  it('stops polling once the order is confirmed (no timers left, no more requests)', async () => {
    const { flow, api, timers } = setup({ checkout: [QUEUED], status: [QUEUED, { ...QUEUED, state: 'CONFIRMED' }] });
    await flow.submit();
    await timers.advance(1000);
    assert.equal(flow.getState().phase, 'queued');
    await timers.advance(1000);
    assert.equal(flow.getState().phase, 'confirmed');
    const calls = api.calls.status.length;
    assert.equal(timers.pending(), 0);
    await timers.advance(60_000);
    assert.equal(api.calls.status.length, calls);
  });

  it('stops on SOLD_OUT and on FAILED', async () => {
    for (const [serverState, phase] of [['SOLD_OUT', 'soldOut'], ['FAILED', 'failure']]) {
      const { flow, api, timers } = setup({ checkout: [QUEUED], status: [{ ...QUEUED, state: serverState }] });
      await flow.submit();
      await timers.advance(1000);
      assert.equal(flow.getState().phase, phase);
      const calls = api.calls.status.length;
      await timers.advance(30_000);
      assert.equal(api.calls.status.length, calls);
    }
  });

  it('keeps polling through temporary errors with backoff, then recovers', async () => {
    const { flow, api, timers } = setup({
      checkout: [QUEUED],
      status: [apiError(503, 'STATUS_UNAVAILABLE'), apiError(0, 'NETWORK'), { ...QUEUED, state: 'CONFIRMED' }],
    });
    await flow.submit();
    await timers.advance(1000); // 1st poll fails
    await timers.advance(2000); // backoff 2s, 2nd fails
    await timers.advance(4000); // backoff 4s, 3rd succeeds
    assert.equal(api.calls.status.length, 3);
    assert.equal(flow.getState().phase, 'confirmed');
  });

  it('gives up after maxPollMs, marks the state stalled, and "check again" resumes', async () => {
    const { flow, api, timers } = setup(
      { checkout: [QUEUED], status: [{ ...QUEUED, state: 'PROCESSING' }] },
      { flow: { maxPollMs: 5000 } },
    );
    await flow.submit();
    await timers.advance(10_000);
    assert.equal(flow.getState().stalled, true);
    assert.equal(timers.pending(), 0); // polling really stopped
    const calls = api.calls.status.length;

    flow.resume();
    await timers.advance(1000);
    assert.ok(api.calls.status.length > calls);
    assert.equal(flow.getState().stalled, false);
  });

  it('forgets an attempt the server no longer knows (404) and lets the user start over', async () => {
    const { flow, storage, timers } = setup({ checkout: [QUEUED], status: [apiError(404, 'TRACKING_NOT_FOUND')] });
    await flow.submit();
    await timers.advance(1000);
    assert.equal(flow.getState().phase, 'idle');
    assert.equal(storage.data.size, 0);
  });

  it('stops everything on dispose (page closed)', async () => {
    const { flow, api, timers } = setup({ checkout: [QUEUED], status: [QUEUED] });
    await flow.submit();
    flow.dispose();
    await timers.advance(30_000);
    assert.equal(api.calls.status.length, 0);
    assert.equal(timers.pending(), 0);
  });
});

describe('error states', () => {
  it('shows sold out for a 409 SOLD_OUT and does not poll', async () => {
    const { flow, api, timers } = setup({ checkout: [apiError(409, 'SOLD_OUT')] });
    await flow.submit();
    assert.equal(flow.getState().phase, 'soldOut');
    await timers.advance(10_000);
    assert.equal(api.calls.status.length, 0);
  });

  it('follows the existing reference when the server says the user already holds a unit', async () => {
    const err = apiError(409, 'ALREADY_PURCHASED', { body: { error: { trackingId: 'trk_existing' } } });
    const { flow, api, timers } = setup({ checkout: [err], status: [{ trackingId: 'trk_existing', state: 'CONFIRMED' }] });
    await flow.submit();
    await timers.advance(1000);
    assert.deepEqual(api.calls.status, ['trk_existing']);
    assert.equal(flow.getState().phase, 'confirmed');
  });

  it('shows a clear failure with a cooldown for a 503, and the cooldown ends', async () => {
    const { flow, timers } = setup({ checkout: [apiError(503, 'QUEUE_UNAVAILABLE', { retryAfterMs: 2000 })] });
    await flow.submit();
    const s = flow.getState();
    assert.equal(s.phase, 'failure');
    assert.match(s.error.message, /busy/);
    assert.equal(s.cooldown, true);
    await timers.advance(2500);
    assert.equal(flow.getState().cooldown, false);
  });
});
