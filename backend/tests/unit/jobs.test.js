import { describe, expect, it } from 'vitest';
import { makeJob, parseJob, PermanentJobError } from '../../src/shared/jobs.js';
import { makeTrackingId } from '../../src/shared/tracking.js';

const secret = 'unit-test-secret-0123456789';
const valid = () =>
  makeJob({
    trackingId: makeTrackingId(secret, 'user-1', 'key-1'),
    userId: 'user-1',
    productId: 'phone-x',
    idempotencyKey: 'key-1',
  });

describe('parseJob', () => {
  it('round-trips a valid job', () => {
    const job = valid();
    expect(parseJob(Buffer.from(JSON.stringify(job)))).toEqual(job);
  });

  it('rejects malformed JSON as a permanent error', () => {
    expect(() => parseJob(Buffer.from('{not json'))).toThrow(PermanentJobError);
  });

  it('rejects jobs with a bad tracking id, wrong version or missing fields', () => {
    for (const bad of [
      { ...valid(), trackingId: 'nope' },
      { ...valid(), v: 2 },
      { ...valid(), userId: undefined },
      { ...valid(), createdAt: 'yesterday' },
    ]) {
      expect(() => parseJob(Buffer.from(JSON.stringify(bad)))).toThrow(PermanentJobError);
    }
  });
});
