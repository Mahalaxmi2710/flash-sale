const BASE = '/api';

export class ApiError extends Error {
  constructor(status, code, message, { retryAfterMs = null, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

async function request(path, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal: controller.signal,
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body (e.g. a proxy error page) */
    }

    if (!res.ok) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new ApiError(
        res.status,
        data?.error?.code ?? `HTTP_${res.status}`,
        data?.error?.message ?? res.statusText ?? 'Request failed',
        { retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null, body: data },
      );
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === 'AbortError') throw new ApiError(0, 'TIMEOUT', 'The request timed out.');
    throw new ApiError(0, 'NETWORK', 'Could not reach the server.');
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  createSession: () => request('/session', { method: 'POST' }),
  getSale: () => request('/sale'),
  checkout: (productId, idempotencyKey) =>
    request('/checkout', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: { productId },
      timeoutMs: 10000,
    }),
  getCheckout: (trackingId) => request(`/checkout/${encodeURIComponent(trackingId)}`, { timeoutMs: 5000 }),
};