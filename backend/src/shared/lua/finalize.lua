-- Record the database's decision in Redis for CONFIRMED or SOLD_OUT. (FAILED uses release.lua,
-- because a failed attempt must also give its unit back to the admission counter.)
-- KEYS[1] stock counter, KEYS[2] tracking hash, KEYS[3] per-user guard, KEYS[4] reservations zset
-- ARGV[1] trackingId, ARGV[2] final state (CONFIRMED | SOLD_OUT), ARGV[3] retention seconds (SOLD_OUT)
-- Returns the resulting state, or MISSING. Calling it again after a terminal state changes nothing.
local state = redis.call('HGET', KEYS[2], 'state')
if not state then
  return 'MISSING'
end
if state ~= 'RESERVED' and state ~= 'QUEUED' and state ~= 'PROCESSING' then
  return state
end

redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('HSET', KEYS[2], 'state', ARGV[2])
if ARGV[2] == 'CONFIRMED' then
  -- The unit stays consumed and the user keeps their guard. No expiry: PostgreSQL is the permanent record.
  redis.call('PERSIST', KEYS[2])
else
  -- SOLD_OUT: PostgreSQL has no stock left, so make the admission counter agree and free the user.
  redis.call('SET', KEYS[1], '0')
  if redis.call('GET', KEYS[3]) == ARGV[1] then
    redis.call('DEL', KEYS[3])
  end
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
end
return ARGV[2]
