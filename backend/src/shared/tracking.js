import crypto from 'node:crypto';

/**
 * Deterministic tracking reference for one purchase attempt.
 * The same (user, idempotency key) always maps to the same id, so duplicates collapse onto one
 * Redis record and one database row. HMAC keeps ids unguessable for other users.
 */
export function makeTrackingId(secret, userId, idemKey) {
  const digest = crypto.createHmac('sha256', secret).update(`${userId}\n${idemKey}`).digest('hex');
  return `trk_${digest.slice(0, 32)}`;
}

export const TRACKING_ID_PATTERN = /^trk_[0-9a-f]{32}$/;