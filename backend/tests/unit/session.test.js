import { describe, expect, it } from 'vitest';
import { issueSessionToken, parseCookies, verifySessionToken } from '../../src/shared/session.js';

const secret = 'unit-test-secret-0123456789';

describe('session tokens', () => {
  it('round-trips a valid token', () => {
    const { userId, token } = issueSessionToken(secret);
    expect(verifySessionToken(secret, token)).toBe(userId);
  });

  it('rejects a tampered user id', () => {
    const { token } = issueSessionToken(secret);
    const other = issueSessionToken(secret).userId;
    const forged = `${other}.${token.split('.')[1]}`;
    expect(verifySessionToken(secret, forged)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const { token } = issueSessionToken('a-different-secret-0123456789');
    expect(verifySessionToken(secret, token)).toBeNull();
  });

  it('rejects garbage', () => {
    for (const bad of [undefined, null, '', 'abc', '.', 'a.b', 'x'.repeat(500)]) {
      expect(verifySessionToken(secret, bad)).toBeNull();
    }
  });
});

describe('parseCookies', () => {
  it('parses multiple cookies and keeps the first of duplicates', () => {
    const jar = parseCookies('a=1; fs_session=abc.def; a=2');
    expect(jar.a).toBe('1');
    expect(jar.fs_session).toBe('abc.def');
  });

  it('handles empty and malformed input', () => {
    expect(Object.keys(parseCookies(undefined))).toHaveLength(0);
    expect(parseCookies('novalue; =x; ok=1').ok).toBe('1');
  });
});