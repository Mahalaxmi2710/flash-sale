-- Cancel an attempt that never became durable (broker publish failed, or the reservation expired).
-- Only a RESERVED attempt can be cancelled: once it is QUEUED or PROCESSING, a message exists and the
-- worker owns the outcome, so this script refuses and reports the current state instead.
-- KEYS[1] stock counter, KEYS[2] tracking hash, KEYS[3] per-user guard, KEYS[4] reservations zset
-- ARGV[1] trackingId, ARGV[2] '1' = only if the reservation deadline has passed, '0' = cancel now
-- Returns CANCELLED | NOT_EXPIRED | MISSING | <current state>
local state = redis.call('HGET', KEYS[2], 'state')
if not state then
  return 'MISSING'
end
if state ~= 'RESERVED' then
  return state
end
if ARGV[2] == '1' then
  local t = redis.call('TIME')
  local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  local expiresAt = tonumber(redis.call('ZSCORE', KEYS[4], ARGV[1]))
  if expiresAt and expiresAt > nowMs then
    return 'NOT_EXPIRED'
  end
end

redis.call('INCR', KEYS[1])
redis.call('ZREM', KEYS[4], ARGV[1])
if redis.call('GET', KEYS[3]) == ARGV[1] then
  redis.call('DEL', KEYS[3])
end
-- Delete the record entirely so the same idempotency key can try again.
redis.call('DEL', KEYS[2])
return 'CANCELLED'
