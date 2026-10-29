# Flash Sale: 500 phones, 100,000 buyers

A checkout pipeline that never oversells, never double-charges a retry, and never silently loses an accepted order.

**Stack:** React + Vite · Node.js/Express · Redis 7 (Lua) · RabbitMQ 3.13 · PostgreSQL 16 · NGINX · Docker Compose.

> **Honest scope note.** Everything here was designed for the 100k-in-10-seconds scenario, but a laptop cannot prove that capacity. The tests prove *correctness* (no overselling, idempotency, failure recovery). The k6 script measures *your machine*; read [Results](#results) for what was and was not measured.

## Quick start

```bash
cp .env.example .env            # first time only; set SESSION_SECRET (openssl rand -hex 32). Change default passwords.
npm run install:all             # backend + frontend dependencies (adds amqplib, updates package-lock.json)
npm run up                      # build and start everything (migrations run automatically)
npm run reset-sale -- --start-in=20   # fresh sale that starts in 20 s  (destructive: clears orders for the demo product)
```

Open `http://localhost:<HTTP_PORT>` (8081 with your `.env`). RabbitMQ UI: `http://localhost:15672`.
After changing the API image run `docker compose restart nginx` (NGINX resolves `api` at start-up; `npm run up:scaled` does this for you).

| Command | What it does |
|---|---|
| `npm test` | backend (vitest) + frontend (node:test) |
| `npm run test:unit` / `test:integration` | split runs; integration needs `npm run up` (Postgres + Redis on localhost) |
| `npm run simulate -- --users=700` | 700 real buyers hit the API at once (correctness, not performance) |
| `npm run reconcile` | compares PostgreSQL and Redis; exit code 1 if an invariant is broken |
| `npm run reconcile:apply` | also rebuilds the Redis counter from PostgreSQL (only when the queue is idle) |
| `npm run loadtest` | k6 (in Docker) flash-sale scenario |
| `npm run bundle-size` | builds the frontend and checks the 200 KB gzip budget |
| `npm run up:scaled` | 3 API replicas + 2 workers behind NGINX |

## End-to-end check (about 2 minutes)

```bash
npm run reset-sale -- --start-in=10
npm run simulate -- --users=700        # expect: 500 accepted, 200 SOLD_OUT; final states: CONFIRMED 500
npm run reconcile                      # expect: "OK: PostgreSQL and Redis agree; no overselling."
docker compose exec postgres psql -U flash -d flashsale -c \
  "select status, count(*) from orders group by 1; select stock from inventory;"
```
Duplicate-request check: `simulate` sends every user's request twice with the same `Idempotency-Key`; it prints whether each user got one reference.
If you get 429s, your per-IP NGINX limit is working: raise it as described under *Rate limiting*.

## Architecture

```
Browser ──► NGINX ──► API (x N) ──► Redis (Lua)         1. atomic admission + idempotency
 (poll)     rate limit    │                              
            least_conn    └──────► RabbitMQ (durable)   2. persistent message + publisher confirm  ──► 202
                                        │
                                        ▼
                                 Worker (x M) ──► PostgreSQL   3. ONE transaction: stock-1 + order row (final authority)
                                        └──────► Redis         4. mirror outcome for fast status polling
```

**Why three stores.** Redis absorbs the stampede cheaply (a conservative admission counter, not the source of truth). RabbitMQ makes accepted work durable and smooths the load. PostgreSQL is the only place that confirms inventory and orders. Redis, RabbitMQ and PostgreSQL are **not** one distributed transaction. Every hand-off is instead made safe to repeat.

### Request lifecycle

1. `POST /api/checkout` with `Idempotency-Key: <uuid>` (generated once per attempt in the browser, kept in `sessionStorage`).
2. **Redis Lua `reserve`**: same key → returns the existing attempt, consuming nothing; one unit per user; stock `> 0` else `SOLD_OUT`. The tracking id is an HMAC of (user, key), so duplicates always map to the same reference and the same database row.
3. **Publish** a persistent message to a durable queue and wait for the broker's **publisher confirm** (unroutable messages are returned, not dropped).
4. Redis `RESERVED → QUEUED`, then **`202 Accepted`**. `202` is never sent before steps 2-4 succeeded.
5. **Worker** consumes with manual acks: Redis `→ PROCESSING`; PostgreSQL transaction (advisory lock per tracking id → `UPDATE inventory SET stock = stock - 1 WHERE product_id=$1 AND stock > 0` → insert `CONFIRMED` or `SOLD_OUT` order; second purchase by one user hits the unique index, rolls back to a savepoint and records `FAILED`); commit; mirror outcome to Redis; **then ack**.
6. `GET /api/checkout/:trackingId` returns `QUEUED | PROCESSING | CONFIRMED | SOLD_OUT | FAILED` (+ `orderRef`). Redis answers in-flight states; PostgreSQL answers if Redis lost the record. Another user's reference is a 404.

No new migration was needed: PostgreSQL stores only final outcomes (`CONFIRMED`, `SOLD_OUT`, `FAILED`, matching the existing CHECK); in-flight states live in Redis.

### Failure handling

| Failure | What happens |
|---|---|
| Broker down / publish not confirmed | Reservation cancelled atomically (only if still `RESERVED`), stock returned, `503 QUEUE_UNAVAILABLE` + `Retry-After`. Retrying the same key works. |
| Publish confirmed, Redis can't record `QUEUED` | `503`, never a silent `202`. Retry republishes; worker de-duplicates by tracking id. |
| API crashes after reserving | Reconciler (in the worker) cancels reservations past their 30 s deadline and returns the units. |
| Duplicate / redelivered message | Existing order found under the advisory lock → no second decrement. |
| Worker crash before ack | Broker redelivers; processing resumes idempotently. |
| Crash between DB commit and Redis update | Redelivery finds the order and finishes the Redis update. |
| Transient error (DB/Redis blip) | Retry via delay queues (2 s, 10 s, 30 s), max 4 attempts (`WORKER_MAX_ATTEMPTS`). |
| Exhausted / permanent error | Order recorded `FAILED`, unit returned, job parked in `checkout.dead` for inspection. If even that bookkeeping fails, the message is requeued, never dropped. |
| Redis restart losing its last second (AOF `everysec`) | PostgreSQL still decides; worst case a user sees "unknown" and retries. Run `npm run reconcile:apply`. |
| Redis over-admits | Harmless: the DB `stock > 0` guard and the `CHECK (stock >= 0)` constraint make overselling impossible. |

### Frontend

`src/lib/checkoutFlow.js` is a framework-free state machine (idle → submitting → queued → processing → confirmed / soldOut / failure): double-click guard, one idempotency key per attempt (reused for retries and page reloads), polling every second with backoff on errors, stops at a terminal state, a "check again" button after 90 s, 404 means "start over".

## Rate limiting and load balancing

NGINX limits **per client IP** (values come from environment variables, defaults in `docker-compose.yaml`):

| Endpoint | Rate | Burst |
|---|---|---|
| `POST /api/checkout` | 5 r/s | 10 |
| `GET /api/checkout/:id` (polling) | 10 r/s | 20 |
| other `/api/*` | 20 r/s | 40 |
| connections per IP | 100 | |

Excess requests get `429` with JSON `{"error":{"code":"RATE_LIMITED"}}` and `Retry-After: 1`; the UI shows a friendly message. Test it: `sh loadtest/rate-limit-check.sh`.
**Caveats:** many buyers behind one NAT share a limit (raise it for campus/office traffic); Docker Desktop may show every local client as one IP, and so does k6, so **raise the limits for load tests** (see `.env.example`).

Load balancing: `least_conn` across all API replicas (`--scale api=3`), passive health (`max_fails`), keep-alive upstream connections, retries only for safe GETs (a POST is never replayed by NGINX; the client retries it with its idempotency key).

## Security and reliability notes

- Signed HttpOnly SameSite=Lax session cookie (`COOKIE_SECURE=true` behind HTTPS); Origin check on state-changing requests; 2 KB body limit; strict zod validation; CSP and security headers; `X-Forwarded-For` overwritten by NGINX.
- API and worker containers: non-root, read-only filesystem, all capabilities dropped, `no-new-privileges`.
- Redis, PostgreSQL and the RabbitMQ UI are bound to `127.0.0.1`. **Change the default passwords** in `.env` before exposing anything.
- Health: `/api/health/live`, `/api/health/ready` (Redis, PostgreSQL, RabbitMQ), worker heartbeat healthcheck, NGINX `/healthz`.
- Logging: JSON everywhere (pino + NGINX). The API request id travels in the job so `grep <requestId>` follows an order from NGINX through the worker. The worker logs `INVENTORY INVARIANT VIOLATED` at `error` level if PostgreSQL's numbers ever stop adding up.
- Graceful shutdown: the API stops accepting and drains; the worker stops consuming and finishes in-flight jobs before acking and exiting.

## Results

| Item | Status |
|---|---|
| Frontend tests (checkout flow: duplicate clicks, key reuse, polling stop, stall, reload) | **14/14 passed** (run here) |
| Backend unit + integration tests against **real Redis 7 and PostgreSQL 16** (worker logic, Lua, reconciler, checkout/status services) | **82 passed** across 10 files (run here with stand-in `pg`/`ioredis` client libraries speaking to real servers; please re-run with `npm test`) |
| Mutation check (removing the `stock > 0` guard, the duplicate check, or the Redis mirror makes tests fail) | done |
| Inventory reconciliation logic against real Postgres/Redis | verified (clean, drift, lost-unit cases) |
| Bundle size | **about 65 KB gzip** estimated with esbuild (React 19 here; the project pins React 18, slightly smaller). Budget 200 KB. Authoritative number: `npm run bundle-size` |
| **Not run here (no Docker daemon, no npm registry, no RabbitMQ/NGINX/k6 in the authoring sandbox):** real RabbitMQ publish/consume, NGINX config, k6 load test, HTTP route tests (`checkout-api.test.js`), Vite build | **please run on your machine**; paste any failure back |
| Throughput / latency / 100k users | **not measured**. Run `npm run loadtest` and record your numbers here. |

## Limitations

- Capacity at 100k concurrent users is unproven; a single Redis/PostgreSQL/RabbitMQ node and one laptop are the limits. Scale API/worker replicas first; the next bottleneck is PostgreSQL write throughput (one short transaction per confirmed unit, serialised on one inventory row).
- Per-IP rate limiting is coarse (NAT).
- "Zero lost accepted orders" holds while RabbitMQ's disk and PostgreSQL survive: a `202` means the broker confirmed a persistent message on a durable queue (classic queue, single node, no mirroring/quorum). A broker disk loss, or Redis AOF loss, is outside this guarantee; PostgreSQL stays correct and `reconcile` repairs Redis.
- Reservations that never reach the broker are released after 30 s only while a worker is running.
- Redis unavailable means checkout fails closed (503) by design.
- Anonymous sessions: nothing stops one person from opening many sessions; real deployments need accounts or bot protection.
- The dead-letter queue is inspected manually (RabbitMQ UI); there is no alerting.
