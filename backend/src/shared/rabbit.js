import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { config } from './config.js';
import { logger } from './logger.js';
import { TimeoutError, withTimeout } from './util.js';

/**
 * RabbitMQ layout (all durable):
 *
 *   flash.checkout (direct) --checkout--> checkout.jobs      main queue, consumed by the worker
 *   flash.checkout.retry    --retry.<ms>--> checkout.retry.<ms>   waits <ms> (queue TTL), then dead-letters
 *                                                                  back to flash.checkout (= a delayed retry)
 *   flash.checkout.dlx      --dead--> checkout.dead          jobs that are exhausted, permanently failing or
 *                                                             malformed. Nothing consumes it: inspect it in the
 *                                                             management UI (http://localhost:15672).
 *
 * checkout.jobs also dead-letters to flash.checkout.dlx, so a message the worker rejects with
 * nack(requeue=false) lands in checkout.dead without any extra code.
 */
export const TOPOLOGY = Object.freeze({
  exchange: 'flash.checkout',
  routingKey: 'checkout',
  queue: 'checkout.jobs',
  retryExchange: 'flash.checkout.retry',
  retryDelaysMs: [2000, 10000, 30000],
  deadExchange: 'flash.checkout.dlx',
  deadRoutingKey: 'dead',
  deadQueue: 'checkout.dead',
});

export const retryQueueName = (ms) => `checkout.retry.${ms}`;
export const retryRoutingKey = (ms) => `retry.${ms}`;

/** Delay before delivery number `nextAttempt` (2 = first retry). Later attempts reuse the longest delay. */
export function retryDelayFor(nextAttempt) {
  const list = TOPOLOGY.retryDelaysMs;
  return list[Math.min(Math.max(nextAttempt - 2, 0), list.length - 1)];
}

/** Declare everything. Declarations are idempotent as long as the arguments never change. */
export async function assertTopology(ch) {
  const T = TOPOLOGY;
  for (const name of [T.exchange, T.retryExchange, T.deadExchange]) {
    await ch.assertExchange(name, 'direct', { durable: true });
  }

  await ch.assertQueue(T.deadQueue, { durable: true });
  await ch.bindQueue(T.deadQueue, T.deadExchange, T.deadRoutingKey);

  await ch.assertQueue(T.queue, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': T.deadExchange,
      'x-dead-letter-routing-key': T.deadRoutingKey,
    },
  });
  await ch.bindQueue(T.queue, T.exchange, T.routingKey);

  for (const ms of T.retryDelaysMs) {
    await ch.assertQueue(retryQueueName(ms), {
      durable: true,
      arguments: {
        'x-message-ttl': ms,
        'x-dead-letter-exchange': T.exchange,
        'x-dead-letter-routing-key': T.routingKey,
      },
    });
    await ch.bindQueue(retryQueueName(ms), T.retryExchange, retryRoutingKey(ms));
  }
}

/**
 * Publisher with confirms. A publish resolves ONLY after the broker has confirmed that it took
 * responsibility for the message (persistent + durable queue = written to disk on the broker side).
 * It rejects when the broker nacks, the message is unroutable, the connection drops, or the
 * confirm does not arrive within the timeout. A timeout means "outcome unknown": callers must be
 * idempotent about that (the checkout flow is: duplicates are harmless, see worker/processor.js).
 *
 * The connection is opened lazily and re-opened after a failure, so an API process survives a broker restart.
 * `connect` is injectable for tests.
 */
export function createPublisher({
  url = config.rabbitmqUrl,
  connect = (u) => amqp.connect(u),
  timeoutMs = config.publishTimeoutMs,
} = {}) {
  let connection = null;
  let channel = null;
  let opening = null;
  let closed = false;
  const returned = new Set(); // messageIds the broker returned as unroutable

  function reset() {
    const conn = connection;
    connection = null;
    channel = null;
    if (conn) Promise.resolve(conn.close()).catch(() => {});
  }

  async function open() {
    const conn = await connect(url);
    conn.on('error', (err) => logger.warn({ err: err.message }, 'rabbitmq connection error'));
    conn.on('close', () => {
      if (connection === conn) {
        connection = null;
        channel = null;
      }
    });
    try {
      const ch = await conn.createConfirmChannel();
      ch.on('error', (err) => logger.warn({ err: err.message }, 'rabbitmq channel error'));
      ch.on('close', () => {
        if (channel === ch) reset();
      });
      ch.on('return', (msg) => returned.add(msg.properties.messageId));
      await assertTopology(ch);
      connection = conn;
      channel = ch;
      return ch;
    } catch (err) {
      Promise.resolve(conn.close()).catch(() => {});
      throw err;
    }
  }

  function getChannel() {
    if (closed) return Promise.reject(new Error('publisher is closed'));
    if (channel) return Promise.resolve(channel);
    opening ??= open().finally(() => {
      opening = null;
    });
    return opening;
  }

  async function publish(exchange, routingKey, payload, headers) {
    const ch = await withTimeout(getChannel(), timeoutMs, 'rabbitmq connect');
    const messageId = randomUUID();
    const body = Buffer.from(JSON.stringify(payload));
    try {
      await withTimeout(
        new Promise((resolve, reject) => {
          ch.publish(
            exchange,
            routingKey,
            body,
            {
              persistent: true, // delivery-mode 2: survives a broker restart (with the durable queue)
              mandatory: true, // an unroutable message is returned to us instead of silently dropped
              contentType: 'application/json',
              messageId,
              timestamp: Math.floor(Date.now() / 1000),
              headers,
            },
            (err) => {
              if (err) return reject(err);
              if (returned.delete(messageId)) return reject(new Error('message was unroutable'));
              resolve();
            },
          );
        }),
        timeoutMs,
        'rabbitmq publisher confirm',
      );
    } catch (err) {
      returned.delete(messageId);
      // After a timeout we cannot trust this channel's confirm bookkeeping: start fresh next time.
      if (err instanceof TimeoutError) reset();
      throw err;
    }
  }

  return {
    /** First delivery of a checkout job. */
    publishJob: (job) => publish(TOPOLOGY.exchange, TOPOLOGY.routingKey, job, { 'x-attempt': 1 }),
    /** Delayed redelivery. `nextAttempt` is the delivery number the worker will see (2 = first retry). */
    publishRetry: (job, nextAttempt) =>
      publish(TOPOLOGY.retryExchange, retryRoutingKey(retryDelayFor(nextAttempt)), job, {
        'x-attempt': nextAttempt,
      }),
    /** Park a job in the dead-letter queue, with the reason for the operator. */
    publishDead: (job, attempt, reason) =>
      publish(TOPOLOGY.deadExchange, TOPOLOGY.deadRoutingKey, job, {
        'x-attempt': attempt,
        'x-failure-reason': String(reason).slice(0, 500),
      }),
    /** Readiness probe: can we reach the broker (opens the connection if needed)? */
    ping: async () => {
      await getChannel();
    },
    close: async () => {
      closed = true;
      const conn = connection;
      connection = null;
      channel = null;
      if (conn) await Promise.resolve(conn.close()).catch(() => {});
    },
  };
}
