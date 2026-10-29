import { config } from './config.js';
import { keys } from './keys.js';
import { makeTrackingId } from './tracking.js';

/**
 * Atomically admit (or reject) one purchase attempt.
 * Result codes: RESERVED | DUPLICATE | NOT_STARTED | SOLD_OUT | ALREADY_PURCHASED | SALE_NOT_CONFIGURED
 */
export async function reserve(
  redis,
  { productId, userId, idemKey, ttlMs = config.reservationTtlSeconds * 1000 },
) {
  const trackingId = makeTrackingId(config.sessionSecret, userId, idemKey);
  const k = keys(productId);
  const [code, detail] = await redis.fsReserve(
    k.stock,
    k.sale,
    k.tracking(trackingId),
    k.user(userId),
    k.reservations,
    trackingId,
    userId,
    ttlMs,
  );
  return { code, detail: detail ?? null, trackingId };
}

/** RESERVED -> QUEUED once the broker has confirmed the message. Returns the resulting/current state. */
export async function markQueued(redis, { productId, trackingId }) {
  const k = keys(productId);
  return redis.fsMarkQueued(k.tracking(trackingId), k.reservations, trackingId);
}

/**
 * Give one unit back to the admission counter, exactly once.
 * finalState '' deletes the record (the same idempotency key may retry);
 * a non-empty finalState (e.g. FAILED, EXPIRED) keeps it for retentionSec so status lookups still answer.
 * Returns RELEASED or NOOP (already released, already terminal, or unknown).
 */
export async function release(
  redis,
  { productId, trackingId, userId, finalState = '', retentionSec = 3600 },
) {
  const k = keys(productId);
  return redis.fsRelease(
    k.stock,
    k.tracking(trackingId),
    k.user(userId),
    k.reservations,
    trackingId,
    finalState,
    retentionSec,
  );
}

export async function getTracking(redis, { productId, trackingId }) {
  const data = await redis.hgetall(keys(productId).tracking(trackingId));
  return Object.keys(data).length ? data : null;
}
// ---------------------------------------------------------------------------------------------
// Batch 2: worker-side state transitions. All of them are atomic Lua scripts and idempotent.
// ---------------------------------------------------------------------------------------------

/** Worker starts a job. Resolves 'PROCESSING' to proceed; anything else means the job is stale. */
export async function beginProcessing(redis, { productId, trackingId }) {
  const k = keys(productId);
  return redis.fsBegin(k.tracking(trackingId), k.reservations, trackingId);
}

/**
 * Record the database outcome CONFIRMED or SOLD_OUT. For FAILED call release() with finalState 'FAILED'.
 * Returns the resulting state, or MISSING if Redis no longer has the record.
 */
export async function finalize(
  redis,
  { productId, trackingId, userId, finalState, retentionSec = 3600 },
) {
  const k = keys(productId);
  return redis.fsFinalize(
    k.stock,
    k.tracking(trackingId),
    k.user(userId),
    k.reservations,
    trackingId,
    finalState,
    retentionSec,
  );
}

/**
 * Cancel a RESERVED attempt that never reached the broker. Never touches QUEUED/PROCESSING/terminal ones.
 * Returns CANCELLED | NOT_EXPIRED | MISSING | <current state>.
 */
export async function cancelReserved(redis, { productId, trackingId, userId, onlyIfExpired = false }) {
  const k = keys(productId);
  return redis.fsCancel(
    k.stock,
    k.tracking(trackingId),
    k.user(userId),
    k.reservations,
    trackingId,
    onlyIfExpired ? '1' : '0',
  );
}
