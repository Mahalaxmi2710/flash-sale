// Correctness burst (NOT a performance test; use `npm run loadtest` for that).
// Many distinct users hit the real API at once, then we wait for the worker to finish and print the outcome.
// Usage: npm run simulate -- --users=700 --concurrency=100 --base=http://localhost:8081
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const BASE = arg('base', process.env.BASE_URL ?? 'http://localhost:8081');
const USERS = Number(arg('users', 700));
const CONCURRENCY = Number(arg('concurrency', 100));
const DUPLICATE_RETRIES = Number(arg('duplicates', 1)); // extra identical requests per user (same key)
const WAIT_MS = Number(arg('wait', 60_000));

async function session() {
  const res = await fetch(`${BASE}/api/session`, { method: 'POST' });
  if (!res.ok) throw new Error(`session failed: ${res.status}`);
  return res.headers.getSetCookie()[0].split(';')[0];
}
const call = (cookie, path, init = {}) =>
  fetch(`${BASE}/api${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...init.headers } });

async function buyer() {
  const cookie = await session();
  const key = crypto.randomUUID();
  const attempts = await Promise.all(
    Array.from({ length: 1 + DUPLICATE_RETRIES }, () =>
      call(cookie, '/checkout', { method: 'POST', headers: { 'idempotency-key': key }, body: '{"productId":"phone-x"}' }),
    ),
  );
  const bodies = await Promise.all(attempts.map(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })));
  const accepted = bodies.find((b) => b.status === 202 || b.status === 200);
  return { cookie, bodies, trackingId: accepted?.body.trackingId, sameRef: new Set(bodies.map((b) => b.body.trackingId).filter(Boolean)).size <= 1 };
}

async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const n = i++;
        out[n] = await fn(items[n], n);
      }
    }),
  );
  return out;
}

const started = Date.now();
const results = await pool(Array.from({ length: USERS }), CONCURRENCY, buyer);
console.log(`submitted ${USERS} buyers x ${1 + DUPLICATE_RETRIES} requests in ${Date.now() - started} ms`);

const tally = {};
for (const r of results) for (const b of r.bodies) tally[b.body.error?.code ?? `HTTP_${b.status}`] = (tally[b.body.error?.code ?? `HTTP_${b.status}`] ?? 0) + 1;
console.log('responses:', tally);
console.log('duplicate requests returned one reference per user:', results.every((r) => r.sameRef));

const accepted = results.filter((r) => r.trackingId);
const deadline = Date.now() + WAIT_MS;
const final = {};
await pool(accepted, 50, async (r) => {
  let state = 'UNKNOWN';
  while (Date.now() < deadline) {
    const res = await call(r.cookie, `/checkout/${r.trackingId}`);
    state = (await res.json().catch(() => ({}))).state ?? state;
    if (['CONFIRMED', 'SOLD_OUT', 'FAILED'].includes(state)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  final[state] = (final[state] ?? 0) + 1;
});
console.log('final states of accepted checkouts:', final);
console.log('\nNow run: npm run reconcile   (confirms stock + confirmed == initial, no overselling)');
