import http from 'node:http';
import { config } from '../shared/config.js';
import { createPool } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { createPublisher } from '../shared/rabbit.js';
import { createRedis } from '../shared/redis.js';
import { createApp } from './app.js';

const redis = createRedis('api');
const pool = createPool();
const publisher = createPublisher(); // connects lazily, so the API still starts if RabbitMQ is briefly down

const app = createApp({
  redis,
  pool,
  publisher,
  readinessChecks: {
    redis: () => redis.ping(),
    postgres: () => pool.query('SELECT 1'),
    rabbitmq: () => publisher.ping(),
  },
});

const server = http.createServer(app);
// Keep-alive must outlive NGINX's upstream keepalive (60s) to avoid sporadic 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(config.port, '0.0.0.0', () => {
  logger.info({ port: config.port, env: config.env }, 'api listening');
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    try {
      await publisher.close();
      await redis.quit();
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));