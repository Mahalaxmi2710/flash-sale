import { describe, expect, it } from 'vitest';
import {
  assertTopology,
  createPublisher,
  retryDelayFor,
  retryQueueName,
  TOPOLOGY,
} from '../../src/shared/rabbit.js';

/** A fake amqplib connection. `onPublish(info, cb)` decides how the broker answers. */
function fakeBroker(onPublish) {
  const state = { connects: 0, published: [], declared: { queues: [], exchanges: [], bindings: [] }, closed: 0 };
  const channelHandlers = {};
  const channel = {
    on: (event, fn) => {
      channelHandlers[event] = fn;
    },
    assertExchange: async (name, type, opts) => state.declared.exchanges.push({ name, type, opts }),
    assertQueue: async (name, opts) => state.declared.queues.push({ name, opts }),
    bindQueue: async (queue, exchange, key) => state.declared.bindings.push({ queue, exchange, key }),
    publish: (exchange, key, body, props, cb) => {
      state.published.push({ exchange, key, body: JSON.parse(body.toString()), props });
      onPublish({ exchange, key, props, channelHandlers }, cb);
      return true;
    },
  };
  const connection = {
    on: () => {},
    createConfirmChannel: async () => channel,
    close: async () => {
      state.closed += 1;
    },
  };
  return {
    state,
    connect: async () => {
      state.connects += 1;
      return connection;
    },
  };
}

const job = { v: 1, trackingId: 'trk_' + 'a'.repeat(32), userId: 'u', productId: 'p', idempotencyKey: 'k', createdAt: 1 };

describe('topology', () => {
  it('declares durable exchanges and queues with the retry and dead-letter wiring', async () => {
    const { state, connect } = fakeBroker(() => {});
    await assertTopology(await (await connect()).createConfirmChannel());

    expect(state.declared.exchanges.every((e) => e.opts.durable)).toBe(true);
    expect(state.declared.queues.every((q) => q.opts.durable)).toBe(true);

    const main = state.declared.queues.find((q) => q.name === TOPOLOGY.queue);
    expect(main.opts.arguments['x-dead-letter-exchange']).toBe(TOPOLOGY.deadExchange);

    for (const ms of TOPOLOGY.retryDelaysMs) {
      const retry = state.declared.queues.find((q) => q.name === retryQueueName(ms));
      expect(retry.opts.arguments['x-message-ttl']).toBe(ms);
      expect(retry.opts.arguments['x-dead-letter-exchange']).toBe(TOPOLOGY.exchange); // back to the main queue
    }
    expect(state.declared.queues.some((q) => q.name === TOPOLOGY.deadQueue)).toBe(true);
  });

  it('picks growing retry delays and reuses the last one', () => {
    expect(retryDelayFor(2)).toBe(2000);
    expect(retryDelayFor(3)).toBe(10000);
    expect(retryDelayFor(4)).toBe(30000);
    expect(retryDelayFor(9)).toBe(30000);
  });
});

describe('publisher confirms', () => {
  it('resolves only after the broker confirms, and sends a persistent, mandatory message', async () => {
    let confirm;
    const { state, connect } = fakeBroker((_, cb) => {
      confirm = cb;
    });
    const publisher = createPublisher({ connect, timeoutMs: 500 });

    let settled = false;
    const p = publisher.publishJob(job).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // no confirm yet -> not accepted
    confirm(null);
    await p;
    expect(settled).toBe(true);

    const sent = state.published[0];
    expect(sent.exchange).toBe(TOPOLOGY.exchange);
    expect(sent.props.persistent).toBe(true);
    expect(sent.props.mandatory).toBe(true);
    expect(sent.props.headers['x-attempt']).toBe(1);
    expect(sent.body).toEqual(job);
  });

  it('rejects when the broker nacks the message', async () => {
    const { connect } = fakeBroker((_, cb) => cb(new Error('nack')));
    const publisher = createPublisher({ connect, timeoutMs: 500 });
    await expect(publisher.publishJob(job)).rejects.toThrow('nack');
  });

  it('rejects when the message is returned as unroutable', async () => {
    const { connect } = fakeBroker(({ props, channelHandlers }, cb) => {
      channelHandlers.return({ properties: { messageId: props.messageId } }); // basic.return comes before the ack
      cb(null);
    });
    const publisher = createPublisher({ connect, timeoutMs: 500 });
    await expect(publisher.publishJob(job)).rejects.toThrow('unroutable');
  });

  it('rejects on a missing confirm (timeout) and reconnects on the next call', async () => {
    let silent = true;
    const { state, connect } = fakeBroker((_, cb) => {
      if (!silent) cb(null);
    });
    const publisher = createPublisher({ connect, timeoutMs: 40 });
    await expect(publisher.publishJob(job)).rejects.toThrow('timed out');
    expect(state.closed).toBe(1); // the channel with unknown confirm state was thrown away

    silent = false;
    await publisher.publishJob(job);
    expect(state.connects).toBe(2);
  });

  it('routes retries to the delay queue for the attempt and dead letters to the DLX with a reason', async () => {
    const { state, connect } = fakeBroker((_, cb) => cb(null));
    const publisher = createPublisher({ connect, timeoutMs: 500 });
    await publisher.publishRetry(job, 3);
    await publisher.publishDead(job, 4, 'boom');
    expect(state.published[0].exchange).toBe(TOPOLOGY.retryExchange);
    expect(state.published[0].key).toBe('retry.10000');
    expect(state.published[0].props.headers['x-attempt']).toBe(3);
    expect(state.published[1].exchange).toBe(TOPOLOGY.deadExchange);
    expect(state.published[1].props.headers['x-failure-reason']).toBe('boom');
  });
});
