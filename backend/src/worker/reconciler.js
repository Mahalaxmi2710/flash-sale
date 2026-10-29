import { keys } from '../shared/keys.js';
import { cancelReserved } from '../shared/reservation.js';

/**
 * Return the units held by reservations that never became durable (the API crashed, or the broker
 * was unreachable) once their deadline has passed.
 *
 * The reservations index contains only RESERVED attempts; QUEUED and PROCESSING ones leave it.
 * cancel_reserved.lua re-checks the state and the deadline atomically, so this can run on several
 * workers at once and can never cancel an attempt that has since been queued or is being processed.
 * Returns the number of reservations cancelled.
 */
export async function expireStaleReservations(redis, { productId, limit = 500, log }) {
  const k = keys(productId);
  const [seconds, micros] = await redis.time();
  const nowMs = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  const ids = await redis.zrangebyscore(k.reservations, '-inf', nowMs, 'LIMIT', 0, limit);

  let cancelled = 0;
  for (const trackingId of ids) {
    const userId = await redis.hget(k.tracking(trackingId), 'userId');
    if (!userId) {
      await redis.zrem(k.reservations, trackingId); // orphan index entry: record already gone
      continue;
    }
    const outcome = await cancelReserved(redis, { productId, trackingId, userId, onlyIfExpired: true });
    if (outcome === 'CANCELLED') {
      cancelled += 1;
      log?.warn({ trackingId }, 'expired reservation cancelled; unit returned');
    }
  }
  return cancelled;
}
