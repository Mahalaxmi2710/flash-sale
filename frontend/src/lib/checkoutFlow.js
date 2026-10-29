/**
 * The checkout state machine, with no React in it so it can be tested directly.
 *
 * phase:  idle | submitting | queued | processing | confirmed | soldOut | failure
 * Terminal phases: confirmed, soldOut, failure (polling stops there).
 *
 * Idempotency: one key per logical attempt, kept in sessionStorage together with the tracking
 * reference once the server has accepted the attempt. Retries and page reloads reuse it, so the
 * server collapses them onto the same order. The key is discarded only when the attempt ended in a
 * state that allows a fresh try (failure, or the server forgot the attempt).
 */
const COOLDOWN_MS = 1500;
const MAX_COOLDOWN_MS = 30000;
const TERMINAL = new Set(['confirmed', 'soldOut', 'failure']);
const IN_PROGRESS = new Set(['submitting', 'queued', 'processing']);

export const isTerminal = (phase) => TERMINAL.has(phase);

export function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback for non-secure contexts (e.g. http://<LAN-IP>) where randomUUID is unavailable.
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function browserStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function describeError(err) {
  switch (err.code) {
    case 'NETWORK':
      return 'We could not reach the server. Check your connection and try again.';
    case 'TIMEOUT':
      return 'The server took too long to answer. Your request is safe to retry.';
    case 'SALE_NOT_STARTED':
      return 'The sale has not started yet. Please wait for the countdown.';
    case 'ALREADY_PURCHASED':
      return 'You already hold a unit of this product.';
    case 'ADMISSION_UNAVAILABLE':
    case 'SALE_UNAVAILABLE':
    case 'QUEUE_UNAVAILABLE':
      return 'The sale system is very busy right now. Please try again in a moment.';
    case 'RATE_LIMITED':
    case 'HTTP_429':
      return 'Too many requests. Please wait a moment and try again.';
    case 'SESSION_REQUIRED':
      return 'Your session expired. Please reload the page.';
    default:
      return err.message || 'Something went wrong. Please try again.';
  }
}

const FAILURE_REASONS = {
  ALREADY_PURCHASED: 'You already hold a unit of this product.',
};

export function createCheckoutFlow({
  api,
  productId,
  storage = browserStorage(),
  uuid = defaultUuid,
  timers = { setTimeout: (...a) => globalThis.setTimeout(...a), clearTimeout: (...a) => globalThis.clearTimeout(...a) },
  now = () => Date.now(),
  pollIntervalMs = 1000,
  maxPollIntervalMs = 5000,
  maxPollMs = 90_000, // after this we stop hammering the server and let the user press "check again"
} = {}) {
  const storageKey = `fs.attempt.${productId}`;
  let state = { phase: 'idle', trackingId: null, orderRef: null, error: null, stalled: false, cooldown: false };
  let attempt = null; // { key, trackingId }
  let inFlight = false; // synchronous duplicate-click guard (React state updates are asynchronous)
  let disposed = false;
  let pollTimer = null;
  let cooldownTimer = null;
  let pollStartedAt = 0;
  let pollDelay = pollIntervalMs;
  const listeners = new Set();

  const emit = () => listeners.forEach((fn) => fn(state));
  const set = (patch) => {
    state = { ...state, ...patch };
    emit();
  };

  function loadAttempt() {
    try {
      const raw = storage?.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed.key === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  function saveAttempt() {
    try {
      if (attempt) storage?.setItem(storageKey, JSON.stringify(attempt));
      else storage?.removeItem(storageKey);
    } catch {
      /* storage unavailable: the in-memory attempt still protects this page view */
    }
  }
  function forgetAttempt() {
    attempt = null;
    saveAttempt();
  }

  function stopPolling() {
    timers.clearTimeout(pollTimer);
    pollTimer = null;
  }
  function startCooldown(ms) {
    timers.clearTimeout(cooldownTimer);
    set({ cooldown: true });
    cooldownTimer = timers.setTimeout(
      () => !disposed && set({ cooldown: false }),
      Math.min(Math.max(ms, COOLDOWN_MS), MAX_COOLDOWN_MS),
    );
  }

  /** Map a server state onto a phase. Returns true when the attempt is finished. */
  function applyServerState(body) {
    const trackingId = body.trackingId ?? attempt?.trackingId ?? state.trackingId;
    switch (body.state) {
      case 'RESERVED':
      case 'QUEUED':
        set({ phase: 'queued', trackingId, error: null, stalled: false });
        return false;
      case 'PROCESSING':
        set({ phase: 'processing', trackingId, error: null, stalled: false });
        return false;
      case 'CONFIRMED':
        set({ phase: 'confirmed', trackingId, orderRef: body.orderRef ?? null, error: null, stalled: false });
        return true;
      case 'SOLD_OUT':
        set({ phase: 'soldOut', trackingId, error: null, stalled: false });
        return true;
      default: {
        // FAILED (or anything unexpected): this attempt is over; the next click starts a fresh one.
        forgetAttempt();
        const message = FAILURE_REASONS[body.reason] ?? 'We could not complete your order. You have not been charged. Please try again.';
        set({ phase: 'failure', trackingId, error: { code: body.reason ?? 'FAILED', message }, stalled: false });
        startCooldown(COOLDOWN_MS);
        return true;
      }
    }
  }

  function schedulePoll(delay) {
    if (disposed) return;
    stopPolling();
    pollTimer = timers.setTimeout(poll, delay);
  }

  async function poll() {
    pollTimer = null;
    if (disposed || !attempt?.trackingId) return;
    try {
      const body = await api.getCheckout(attempt.trackingId);
      if (disposed) return;
      pollDelay = pollIntervalMs;
      if (applyServerState(body)) return; // terminal: stop polling
    } catch (err) {
      if (disposed) return;
      if (err.status === 404) {
        // The server no longer knows this attempt (e.g. the sale was reset). Let the user start over.
        forgetAttempt();
        set({ phase: 'idle', trackingId: null, orderRef: null, error: null, stalled: false });
        return;
      }
      if (err.status === 401) {
        set({ phase: 'failure', error: { code: err.code, message: describeError(err) }, stalled: false });
        return;
      }
      // Network error, timeout, 429, 5xx: keep trying, backing off (honouring Retry-After).
      pollDelay = Math.min(Math.max(pollDelay * 2, err.retryAfterMs ?? 0), maxPollIntervalMs);
    }
    if (now() - pollStartedAt > maxPollMs) {
      set({ stalled: true }); // stop polling; "Check again" restarts it. The order itself is unaffected.
      return;
    }
    schedulePoll(pollDelay);
  }

  function startPolling() {
    pollStartedAt = now();
    pollDelay = pollIntervalMs;
    set({ stalled: false });
    schedulePoll(pollIntervalMs);
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },

    /** Resume an attempt that survived a page reload. */
    start() {
      attempt = loadAttempt();
      if (attempt?.trackingId) {
        set({ phase: 'queued', trackingId: attempt.trackingId });
        startPolling();
      }
    },

    /** "Check again" after a stall. */
    resume() {
      if (disposed || !attempt?.trackingId || isTerminal(state.phase)) return;
      startPolling();
    },

    async submit() {
      if (inFlight || disposed) return; // duplicate-click prevention
      if (IN_PROGRESS.has(state.phase) || state.phase === 'confirmed') return;
      inFlight = true;
      set({ phase: 'submitting', error: null, stalled: false });

      attempt ??= loadAttempt() ?? { key: uuid(), trackingId: null };
      saveAttempt();

      try {
        const res = await api.checkout(productId, attempt.key);
        if (disposed) return;
        attempt.trackingId = res.trackingId;
        saveAttempt();
        if (!applyServerState(res)) startPolling();
      } catch (err) {
        if (disposed) return;
        if (err.code === 'SOLD_OUT') {
          forgetAttempt();
          set({ phase: 'soldOut', trackingId: null, error: null });
        } else if (err.code === 'ALREADY_PURCHASED' && err.body?.error?.trackingId) {
          // The user already has an attempt under another key (e.g. in another tab): follow that one.
          attempt = { key: attempt.key, trackingId: err.body.error.trackingId };
          saveAttempt();
          set({ phase: 'queued', trackingId: attempt.trackingId, error: null });
          startPolling();
        } else {
          // Keep the SAME key: a retry of this attempt must not create a second order.
          set({ phase: 'failure', error: { code: err.code, message: describeError(err) } });
          startCooldown(err.retryAfterMs ?? COOLDOWN_MS);
        }
      } finally {
        inFlight = false;
      }
    },

    dispose() {
      disposed = true;
      stopPolling();
      timers.clearTimeout(cooldownTimer);
      listeners.clear();
    },
  };
}
