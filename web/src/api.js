import axios from 'axios';
import { chatDockStoreKey, notifsStoreKey } from './lib/messageStorageKeys';

// API_BASE is intentionally empty by default. That makes the frontend issue
// requests to the *same origin it was loaded from* (e.g. `/api/auth/login`
// against `http://localhost:5180`).
//
// In production that origin IS the gateway: nginx serves this bundle at `/` and
// handles `/api/*` itself, so there is no proxy hop at all. Under a host-run
// `npm run dev` the Vite dev server proxies `/api` onward instead (see
// vite.config.js). Either way the browser talks to exactly one origin, which is
// what kills the recurring "network error" class of bugs:
//   - works whether you open the app via localhost, an IP, a hostname, or a tunnel
//   - works on any port the dev server is running on
//   - no CORS preflight needed (same-origin)
//   - no port conflicts with other projects
//
// If you genuinely need to point at a different backend (e.g. a deployed
// gateway), set VITE_API_URL=http://example.com — it overrides this default.
export const API_BASE = import.meta.env.VITE_API_URL || '';

const api = axios.create({ baseURL: API_BASE, timeout: 15000 });

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Slow-connection watch. When any request has been in flight longer than
// SLOW_AFTER_MS the UI is told (once) via a window event; it is told again when
// nothing is pending any more. Toast.jsx turns those into a "connection is
// slow" notice, so a bad network reads as a slow network instead of a failure.
const SLOW_AFTER_MS = 5000;
let inFlight = 0;
const slowTimers = new Map();
let slowShown = false;

function startSlowWatch(config) {
  inFlight += 1;
  const t = setTimeout(() => {
    if (!slowShown) {
      slowShown = true;
      window.dispatchEvent(new CustomEvent('innsight:slow-connection', { detail: { slow: true } }));
    }
  }, SLOW_AFTER_MS);
  slowTimers.set(config, t);
}

function endSlowWatch(config) {
  const t = slowTimers.get(config);
  if (t === undefined) return;
  clearTimeout(t);
  slowTimers.delete(config);
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0 && slowShown) {
    slowShown = false;
    window.dispatchEvent(new CustomEvent('innsight:slow-connection', { detail: { slow: false } }));
  }
}

api.interceptors.request.use((config) => {
  startSlowWatch(config);
  const token = localStorage.getItem('innsight_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if ((config.method || '').toLowerCase() === 'post' && !config.headers['Idempotency-Key']) {
    config.headers['Idempotency-Key'] = uuid();
  }
  return config;
});

api.interceptors.response.use(
  (r) => {
    endSlowWatch(r.config);
    return r;
  },
  (err) => {
    if (err.config) endSlowWatch(err.config);
    // Auth: drop session and redirect to login on 401
    if (err.response?.status === 401) {
      // Same cleanup as auth.jsx's logout() and for the same reason: these two
      // keys are scoped per user so they never leak to the NEXT signed-in
      // account, but nothing ever purged the CURRENT user's own copy, so it sat
      // in localStorage after every sign-out (or, here, forced sign-out on an
      // expired/revoked token) until the same account logged back in and it
      // silently reappeared. Read the id before innsight_user is removed below.
      try {
        const prevUser = JSON.parse(localStorage.getItem('innsight_user') || 'null');
        if (prevUser?.id) {
          localStorage.removeItem(chatDockStoreKey(prevUser.id));
          localStorage.removeItem(notifsStoreKey(prevUser.id));
        }
      } catch {
        /* malformed stored user — nothing to key the cleanup on, skip it */
      }
      localStorage.removeItem('innsight_token');
      localStorage.removeItem('innsight_user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    // Rate limited at the gateway. Say so, because the previous behaviour was to
    // surface nginx's bare status and let the user conclude the stack was down —
    // the gateway used to answer with 503, which reads exactly like an outage.
    if (err.response?.status === 429) {
      err.message = 'Too many requests right now — the gateway is throttling. Wait a few seconds and retry.';
    }
    // No response at all: tell a slow link, a dropped link and a down backend
    // apart, since each needs a different reaction from the user.
    if (!err.response) {
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(err.message || '')) {
        err.message = 'Your connection is slow and the request took too long. Please try again in a moment.';
      } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        err.message = "You're offline. Check your internet connection and try again.";
      } else if (err.code === 'ERR_NETWORK' || err.message === 'Network Error') {
        err.message =
          "Can't reach the server. Your connection may be unstable. Check your internet and try again. (Tried: " +
          (API_BASE || window.location.origin) +
          '/api)';
      }
    }
    return Promise.reject(err);
  }
);

// Lightweight backend-reachable check used by the login screen.
export async function pingBackend() {
  try {
    const r = await fetch((API_BASE || '') + '/api/auth/login', { method: 'OPTIONS' });
    // Any HTTP response (even 405/404) means the gateway answered, so the
    // network path is healthy. Only a thrown error counts as "down".
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default api;
