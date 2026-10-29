import { AppError } from '../../shared/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for the cookie-authenticated API (in addition to SameSite=Lax and JSON-only bodies):
 * a state-changing request that carries an Origin header must come from the same host it is sent to.
 * Non-browser clients (curl, k6) send no Origin and are unaffected.
 */
export function originGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let originHost = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    /* malformed Origin: rejected below */
  }
  if (originHost !== req.get('host')) {
    return next(new AppError(403, 'BAD_ORIGIN', 'Cross-origin requests are not allowed.'));
  }
  next();
}
