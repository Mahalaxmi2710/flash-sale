import express from 'express';
import { z } from 'zod';
import { config } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import { TRACKING_ID_PATTERN } from '../../shared/tracking.js';
import { requireSession } from '../middleware/session.js';
import { submitCheckout } from '../services/checkoutService.js';
import { getCheckoutStatus } from '../services/statusService.js';

const idempotencyKeySchema = z.string().uuid();
const bodySchema = z.object({ productId: z.string().min(1).max(64) }).strict();

/**
 * POST /api/checkout          reserve in Redis, queue durably in RabbitMQ -> 202 (see checkoutService.js)
 * GET  /api/checkout/:trackingId   current status of one attempt (see statusService.js)
 */
export function checkoutRouter({ redis, pool, publisher }) {
  const router = express.Router();

  router.post('/', requireSession, async (req, res) => {
    const key = idempotencyKeySchema.safeParse(req.get('Idempotency-Key'));
    if (!key.success) {
      throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'The Idempotency-Key header must be a UUID.');
    }
    const body = bodySchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(400, 'INVALID_REQUEST', 'Body must be {"productId": "<id>"}.');
    }
    if (body.data.productId !== config.productId) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Unknown product.');
    }

    const out = await submitCheckout({
      redis,
      publisher,
      userId: req.userId,
      idemKey: key.data,
      requestId: req.id,
      log: req.log,
    });
    res.set(out.headers).status(out.status).json(out.body);
  });

  router.get('/:trackingId', requireSession, async (req, res) => {
    if (!TRACKING_ID_PATTERN.test(req.params.trackingId)) {
      throw new AppError(400, 'INVALID_TRACKING_ID', 'The tracking reference is not valid.');
    }
    const body = await getCheckoutStatus({
      redis,
      pool,
      userId: req.userId,
      trackingId: req.params.trackingId,
      log: req.log,
    });
    res.json(body);
  });

  return router;
}
