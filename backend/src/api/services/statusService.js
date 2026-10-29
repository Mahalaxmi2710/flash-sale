import { config } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { getTracking } from '../../shared/reservation.js';

const TERMINAL = new Set(['CONFIRMED', 'SOLD_OUT', 'FAILED']);

const notFound = () => new AppError(404, 'TRACKING_NOT_FOUND', 'No checkout found for this reference.');
const unavailable = () =>
  new AppError(503, 'STATUS_UNAVAILABLE', 'Status is temporarily unavailable. Please retry.', {
    headers: { 'Retry-After': '2' },
    details: { retryable: true },
  });

async function findOrder(pool, trackingId, userId) {
  const { rows } = await pool.query(
    `SELECT order_ref, status, failure_reason FROM orders WHERE tracking_id = $1 AND user_id = $2`,
    [trackingId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Status lookup. Redis answers in-flight attempts (RESERVED/QUEUED/PROCESSING) cheaply. PostgreSQL
 * holds the permanent outcome, so it supplies the order reference and failure reason once an attempt
 * is finished, and it answers on its own if Redis has lost or expired the record.
 * An attempt that belongs to another user is reported as unknown.
 */
export async function getCheckoutStatus({
  redis,
  pool,
  userId,
  trackingId,
  productId = config.productId,
  log = logger,
}) {
  let record = null;
  let redisDown = false;
  try {
    record = await getTracking(redis, { productId, trackingId });
  } catch (err) {
    redisDown = true;
    log.warn({ err: err.message }, 'status: redis lookup failed, falling back to postgres');
  }

  if (record) {
    if (record.userId !== userId) throw notFound();
    const body = { trackingId, state: record.state };
    if (TERMINAL.has(record.state)) {
      try {
        const order = await findOrder(pool, trackingId, userId);
        if (order) {
          body.orderRef = order.order_ref;
          if (order.failure_reason) body.reason = order.failure_reason;
        }
      } catch (err) {
        log.warn({ err: err.message }, 'status: could not enrich with order details'); // still answer
      }
    }
    return body;
  }

  let order;
  try {
    order = await findOrder(pool, trackingId, userId);
  } catch (err) {
    log.error({ err: err.message }, 'status: postgres lookup failed');
    throw unavailable();
  }
  if (order) {
    return {
      trackingId,
      state: order.status,
      orderRef: order.order_ref,
      ...(order.failure_reason ? { reason: order.failure_reason } : {}),
    };
  }
  if (redisDown) throw unavailable(); // we could not look in both places, so we cannot say "unknown"
  throw notFound();
}
