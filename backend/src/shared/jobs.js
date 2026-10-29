import { z } from 'zod';
import { TRACKING_ID_PATTERN } from './tracking.js';

/** A job that can never succeed (malformed message, missing product). Retrying is pointless. */
export class PermanentJobError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

const jobSchema = z.object({
  v: z.literal(1),
  trackingId: z.string().regex(TRACKING_ID_PATTERN),
  userId: z.string().min(1).max(100),
  productId: z.string().min(1).max(64),
  idempotencyKey: z.string().min(1).max(100),
  createdAt: z.number().int(),
  requestId: z.string().max(64).optional(), // correlates worker logs with the API request
});

export function makeJob({ trackingId, userId, productId, idempotencyKey, requestId }) {
  return { v: 1, trackingId, userId, productId, idempotencyKey, createdAt: Date.now(), ...(requestId ? { requestId } : {}) };
}

/** Parse and validate a message body. Throws PermanentJobError for anything unusable. */
export function parseJob(buffer) {
  let raw;
  try {
    raw = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new PermanentJobError('message body is not valid JSON');
  }
  const parsed = jobSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PermanentJobError(`invalid job: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return parsed.data;
}
