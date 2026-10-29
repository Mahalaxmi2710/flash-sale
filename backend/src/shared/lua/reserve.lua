-- Atomic admission. Runs as one indivisible step inside Redis.
-- KEYS[1] stock counter
-- KEYS[2] sale hash (field: startsAt, epoch ms)
-- KEYS[3] tracking hash for this attempt
-- KEYS[4] per-user guard (value = trackingId holding the unit)
-- KEYS[5] reservations zset (score = reservation expiry, epoch ms)
-- ARGV[1] trackingId, ARGV[2] userId, ARGV[3] reservation ttl in ms
-- Returns {code, detail}

-- Idempotency: same attempt seen before -> report its current state, consume nothing.
local existing = redis.call('HGET', KEYS[3], 'state')
if existing then
  return {'DUPLICATE', existing}
end

-- Use the Redis clock so every API replica agrees on "now".
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local startsAt = tonumber(redis.call('HGET', KEYS[2], 'startsAt'))
if not startsAt then
  return {'SALE_NOT_CONFIGURED'}
end
if nowMs < startsAt then
  return {'NOT_STARTED', tostring(startsAt - nowMs)}
end

-- One unit per user.
local holder = redis.call('GET', KEYS[4])
if holder then
  return {'ALREADY_PURCHASED', holder}
end

local stock = tonumber(redis.call('GET', KEYS[1]))
if (not stock) or stock <= 0 then
  return {'SOLD_OUT'}
end

redis.call('DECR', KEYS[1])
redis.call('HSET', KEYS[3], 'state', 'RESERVED', 'userId', ARGV[2], 'createdAt', tostring(nowMs))
redis.call('SET', KEYS[4], ARGV[1])
redis.call('ZADD', KEYS[5], nowMs + tonumber(ARGV[3]), ARGV[1])
return {'RESERVED'}