// k6 flash-sale scenario: every iteration is a NEW buyer (own cookie jar, own idempotency key) who
// opens a session, presses "Buy" once, then polls the status until a final answer (or gives up).
//
//   npm run loadtest                                   (runs grafana/k6 in Docker against http://localhost:8081)
//   PEAK_RPS=1000 HOLD=20s npm run loadtest
//   BASE_URL=http://host.docker.internal:8081 ...      (default inside the k6 container)
//
// Before running:  npm run reset-sale -- --start-in=30   (fresh sale)  and raise the per-IP rate limits,
// because k6 comes from ONE IP (see README, "Rate limiting"):
//   NGINX_RATE_CHECKOUT=100000r/s NGINX_RATE_STATUS=100000r/s NGINX_RATE_API=100000r/s \
//   NGINX_BURST_CHECKOUT=100000 NGINX_BURST_STATUS=100000 NGINX_BURST_API=100000 NGINX_MAX_CONN_PER_IP=100000 npm run up
// After the run:  npm run reconcile   (PostgreSQL stock + confirmed orders must equal the initial stock)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:8081';
const PEAK_RPS = Number(__ENV.PEAK_RPS || 500); // new buyers per second at the peak
const RAMP = __ENV.RAMP || '3s';
const HOLD = __ENV.HOLD || '10s';
const POLL = (__ENV.POLL || 'true') === 'true';
const MAX_POLLS = Number(__ENV.MAX_POLLS || 30);

// 409 (sold out / not started) and 429 (rate limited) are expected business/edge answers, not failures.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409, 429));

const accepted = new Counter('checkout_accepted_202');
const soldOut = new Counter('checkout_sold_out_409');
const limited = new Counter('checkout_rate_limited_429');
const serverErrors = new Counter('checkout_5xx');
const confirmed = new Counter('orders_confirmed');
const failedOrders = new Counter('orders_failed_or_sold_out');
const unfinished = new Counter('orders_unfinished_after_polling');
const checkoutLatency = new Trend('checkout_latency', true);
const acceptedRate = new Rate('accepted_rate');

export const options = {
  scenarios: {
    flash_sale: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 200),
      maxVUs: Number(__ENV.MAX_VUS || 3000),
      stages: [
        { duration: RAMP, target: PEAK_RPS },
        { duration: HOLD, target: PEAK_RPS },
        { duration: '2s', target: 0 },
      ],
    },
  },
  thresholds: {
    checkout_5xx: ['count==0'], // the system must degrade with 409/429, never with 5xx
    checkout_latency: ['p(95)<800'], // POST /api/checkout (reserve + durable queue confirm)
    http_req_duration: ['p(99)<2000'],
  },
};

// Wait for the sale to open so the whole crowd arrives at the same moment.
export function setup() {
  for (let i = 0; i < 120; i += 1) {
    const res = http.get(`${BASE}/api/sale`);
    if (res.status === 200 && res.json('status') !== 'UPCOMING') return { status: res.json('status') };
    sleep(1);
  }
  throw new Error('sale did not start within 120 s; run: npm run reset-sale -- --start-in=30');
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function () {
  const jar = new http.CookieJar(); // a distinct anonymous user per iteration
  const json = { headers: { 'Content-Type': 'application/json' }, jar };

  const session = http.post(`${BASE}/api/session`, null, { jar, tags: { name: 'session' } });
  if (session.status === 429) return void limited.add(1);
  if (!check(session, { 'session 200': (r) => r.status === 200 })) return void (session.status >= 500 && serverErrors.add(1));

  const res = http.post(`${BASE}/api/checkout`, JSON.stringify({ productId: 'phone-x' }), {
    ...json,
    headers: { ...json.headers, 'Idempotency-Key': uuid() },
    tags: { name: 'checkout' },
  });
  checkoutLatency.add(res.timings.duration);
  acceptedRate.add(res.status === 202);

  if (res.status >= 500) return void serverErrors.add(1);
  if (res.status === 429) return void limited.add(1);
  if (res.status === 409) return void soldOut.add(1);
  if (!check(res, { 'checkout 202': (r) => r.status === 202 })) return;
  accepted.add(1);
  if (!POLL) return;

  const trackingId = res.json('trackingId');
  for (let i = 0; i < MAX_POLLS; i += 1) {
    sleep(1);
    const st = http.get(`${BASE}/api/checkout/${trackingId}`, { jar, tags: { name: 'status' } });
    if (st.status >= 500) serverErrors.add(1);
    if (st.status !== 200) continue;
    const state = st.json('state');
    if (state === 'CONFIRMED') return void confirmed.add(1);
    if (state === 'SOLD_OUT' || state === 'FAILED') return void failedOrders.add(1);
  }
  unfinished.add(1);
}
