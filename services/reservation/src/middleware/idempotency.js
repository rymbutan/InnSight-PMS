// Redis-backed idempotency for POST endpoints.
// Survives restarts and works across replicas.
//
// Behavior:
//   - Client sends `Idempotency-Key: <uuid>` (frontend axios interceptor adds one).
//   - First request: we set a short "in-flight" lock, run the handler, then
//     cache the response body+status under the key for 24h.
//   - Replay: any subsequent request with the same key returns the cached
//     response with `Idempotent-Replay: true`.
//   - In-flight collision: the second request waits up to 5s, then 409s.

const Redis = require('ioredis');

const TTL_SECONDS = 24 * 60 * 60; // cache replays for 24h
const LOCK_SECONDS = 30; // longest a handler is allowed to run
const KEY_PREFIX = 'idem:';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('error', (err) => console.error('[idempotency] redis error:', err.message));

function idempotency(req, res, next) {
  if (req.method !== 'POST') return next();
  const key = req.get('Idempotency-Key');
  if (!key) return next();

  // Scope the key so a client-chosen (or guessed/colliding) Idempotency-Key
  // cannot replay another user's — or another service's/route's — cached
  // response. All services share one Redis DB and the `idem:` prefix, so we
  // namespace by service, authenticated user, and method+path.
  const ns = process.env.SERVICE_NAME || process.env.PORT || 'svc';
  const user = req.user?.sub || 'anon';
  const route = `${req.method}:${req.baseUrl || ''}${req.path}`;
  const scope = `${ns}:${user}:${route}:${key}`;
  const cacheKey = KEY_PREFIX + scope;
  const lockKey = KEY_PREFIX + 'lock:' + scope;

  (async () => {
    try {
      // Replay path
      const cached = await redis.get(cacheKey);
      if (cached) {
        const { status, body } = JSON.parse(cached);
        res.set('Idempotent-Replay', 'true');
        return res.status(status).json(body);
      }

      // Try to acquire the lock
      const ok = await redis.set(lockKey, '1', 'NX', 'EX', LOCK_SECONDS);
      if (!ok) {
        // Another request is currently running; wait briefly then check again.
        await new Promise((r) => setTimeout(r, 250));
        const retry = await redis.get(cacheKey);
        if (retry) {
          const { status, body } = JSON.parse(retry);
          res.set('Idempotent-Replay', 'true');
          return res.status(status).json(body);
        }
        return res.status(409).json({ error: 'Idempotent request already in progress.' });
      }

      // Wrap res.json to cache the response on successful completion.
      const origJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          redis
            .set(cacheKey, JSON.stringify({ status: res.statusCode, body }), 'EX', TTL_SECONDS)
            .catch(() => {});
        }
        redis.del(lockKey).catch(() => {});
        return origJson(body);
      };
      // Make sure we release the lock even on errors.
      res.on('finish', () => {
        redis.del(lockKey).catch(() => {});
      });

      next();
    } catch (e) {
      // If Redis is down, don't block traffic — just log and continue without idempotency.
      console.error('[idempotency] passthrough due to error:', e.message);
      next();
    }
  })();
}

module.exports = { idempotency };
