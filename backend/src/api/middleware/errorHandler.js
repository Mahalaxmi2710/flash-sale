import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

export function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', 'Route not found.'));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Unexpected error.';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
    if (err.headers) {
      for (const [name, value] of Object.entries(err.headers)) res.set(name, value);
    }
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Request body is not valid JSON.';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large.';
  } else {
    (req.log ?? logger).error({ err }, 'unhandled error');
  }

  res.status(status).json({ error: { code, message, requestId: req.id, ...details } });
}