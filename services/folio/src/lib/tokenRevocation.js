const Redis = require('ioredis');

// ─────────────────────────────────────────────────────────────────────────────
// Token revocation.
//
// WHAT WAS BROKEN
// ---------------
// `POST /api/auth/logout` published an event and returned `{success:true}`. That is
// all it did. The JWT stayed valid for its full 12-hour TTL, so "logging out" on a
// shared front-desk machine left a working credential in anyone's hands. Same for
// `POST /api/users/:id/disable` — the account was marked DISABLED but its existing
// tokens kept working for up to 12 hours. And because roles are baked into the
// token, a role change also took up to 12 hours to take effect.
//
// TWO MECHANISMS
// --------------
// 1. PER-TOKEN denylist, for logout. Tokens now carry a `jti`; logout writes
//    `revoked:jti:<jti>` with a TTL matching the token's own remaining lifetime, so
//    the key expires exactly when the token would have anyway — the denylist can
//    never grow without bound.
//
// 2. PER-USER epoch, for everything that should kill ALL of a user's sessions at
//    once: disable, password change, role change. `authz:epoch:<userId>` holds a
//    unix timestamp; any token whose `iat` is older is rejected. One write
//    invalidates every outstanding token for that user, including ones we never
//    saw.
//
// FAIL-OPEN, DELIBERATELY
// -----------------------
// If Redis is unreachable these checks are skipped and a warning is logged, so the
// hotel keeps operating. Fail-closed would mean a Redis blip locks every member of
// staff out of the PMS mid-shift, which for a front desk is a worse outcome than a
// revoked token surviving a few minutes longer. This mirrors the stance the
// idempotency middleware already takes. It is a real trade-off, not an oversight:
// if this system ever holds card data, revisit it.
// ─────────────────────────────────────────────────────────────────────────────

const JTI_PREFIX = 'revoked:jti:';
const EPOCH_PREFIX = 'authz:epoch:';

// The epoch is read on every authenticated request, so cache it briefly in-process.
// A 5s window means a revocation takes at most 5s to propagate to every replica —
// far better than 12 hours, and it keeps Redis off the hot path for bursts.
const EPOCH_TTL_MS = 5000;

function createRevocation({
  redisUrl = process.env.REDIS_URL || 'redis://localhost:6379',
  label = 'authz',
} = {}) {
  let redis = null;
  let warned = false;
  const epochCache = new Map(); // userId -> { value, at }

  function client() {
    if (redis) return redis;
    try {
      redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
      redis.on('error', (e) => {
        if (!warned) {
          console.warn(`[${label}] revocation redis unavailable — checks are being SKIPPED:`, e.message);
          warned = true;
        }
      });
    } catch (e) {
      console.warn(`[${label}] could not create revocation redis client:`, e.message);
      redis = null;
    }
    return redis;
  }

  async function isRevoked(claims) {
    const r = client();
    if (!r || !claims) return false;
    try {
      if (claims.jti) {
        const hit = await r.exists(JTI_PREFIX + claims.jti);
        if (hit) return true;
      }
      if (claims.sub && claims.iat) {
        const epoch = await userEpoch(claims.sub);
        // `iat` is whole seconds. A token minted in the same second as the bump is
        // treated as revoked (<=), which is the safe direction.
        if (epoch && claims.iat <= epoch) return true;
      }
    } catch (e) {
      if (!warned) {
        console.warn(`[${label}] revocation check failed — allowing request:`, e.message);
        warned = true;
      }
    }
    return false;
  }

  async function userEpoch(userId) {
    const cached = epochCache.get(userId);
    if (cached && Date.now() - cached.at < EPOCH_TTL_MS) return cached.value;
    const r = client();
    if (!r) return 0;
    const raw = await r.get(EPOCH_PREFIX + userId);
    const value = raw ? Number(raw) : 0;
    epochCache.set(userId, { value, at: Date.now() });
    return value;
  }

  // Revoke ONE token (logout). TTL matches the token's remaining life.
  async function revokeToken(claims) {
    const r = client();
    if (!r || !claims?.jti) return false;
    const ttl = Math.max(1, Math.ceil((claims.exp || 0) - Date.now() / 1000));
    try {
      await r.set(JTI_PREFIX + claims.jti, '1', 'EX', ttl);
      return true;
    } catch (e) {
      console.warn(`[${label}] revokeToken failed:`, e.message);
      return false;
    }
  }

  // Revoke EVERY current token for a user (disable / password change / role change).
  async function revokeAllForUser(userId) {
    const r = client();
    if (!r || !userId) return false;
    const now = Math.floor(Date.now() / 1000);
    try {
      // Expire the marker a little beyond the longest possible token life so it is
      // not garbage forever, but long enough that no live token predates it.
      await r.set(EPOCH_PREFIX + userId, String(now), 'EX', 60 * 60 * 24 * 2);
      epochCache.delete(userId);
      return true;
    } catch (e) {
      console.warn(`[${label}] revokeAllForUser failed:`, e.message);
      return false;
    }
  }

  return { isRevoked, revokeToken, revokeAllForUser, disconnect: () => redis?.disconnect?.() };
}

module.exports = { createRevocation, JTI_PREFIX, EPOCH_PREFIX };
