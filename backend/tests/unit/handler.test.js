import { describe, expect, it } from 'vitest';
import { PermanentJobError } from '../../src/shared/jobs.js';
import { createMessageHandler } from '../../src/worker/handler.js';
import { asMessage, fakeChannel, fakePublisher, makeTestJob, silentLog } from '../helpers/fakes.js';

function setup({ processJob, failExhausted = async () => {}, maxAttempts = 3 } = {}) {
  const publisher = fakePublisher();
  const channel = fakeChannel();
  const exhausted = [];
  const handle = createMessageHandler({
    processJob,
    failExhausted: async (job, reason) => {
      exhausted.push({ job, reason });
      return failExhausted(job, reason);
    },
    publisher,
    log: silentLog,
    maxAttempts,
    wait: async () => {},
  });
  return { handle, publisher, channel, exhausted };
}

const actions = (channel) => channel.calls.map((c) => c[0]);

describe('message handler', () => {
  it('acks only after the job was processed successfully', async () => {
    const order = [];
    const { handle, channel } = setup({
      processJob: async () => {
        order.push('processed');
        return { result: 'PROCESSED' };
      },
    });
    channel.ack = () => order.push('acked');
    await handle(channel, asMessage(makeTestJob()));
    expect(order).toEqual(['processed', 'acked']); // never acked before the work is done
  });

  it('does not ack while processing is still running', async () => {
    let release;
    const { handle, channel } = setup({ processJob: () => new Promise((r) => (release = r)) });
    const done = handle(channel, asMessage(makeTestJob()));
    await new Promise((r) => setTimeout(r, 20));
    expect(channel.calls).toHaveLength(0);
    release({});
    await done;
    expect(actions(channel)).toEqual(['ack']);
  });

  it('schedules a delayed retry (attempt + 1) after a transient failure, then acks the original', async () => {
    const { handle, publisher, channel } = setup({
      processJob: async () => {
        throw new Error('connection reset');
      },
    });
    const result = await handle(channel, asMessage(makeTestJob(), 1));
    expect(result.action).toBe('retry-scheduled');
    expect(publisher.retries).toHaveLength(1);
    expect(publisher.retries[0].nextAttempt).toBe(2);
    expect(actions(channel)).toEqual(['ack']);
    expect(publisher.dead).toHaveLength(0);
  });

  it('worker restart / redelivery: the job fails once, then succeeds when its retry is delivered', async () => {
    let calls = 0;
    const { handle, publisher, channel } = setup({
      processJob: async () => {
        calls += 1;
        if (calls === 1) throw new Error('postgres restarting');
        return { result: 'PROCESSED' };
      },
    });
    await handle(channel, asMessage(makeTestJob(), 1)); // first delivery fails -> retry published
    const retry = publisher.retries[0];
    await handle(channel, asMessage(retry.job, retry.nextAttempt)); // the retry is delivered later
    expect(calls).toBe(2);
    expect(actions(channel)).toEqual(['ack', 'ack']);
    expect(publisher.dead).toHaveLength(0);
  });

  it('dead-letters after the last attempt, after making the user whole', async () => {
    const { handle, publisher, channel, exhausted } = setup({
      maxAttempts: 3,
      processJob: async () => {
        throw new Error('still broken');
      },
    });
    const result = await handle(channel, asMessage(makeTestJob(), 3));
    expect(result.action).toBe('dead-lettered');
    expect(exhausted).toHaveLength(1);
    expect(publisher.dead).toHaveLength(1);
    expect(publisher.dead[0].reason).toBe('still broken');
    expect(publisher.retries).toHaveLength(0);
    expect(actions(channel)).toEqual(['ack']);
  });

  it('a permanent error skips the retries', async () => {
    const { handle, publisher, channel } = setup({
      processJob: async () => {
        throw new PermanentJobError('unknown product');
      },
    });
    const result = await handle(channel, asMessage(makeTestJob(), 1));
    expect(result.action).toBe('dead-lettered');
    expect(publisher.retries).toHaveLength(0);
    expect(publisher.dead).toHaveLength(1);
  });

  it('nacks a malformed message without requeue so the broker dead-letters it', async () => {
    const { handle, channel } = setup({ processJob: async () => ({}) });
    await handle(channel, { content: Buffer.from('garbage'), properties: {} });
    expect(channel.calls).toHaveLength(1);
    const [kind, , allUpTo, requeue] = channel.calls[0];
    expect([kind, allUpTo, requeue]).toEqual(['nack', false, false]);
  });

  it('requeues (never loses) the message when the retry cannot be published', async () => {
    const { handle, publisher, channel } = setup({
      processJob: async () => {
        throw new Error('db down');
      },
    });
    publisher.failNext(1);
    const result = await handle(channel, asMessage(makeTestJob(), 1));
    expect(result.action).toBe('requeued');
    expect(channel.calls[0][0]).toBe('nack');
    expect(channel.calls[0][3]).toBe(true); // requeue = true
  });

  it('requeues when the dead-letter bookkeeping fails, instead of acking', async () => {
    const { handle, channel } = setup({
      maxAttempts: 1,
      processJob: async () => {
        throw new Error('db down');
      },
      failExhausted: async () => {
        throw new Error('redis down');
      },
    });
    const result = await handle(channel, asMessage(makeTestJob(), 1));
    expect(result.action).toBe('requeued');
    expect(actions(channel)).toEqual(['nack']);
  });
});
