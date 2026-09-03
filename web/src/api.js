import axios from 'axios';

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

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('innsight_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if ((config.method || '').toLowerCase() === 'post' && !config.headers['Idempotency-Key']) {
    config.headers['Idempotency-Key'] = uuid();
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    // Auth: drop session and redirect to login on 401
    if (err.response?.status === 401) {
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
    // Friendlier message when the backend is unreachable. Axios sets
    // err.code='ERR_NETWORK' for connection refused / DNS / proxy down.
    if (!err.response && (err.code === 'ERR_NETWORK' || err.message === 'Network Error')) {
      err.message =
        'Cannot reach the backend (gateway). Is `docker compose up` running? Tried: ' +
        (API_BASE || window.location.origin) +
        '/api';
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
