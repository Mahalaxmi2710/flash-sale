import fs from 'node:fs';
import { defineConfig } from 'vitest/config';

// Tests run on the host and reach PostgreSQL/Redis through the ports Compose publishes. Those ports
// live in the project's .env (never committed), so read the few non-secret-looking ones we need from
// it. Real environment variables win over the file.
function readDotEnv() {
  try {
    const text = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}
const dot = readDotEnv();
const pick = (name, fallback) => process.env[name] ?? dot[name] ?? fallback;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
      // The API integration tests use their own product id so they never touch the demo sale.
      PRODUCT_ID: 'test-api-product',
      REDIS_URL: process.env.REDIS_URL ?? `redis://127.0.0.1:${pick('REDIS_PORT', '6379')}`,
      POSTGRES_PORT: pick('POSTGRES_PORT', '5432'),
      POSTGRES_USER: pick('POSTGRES_USER', 'flash'),
      POSTGRES_PASSWORD: pick('POSTGRES_PASSWORD', 'flash_pw'),
      POSTGRES_DB: pick('POSTGRES_DB', 'flashsale'),
    },
  },
});
