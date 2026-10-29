import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sign(secret, userId) {
  return crypto.createHmac('sha256', secret).update(`session:${userId}`).digest('base64url');
}

export function issueSessionToken(secret, userId = crypto.randomUUID()) {
  return { userId, token: `${userId}.${sign(secret, userId)}` };
}

/** Returns the userId if the token is authentic, otherwise null. */
export function verifySessionToken(secret, token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const userId = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!UUID_RE.test(userId)) return null;
  const expected = Buffer.from(sign(secret, userId));
  const given = Buffer.from(signature);
  if (expected.length !== given.length) return null;
  return crypto.timingSafeEqual(expected, given) ? userId : null;
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}