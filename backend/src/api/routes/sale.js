import express from 'express';
import { config } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import { keys } from '../../shared/keys.js';

const CACHE_MS = 1000;

export function saleRouter({ redis }) {
  const router = express.Router();
  const k = keys(config.productId);

  // Tiny in-process cache + in-flight de-duplication, so a burst of page loads costs Redis ~1 read/second/replica.
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  async function load() {
    const [[, startsAt], [, stock]] = await redis
      .pipeline()
      .hget(k.sale, 'startsAt')
      .get(k.stock)
      .exec();
    return {
      startsAt: startsAt == null ? null : Number(startsAt),
      soldOut: stock != null && Number(stock) <= 0,
    };
  }

  async function snapshot() {
    const now = Date.now();
    if (cached && now - cachedAt < CACHE_MS) return cached;
    inflight ??= load()
      .then((value) => {
        cached = value;
        cachedAt = Date.now();
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  router.get('/', async (req, res) => {
    let snap;
    try {
      snap = await snapshot();
    } catch (err) {
      (req.log ?? console).error({ err }, 'sale snapshot failed');
      throw new AppError(503, 'SALE_UNAVAILABLE', 'Sale information is temporarily unavailable.', {
        headers: { 'Retry-After': '2' },
      });
    }
    if (snap.startsAt == null) {
      throw new AppError(503, 'SALE_NOT_CONFIGURED', 'The sale has not been configured.');
    }

    const serverTime = Date.now();
    const status = snap.soldOut ? 'SOLD_OUT' : serverTime < snap.startsAt ? 'UPCOMING' : 'LIVE';
    res.json({
      product: {
        id: config.productId,
        name: config.productName,
        priceCents: config.productPriceCents,
        currency: config.currency,
      },
      status,
      startsAt: snap.startsAt,
      serverTime,
    });
  });

  return router;
}