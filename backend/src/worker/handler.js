import { parseJob, PermanentJobError } from '../shared/jobs.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function attemptOf(msg) {
  const n = Number(msg.properties?.headers?.['x-attempt']);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * Decides what to do with each delivery. The message is acknowledged ONLY when its outcome is safely
 * recorded: processed (database committed), re-queued for a later retry, or parked in the dead-letter queue.
 * If even that bookkeeping fails, the message is nacked with requeue so RabbitMQ delivers it again.
 *
 * Dependencies are injected so the logic can be tested without RabbitMQ:
 *   processJob(job), failExhausted(job, reason), publisher.publishRetry / publishDead
 */
export function createMessageHandler({
  processJob,
  failExhausted,
  publisher,
  log,
  maxAttempts,
  requeueDelayMs = 1000,
  wait = sleep,
}) {
  function settle(label, fn) {
    try {
      fn();
    } catch (err) {
      // Channel already closed: RabbitMQ redelivers the unacked message to another consumer.
      log.warn({ err: err.message }, `${label} failed; message will be redelivered`);
    }
  }

  return async function handle(channel, msg) {
    let job;
    try {
      job = parseJob(msg.content);
    } catch (err) {
      // Malformed: retrying cannot help. nack(requeue=false) dead-letters it to checkout.dead via the queue's DLX.
      log.error({ err: err.message }, 'unparseable message sent to dead-letter queue');
      settle('nack', () => channel.nack(msg, false, false));
      return { action: 'dead-lettered-malformed' };
    }

    const attempt = attemptOf(msg);
    try {
      const outcome = await processJob(job);
      settle('ack', () => channel.ack(msg));
      log.info({ trackingId: job.trackingId, requestId: job.requestId, attempt, ...outcome }, 'job handled');
      return { action: 'acked', outcome };
    } catch (err) {
      const permanent = err instanceof PermanentJobError;
      log.warn({ trackingId: job.trackingId, requestId: job.requestId, attempt, permanent, err: err.message }, 'job failed');
      try {
        if (permanent || attempt >= maxAttempts) {
          await failExhausted(job, err.message);
          await publisher.publishDead(job, attempt, err.message);
          settle('ack', () => channel.ack(msg));
          log.error({ trackingId: job.trackingId, attempt }, 'job moved to dead-letter queue');
          return { action: 'dead-lettered' };
        }
        await publisher.publishRetry(job, attempt + 1);
        settle('ack', () => channel.ack(msg));
        return { action: 'retry-scheduled', nextAttempt: attempt + 1 };
      } catch (bookkeepingErr) {
        // Could not schedule the retry / dead-letter: keep the message, do not lose the job.
        log.error({ trackingId: job.trackingId, err: bookkeepingErr.message }, 'bookkeeping failed; requeueing');
        await wait(requeueDelayMs); // avoid a hot redelivery loop while a dependency is down
        settle('nack', () => channel.nack(msg, false, true));
        return { action: 'requeued' };
      }
    }
  };
}
