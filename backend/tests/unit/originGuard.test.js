import { describe, expect, it } from 'vitest';
import { originGuard } from '../../src/api/middleware/originGuard.js';

const run = (method, headers) => {
  let result = 'unset';
  originGuard({ method, get: (name) => headers[name.toLowerCase()] }, {}, (err) => {
    result = err ? err.code : 'allowed';
  });
  return result;
};

describe('originGuard', () => {
  it('allows safe methods and requests without an Origin header (curl, k6, same-origin fetch)', () => {
    expect(run('GET', { origin: 'https://evil.example', host: 'shop.test' })).toBe('allowed');
    expect(run('POST', { host: 'shop.test' })).toBe('allowed');
  });

  it('allows a POST whose Origin matches the Host (including the port)', () => {
    expect(run('POST', { origin: 'http://localhost:8081', host: 'localhost:8081' })).toBe('allowed');
  });

  it('rejects a cross-site or malformed Origin on a state-changing request', () => {
    expect(run('POST', { origin: 'https://evil.example', host: 'shop.test' })).toBe('BAD_ORIGIN');
    expect(run('POST', { origin: 'http://localhost:9999', host: 'localhost:8081' })).toBe('BAD_ORIGIN');
    expect(run('POST', { origin: 'null', host: 'shop.test' })).toBe('BAD_ORIGIN');
  });
});
