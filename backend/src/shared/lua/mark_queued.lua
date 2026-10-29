-- RESERVED -> QUEUED after the broker confirmed the message; removes the reservation from the expiry index.
-- KEYS[1] tracking hash, KEYS[2] reservations zset, ARGV[1] trackingId
-- Returns the resulting state, or MISSING if the record no longer exists.
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return 'MISSING'
end
if state == 'RESERVED' then
  redis.call('HSET', KEYS[1], 'state', 'QUEUED')
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 'QUEUED'
end
-- Already QUEUED / PROCESSING / terminal (or expired): nothing to change, report it.
return state