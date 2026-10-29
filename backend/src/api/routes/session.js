import express from 'express';
import { config } from '../../shared/config.js';
import { issueSessionToken } from '../../shared/session.js';

export function sessionRouter() {
  const router = express.Router();

  // Idempotent: returns the existing session if the cookie is valid, otherwise mints a new anonymous one.
  router.post('/', (req, res) => {
    if (!req.userId) {
      const { userId, token } = issueSessionToken(config.sessionSecret);
      req.userId = userId;
      res.cookie(config.sessionCookieName, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        path: '/',
        maxAge: config.sessionMaxAgeSeconds * 1000,
      });
    }
    res.json({ ok: true });
  });

  return router;
}