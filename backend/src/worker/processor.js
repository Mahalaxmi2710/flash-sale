import { PermanentJobError } from '../shared/jobs.js';
import { beginProcessing, finalize, release } from '../shared/reservation.js';

const ORDER_COLUMNS = 'order_ref, status, failure_reason';

export async function findOrder(db, trackingId) {
  const { rows } = await db.query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE tracking_id = $1`, [trackingId]);
  return rows[0] ?? null;
}

function insertOrder(client, job, status, failureReason = null) {
  return client.query(
    `INSERT INTO orders (tracking_id, idempotency_key, user_id, product_id, status, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ORDER_COLUMNS}`,
    [job.trackingId, job.idempotencyKey, job.userId, job.productId, status, failureReason],
  );
}

/**
 * The database decision. ONE transaction: decrement stock (only if > 0) and write the order row,
 * both or neither. PostgreSQL is the final authority, whatever Redis admitted.
 *
 * Safe to call any number of times for the same job: a per-tracking-id advisory lock serialises
 * concurrent duplicates, and a second call finds the existing order and changes nothing.
 * Returns { order_ref, status, failure_reason, created }.
 */
export async function decideOrder(pool, job) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Released automatically at COMMIT/ROLLBACK. hashtext() maps the id to the lock's integer key.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [job.trackingId]);

    const existing = await findOrder(client, job.trackingId);
    if (existing) {
      await client.query('COMMIT');
      return { ...existing, created: false };
    }

    // Everything after this savepoint can be undone without abandoning the transaction.
    await client.query('SAVEPOINT decide');
    const stock = await client.query(
      `UPDATE inventory SET stock = stock - 1, updated_at = now()
        WHERE product_id = $1 AND stock > 0
        RETURNING stock`,
      [job.productId],
    );
    const status = stock.rowCount === 1 ? 'CONFIRMED' : 'SOLD_OUT';

    let row;
    try {
      row = (await insertOrder(client, job, status)).rows[0];
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'orders_one_confirmed_per_user') {
        // This user already holds a confirmed unit under another key. Undo the stock decrement
        // (rolling back to the savepoint) and record the attempt as failed.
        await client.query('ROLLBACK TO SAVEPOINT decide');
        row = (await insertOrder(client, job, 'FAILED', 'ALREADY_PURCHASED')).rows[0];
      } else if (err.code === '23503') {
        throw new PermanentJobError(`unknown product ${job.productId}`);
      } else {
        throw err;
      }
    }
    await client.query('COMMIT');
    return { ...row, created: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Mirror a decided order into Redis. Idempotent; safe to repeat after a crash. */
export function syncRedis(redis, job, status) {
  if (status === 'CONFIRMED' || status === 'SOLD_OUT') {
    return finalize(redis, {
      productId: job.productId,
      trackingId: job.trackingId,
      userId: job.userId,
      finalState: status,
    });
  }
  // FAILED: the unit goes back to the admission counter, exactly once (release.lua).
  return release(redis, {
    productId: job.productId,
    trackingId: job.trackingId,
    userId: job.userId,
    finalState: 'FAILED',
  });
}

/**
 * Process one checkout job end to end. Every step is idempotent, so the message can be delivered
 * twice, redelivered after a crash, or retried after a transient error without double effects:
 *
 *   1. order already in PostgreSQL?            -> skip to step 3 (this is a redelivery)
 *   2. Redis RESERVED/QUEUED -> PROCESSING      -> stale job (cancelled/expired) is dropped
 *      PostgreSQL transaction                   -> CONFIRMED | SOLD_OUT | FAILED, committed
 *   3. mirror the outcome into Redis
 *
 * The caller acknowledges the message only after this resolves, i.e. after the commit.
 * Returns { result: 'PROCESSED' | 'DUPLICATE' | 'STALE', status? , redisState? }.
 */
export async function processJob({ pool, redis }, job) {
  let order = await findOrder(pool, job.trackingId);
  let result = 'DUPLICATE';

  if (!order) {
    const begun = await beginProcessing(redis, job);
    if (begun !== 'PROCESSING') {
      // MISSING (cancelled, expired or reset) or already finished by another worker: nothing to do.
      return { result: 'STALE', redisState: begun };
    }
    order = await decideOrder(pool, job);
    if (order.created) result = 'PROCESSED';
  }

  const redisState = await syncRedis(redis, job, order.status);
  return { result, status: order.status, orderRef: order.order_ref, redisState };
}

/**
 * Called when a job is out of retries (or can never succeed), just before it is parked in the
 * dead-letter queue. Makes sure the user is not left waiting: record FAILED and return the unit.
 * Throws if the database or Redis is unreachable, so the message is requeued instead of lost.
 */
export async function failExhausted({ pool, redis }, job, reason) {
  let order = await findOrder(pool, job.trackingId); // throws if the database is down: do not guess
  if (!order) {
    const client = await pool.connect();
    try {
      order = (await insertOrder(client, job, 'FAILED', String(reason).slice(0, 200))).rows[0];
    } catch {
      // Best effort: even without a FAILED row the user must not stay stuck; Redis below decides.
      order = { status: 'FAILED' };
    } finally {
      client.release();
    }
  }
  return syncRedis(redis, job, order.status);
}
