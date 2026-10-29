-- Give one unit back to the admission counter, at most once per attempt.
-- KEYS[1] stock counter, KEYS[2] tracking hash, KEYS[3] per-user guard, KEYS[4] reservations zset
-- ARGV[1] trackingId
-- ARGV[2] final state to record ('' = delete the record entirely)
-- ARGV[3] retention in seconds for the recorded final state
-- Returns RELEASED or NOOP.
local state = redis.call('HGET', KEYS[2], 'state')
if not state then
  return 'NOOP'
end
-- Only in-flight attempts can be released. CONFIRMED / SOLD_OUT / FAILED / EXPIRED are terminal.
if state ~= 'RESERVED' and state ~= 'QUEUED' and state ~= 'PROCESSING' then
  return 'NOOP'
end

redis.call('INCR', KEYS[1])
redis.call('ZREM', KEYS[4], ARGV[1])
if redis.call('GET', KEYS[3]) == ARGV[1] then
  redis.call('DEL', KEYS[3])
end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[2])
else
  redis.call('HSET', KEYS[2], 'state', ARGV[2])
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
end
return 'RELEASED'