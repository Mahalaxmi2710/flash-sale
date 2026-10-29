import fs from 'node:fs';
import amqp from 'amqplib';
import { config } from '../shared/config.js';
import { createPool } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { assertTopology, createPublisher, TOPOLOGY } from '../shared/rabbit.js';
import { inventorySnapshot } from '../shared/inventory.js';
import { createRedis } from '../shared/redis.js';
import { createMessageHandler } from './handler.js';
import { failExhausted, processJob } from './processor.js';
import { expireStaleReservations } from './reconciler.js';

const log = logger;
const pool = createPool();
const redis = createRedis('worker');
const publisher = createPublisher();
const deps = { pool, redis };

const handle = createMessageHandler({
  processJob: (job) => processJob(deps, job),
  failExhausted: (job, reason) => failExhausted(deps, job, reason),
  publisher,
  log,
  maxAttempts: config.workerMaxAttempts,
});

async function connectWithRetry() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await amqp.connect(config.rabbitmqUrl);
    } catch (err) {
      if (attempt >= 15) throw err;
      log.warn({ attempt, err: err.message }, 'rabbitmq not reachable yet; retrying');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const connection = await connectWithRetry();
const channel = await connection.createChannel();
await assertTopology(channel);
// At most this many unacknowledged messages at once: bounds concurrency and database load.
await channel.prefetch(config.workerPrefetch);

let shuttingDown = false;
const inFlight = new Set();

connection.on('error', (err) => log.error({ err: err.message }, 'rabbitmq connection error'));
connection.on('close', () => {
  if (shuttingDown) return;
  // Unacked messages are redelivered by the broker. Exit so Docker restarts us with a fresh connection.
  log.error('rabbitmq connection closed unexpectedly; exiting');
  process.exit(1);
});

const { consumerTag } = await channel.consume(
  TOPOLOGY.queue,
  (msg) => {
    if (!msg) return; // consumer cancelled by the broker
    const work = handle(channel, msg)
      .catch((err) => log.error({ err }, 'unexpected error in message handler'))
      .finally(() => inFlight.delete(work));
    inFlight.add(work);
  },
  { noAck: false }, // manual acknowledgements
);
log.info({ queue: TOPOLOGY.queue, prefetch: config.workerPrefetch }, 'worker consuming');

// Liveness for the Docker healthcheck: proves the event loop is running while we are consuming.
const heartbeat = () => fs.writeFile('/tmp/worker.alive', String(Date.now()), () => {});
heartbeat();
const heartbeatTimer = setInterval(heartbeat, 10_000);

// Periodic housekeeping: return units held by reservations that never reached the broker.
let reconciling = false;
const reconcileTimer = setInterval(async () => {
  if (reconciling || shuttingDown) return;
  reconciling = true;
  try {
    await expireStaleReservations(redis, { productId: config.productId, log });
  } catch (err) {
    log.error({ err: err.message }, 'reconcile run failed');
  } finally {
    reconciling = false;
  }
}, config.reconcileIntervalMs);

// Read-only drift check once a minute: a violated invariant is logged loudly (alert on level=error).
const driftTimer = setInterval(async () => {
  try {
    const snap = await inventorySnapshot({ pool, redis, productId: config.productId });
    if (!snap.ok) log.error({ problems: snap.problems, snap }, 'INVENTORY INVARIANT VIOLATED');
    else if (!snap.inSync) log.warn({ warnings: snap.warnings }, 'redis stock counter drift (safe; run npm run reconcile:apply when idle)');
  } catch (err) {
    log.warn({ err: err.message }, 'inventory check failed');
  }
}, 60_000);
driftTimer.unref();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'worker shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  clearInterval(reconcileTimer);
  clearInterval(heartbeatTimer);
  try {
    await channel.cancel(consumerTag); // stop receiving new messages
    await Promise.allSettled([...inFlight]); // let current jobs finish and acknowledge
    await channel.close();
    await connection.close();
    await publisher.close();
    await redis.quit();
    await pool.end();
  } catch (err) {
    log.error({ err }, 'error during shutdown');
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
