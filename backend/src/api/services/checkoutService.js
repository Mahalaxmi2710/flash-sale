import { config } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import { makeJob } from '../../shared/jobs.js';
import { logger } from '../../shared/logger.js';
import { cancelReserved, markQueued, reserve } from '../../shared/reservation.js';

const retryable = (code, message) =>
  new AppError(503, code, message, { headers: { 'Retry-After': '2' }, details: { retryable: true } });

const ACCEPTED = new Set(['QUEUED', 'PROCESSING']); // a durable message exists -> 202
const FINISHED = new Set(['CONFIRMED', 'SOLD_OUT', 'FAILED']); // outcome already decided -> 200

function respond(trackingId, state, duplicate) {
  const body = { trackingId, state, ...(duplicate ? { duplicate: true } : {}) };
  const headers = { Location: `/api/checkout/${trackingId}` };
  if (ACCEPTED.has(state)) return { status: 202, headers, body };
  if (FINISHED.has(state)) return { status: 200, headers, body };
  // RESERVED / MISSING / unknown: nothing durable is recorded, so we must not claim acceptance.
  throw retryable('QUEUE_UNAVAILABLE', 'Checkout could not be queued. Please retry.');
}

/**
 * Reserve a unit in Redis, publish a persistent job with a publisher confirm, then record QUEUED.
 * 202 is returned only after BOTH the reservation and the broker confirm succeeded.
 *
 * Redis and RabbitMQ are two separate systems with no shared transaction. Every failure window is
 * handled by making each step safe to repeat:
 *   - Publish fails or is unconfirmed: the reservation is cancelled (stock returned) if it is still
 *     RESERVED. If the message actually did reach the broker, the worker finds the cancelled record
 *     (MISSING) and drops the job, or finds a later re-reservation of the same key and serves that one.
 *   - Publish confirmed but the QUEUED mark fails: answer 503. The client retries with the same key,
 *     the key is DUPLICATE/RESERVED, we publish again; the worker de-duplicates by tracking id.
 *   - A reservation nobody completes expires (worker/reconciler.js) and its unit is returned.
 */
export async function submitCheckout({
  redis,
  publisher,
  userId,
  idemKey,
  productId = config.productId,
  requestId,
  log = logger,
}) {

  let result;
  try {
    result = await reserve(redis, { productId, userId, idemKey });
  } catch (err) {
    // Redis unreachable: fail closed. Never bypass the admission gate.
    log.error({ err }, 'redis admission failed');
    throw retryable('ADMISSION_UNAVAILABLE', 'Checkout is temporarily unavailable. Please retry.');
  }

  switch (result.code) {
    case 'RESERVED':
      return enqueue({ redis, publisher, userId, idemKey, productId, requestId, trackingId: result.trackingId, duplicate: false, log });
    case 'DUPLICATE':
      // Still RESERVED means an earlier request never finished queueing it: queue it now (safe to repeat).
      if (result.detail === 'RESERVED') {
        return enqueue({ redis, publisher, userId, idemKey, productId, requestId, trackingId: result.trackingId, duplicate: true, log });
      }
      return respond(result.trackingId, result.detail, true);
    case 'SOLD_OUT':
      throw new AppError(409, 'SOLD_OUT', 'This item is sold out.');
    case 'ALREADY_PURCHASED':
      throw new AppError(409, 'ALREADY_PURCHASED', 'You already hold a unit of this product.', {
        details: { trackingId: result.detail },
      });
    case 'NOT_STARTED': {
      const retryAfterMs = Number(result.detail);
      throw new AppError(409, 'SALE_NOT_STARTED', 'The sale has not started yet.', {
        headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
        details: { retryAfterMs },
      });
    }
    default:
      throw new AppError(503, 'SALE_NOT_CONFIGURED', 'The sale has not been configured.');
  }
}

async function enqueue({ redis, publisher, userId, idemKey, productId, requestId, trackingId, duplicate, log }) {
  const job = makeJob({ trackingId, userId, productId, idempotencyKey: idemKey, requestId });

  try {
    await publisher.publishJob(job);
  } catch (err) {
    log.error({ err: err.message, trackingId }, 'publish to rabbitmq failed');
    let outcome;
    try {
      outcome = await cancelReserved(redis, { productId, trackingId, userId });
    } catch (redisErr) {
      // Cannot cancel right now: the reservation stays RESERVED and the reconciler expires it later.
      log.error({ err: redisErr.message, trackingId }, 'cancel after publish failure failed');
      throw retryable('QUEUE_UNAVAILABLE', 'Checkout could not be queued. Please retry.');
    }
    if (outcome === 'CANCELLED' || outcome === 'MISSING') {
      throw retryable('QUEUE_UNAVAILABLE', 'Checkout could not be queued. Please retry.');
    }
    // Not RESERVED any more: another request or the worker already moved this attempt along.
    return respond(trackingId, outcome, true);
  }

  let state;
  try {
    state = await markQueued(redis, { productId, trackingId });
  } catch (err) {
    log.error({ err: err.message, trackingId }, 'markQueued failed after a confirmed publish');
    throw retryable('QUEUE_UNAVAILABLE', 'Checkout could not be confirmed. Please retry.');
  }
  return respond(trackingId, state, duplicate);
}
