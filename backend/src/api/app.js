import express from 'express';
import pinoHttp from 'pino-http';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { originGuard } from './middleware/originGuard.js';
import { requestId } from './middleware/requestId.js';
import { sessionMiddleware } from './middleware/session.js';
import { checkoutRouter } from './routes/checkout.js';
import { healthRouter } from './routes/health.js';
import { saleRouter } from './routes/sale.js';
import { sessionRouter } from './routes/session.js';

export function createApp({ redis, pool, publisher, readinessChecks }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // exactly one proxy hop (NGINX)

  app.use(requestId);
  if (config.logAccess) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => req.id,
        autoLogging: { ignore: (req) => req.url.startsWith('/api/health') },
        customLogLevel: (req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        serializers: {
          req: (req) => ({ id: req.id, method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(originGuard);
  app.use(express.json({ limit: '2kb' }));
  app.use(sessionMiddleware);

  app.use('/api/health', healthRouter({ checks: readinessChecks }));
  app.use('/api/session', sessionRouter());
  app.use('/api/sale', saleRouter({ redis }));
  app.use('/api/checkout', checkoutRouter({ redis, pool, publisher }));

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}