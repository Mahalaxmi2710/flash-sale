import { describe, expect, it } from 'vitest';
import { makeTrackingId, TRACKING_ID_PATTERN } from '../../src/shared/tracking.js';

describe('makeTrackingId', () => {
  const secret = 'unit-test-secret-0123456789';

  it('is deterministic for the same user and idempotency key', () => {
    expect(makeTrackingId(secret, 'user-1', 'key-1')).toBe(makeTrackingId(secret, 'user-1', 'key-1'));
  });

  it('differs per user, per key and per secret', () => {
    const base = makeTrackingId(secret, 'user-1', 'key-1');
    expect(makeTrackingId(secret, 'user-2', 'key-1')).not.toBe(base);
    expect(makeTrackingId(secret, 'user-1', 'key-2')).not.toBe(base);
    expect(makeTrackingId('another-secret-0123456789', 'user-1', 'key-1')).not.toBe(base);
  });

  it('has the documented shape', () => {
    expect(makeTrackingId(secret, 'user-1', 'key-1')).toMatch(TRACKING_ID_PATTERN);
  });
});