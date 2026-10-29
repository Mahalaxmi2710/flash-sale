import express from 'express';
import { logger } from '../../shared/logger.js';
import { withTimeout } from '../../shared/util.js';

/**
 * /live  : the process is up (used by Docker healthcheck).
 * /ready : dependencies answer (used to decide whether to send traffic).
 * `checks` is { name: () => Promise }.
 */
export function healthRouter({ checks }) {
  const router = express.Router();

  router.get('/live', (req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (req, res) => {
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        const started = Date.now();
        try {
          await withTimeout(check(), 1500, name);
          return [name, { ok: true, ms: Date.now() - started }];
        } catch (err) {
          logger.warn({ check: name, err: err.message }, 'readiness check failed');
          return [name, { ok: false, ms: Date.now() - started }];
        }
      }),
    );
    const ready = entries.every(([, result]) => result.ok);
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      checks: Object.fromEntries(entries),
    });
  });

  return router;
}