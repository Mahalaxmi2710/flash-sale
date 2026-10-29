import { pathToFileURL } from 'node:url';
import { config } from '../shared/config.js';
import { createPool } from '../shared/db.js';
import { inventorySnapshot, repairRedisStock } from '../shared/inventory.js';
import { createRedis } from '../shared/redis.js';

/**
 * Usage: npm run reconcile            report; exit code 1 if an invariant is violated
 *        npm run reconcile:apply      also rebuild the Redis stock counter from PostgreSQL (when idle)
 */
export async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const pool = createPool({ max: 2 });
  const redis = createRedis('reconcile');
  let exitCode = 0;
  try {
    let snap = await inventorySnapshot({ pool, redis, productId: config.productId });
    console.log(JSON.stringify(snap, null, 2));

    if (apply && snap.warnings.length && snap.ok) {
      const value = await repairRedisStock({ redis, productId: config.productId, snapshot: snap });
      console.log(`\nRedis stock counter set to ${value}.`);
      snap = await inventorySnapshot({ pool, redis, productId: config.productId });
    }

    if (!snap.ok) {
      console.error(`\nFAILED: ${snap.problems.join('; ')}`);
      exitCode = 1;
    } else if (!snap.inSync) {
      console.warn(`\nOK with warnings: ${snap.warnings.join('; ')}${apply ? '' : ' (run "npm run reconcile:apply" when idle)'}`);
    } else {
      console.log('\nOK: PostgreSQL and Redis agree; no overselling.');
    }
  } catch (err) {
    console.error(`reconcile failed: ${err.message}`);
    exitCode = 2;
  } finally {
    await pool.end();
    await redis.quit().catch(() => redis.disconnect());
  }
  process.exitCode = exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
