import { config } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import { parseCookies, verifySessionToken } from '../../shared/session.js';

/** Sets req.userId when a valid signed session cookie is present; never rejects. */
export function sessionMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  req.userId = verifySessionToken(config.sessionSecret, cookies[config.sessionCookieName]);
  next();
}

export function requireSession(req, res, next) {
  if (!req.userId) {
    return next(new AppError(401, 'SESSION_REQUIRED', 'Start a session first (POST /api/session).'));
  }
  next();
}