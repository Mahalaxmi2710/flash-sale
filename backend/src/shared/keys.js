/**
 * Redis key layout for one product.
 *   stock         integer admission counter (conservative gatekeeper, NOT the source of truth)
 *   sale          hash: startsAt (epoch ms, Redis clock)
 *   reservations  zset: trackingId -> reservation expiry (epoch ms); only RESERVED entries live here
 *   tracking(id)  hash: state, userId, createdAt
 *   user(id)      string: trackingId currently holding this user's unit
 */
export function keys(productId) {
  const p = `fs:${productId}`;
  return {
    stock: `${p}:stock`,
    sale: `${p}:sale`,
    reservations: `${p}:reservations`,
    tracking: (trackingId) => `${p}:trk:${trackingId}`,
    user: (userId) => `${p}:user:${userId}`,
  };
}