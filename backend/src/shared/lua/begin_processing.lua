-- Worker picked up a job: RESERVED/QUEUED -> PROCESSING. Idempotent for redeliveries.
-- KEYS[1] tracking hash, KEYS[2] reservations zset, ARGV[1] trackingId
-- Returns PROCESSING when the worker should go ahead (newly moved, or already PROCESSING),
-- MISSING when the record no longer exists (cancelled/expired/reset), or the current terminal state.
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return 'MISSING'
end
if state == 'RESERVED' or state == 'QUEUED' then
  redis.call('HSET', KEYS[1], 'state', 'PROCESSING')
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 'PROCESSING'
end
return state
