import { z } from 'zod';

const bool = (def) =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

const emptyToUndefined = (v) => (v === '' ? undefined : v);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_ACCESS: bool('true'),
  SERVICE_NAME: z.string().min(1).default('api'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  PRODUCT_ID: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes only')
    .default('phone-x'),
  PRODUCT_NAME: z.string().min(1).max(100).default('Phoenix X Smartphone'),
  PRODUCT_PRICE_CENTS: z.coerce.number().int().min(0).default(49900),
  SALE_STOCK: z.coerce.number().int().min(1).default(500),
  SALE_START_DELAY_SECONDS: z.coerce.number().int().min(0).default(60),
  SALE_START_AT: z.preprocess(emptyToUndefined, z.string().datetime({ offset: true }).optional()),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),

  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  COOKIE_SECURE: bool('false'),

  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  POSTGRES_USER: z.string().default('flash'),
  POSTGRES_PASSWORD: z.string().default('flash_pw'),
  POSTGRES_DB: z.string().default('flashsale'),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  REDIS_PORT: z.coerce.number().int().default(6379),

  // RabbitMQ. Inside Compose, RABBITMQ_URL is set explicitly (built from RABBITMQ_USER/PASSWORD).
  RABBITMQ_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  RABBITMQ_USER: z.string().default('flash'),
  RABBITMQ_PASSWORD: z.string().default('flash_pw'),
  RABBITMQ_PORT: z.coerce.number().int().default(5672),
  PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(100).default(3000),

  // Worker tuning (defaults are fine for the assessment; no Compose wiring needed).
  WORKER_PREFETCH: z.coerce.number().int().min(1).max(200).default(10),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
}
const e = parsed.data;

// Defaults point at localhost so scripts/tests run from WSL work against the ports Compose publishes.
// Inside Compose, DATABASE_URL and REDIS_URL are always set explicitly.
const databaseUrl =
  e.DATABASE_URL ??
  `postgres://${encodeURIComponent(e.POSTGRES_USER)}:${encodeURIComponent(e.POSTGRES_PASSWORD)}@127.0.0.1:${e.POSTGRES_PORT}/${e.POSTGRES_DB}`;

export const config = Object.freeze({
  env: e.NODE_ENV,
  isProd: e.NODE_ENV === 'production',
  logLevel: e.LOG_LEVEL,
  logAccess: e.LOG_ACCESS,
  serviceName: e.SERVICE_NAME,
  port: e.PORT,

  productId: e.PRODUCT_ID,
  productName: e.PRODUCT_NAME,
  productPriceCents: e.PRODUCT_PRICE_CENTS,
  currency: 'USD',
  saleStock: e.SALE_STOCK,
  saleStartDelaySeconds: e.SALE_START_DELAY_SECONDS,
  saleStartAt: e.SALE_START_AT,
  reservationTtlSeconds: e.RESERVATION_TTL_SECONDS,

  sessionSecret: e.SESSION_SECRET,
  sessionCookieName: 'fs_session',
  sessionMaxAgeSeconds: 24 * 60 * 60,
  cookieSecure: e.COOKIE_SECURE,

  databaseUrl,
  pgPoolMax: e.PG_POOL_MAX,
  redisUrl: e.REDIS_URL ?? `redis://127.0.0.1:${e.REDIS_PORT}`,

  rabbitmqUrl:
    e.RABBITMQ_URL ??
    `amqp://${encodeURIComponent(e.RABBITMQ_USER)}:${encodeURIComponent(e.RABBITMQ_PASSWORD)}@127.0.0.1:${e.RABBITMQ_PORT}`,
  publishTimeoutMs: e.PUBLISH_TIMEOUT_MS,

  workerPrefetch: e.WORKER_PREFETCH,
  workerMaxAttempts: e.WORKER_MAX_ATTEMPTS,
  reconcileIntervalMs: e.RECONCILE_INTERVAL_MS,
});