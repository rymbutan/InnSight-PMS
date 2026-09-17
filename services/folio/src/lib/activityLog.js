// System-wide user activity log — the recording half.
//
// WHY THIS EXISTS
// ---------------
// Admins need to answer "who did this, and when". The obvious way to build that
// here would be to subscribe to the ~24 `redis.publish(...)` domain events the
// services already emit — and it does not work, because those events carry the
// OBJECT and not the ACTOR:
//
//   folio:settled            → { folioId }
//   guest:flagged            → { guestId, reason, vipLevel }
//   auth:user_roles_changed  → { userId, roles }   ← the TARGET, not who did it
//
// So a subscriber-only build would produce "a folio was settled" and could never
// produce "mramos settled it". Every publisher would have to be edited to carry
// the actor anyway, and any route added later would silently go unlogged.
//
// The request is the only place the actor is always known: `verifyToken` puts the
// verified claims on `req.user` (middleware/auth.js). Recording there covers every
// mutating route in the service, including ones nobody has written yet, and gets
// the actor right without trusting a hand-maintained event payload.
//
// WHAT IS RECORDED
//   Successful writes only — POST/PUT/PATCH/DELETE that returned < 400.
//   Reads are not recorded (10-50x the volume, and they answer a different,
//   data-privacy question), and neither are denied attempts. Both were considered
//   and deliberately left out; adding either is a change to SKIP_METHODS or to the
//   status check below, not a redesign.
//
// WHAT IS DELIBERATELY NOT RECORDED
//   `req.body`. Never. It holds passwords on /api/auth/login and /api/auth/reset,
//   cardholder names on reservation cards, and guest PII nearly everywhere. An
//   activity log that a person reads is the wrong home for any of it, and a field
//   that COULD hold it is a field that eventually will. Only the actor, the verb,
//   the route, an id parsed out of the URL and the status code are kept.
//
// HOW IT TRAVELS
//   Fire-and-forget on the existing Redis bus, channel `activity:recorded`. The
//   audit service's subscriber persists the rows. Publishing from `res.on('finish')`
//   keeps this off the response path entirely: a slow or dead Redis then costs a
//   log row rather than a check-in. That trade-off is right for an operational log
//   and wrong for a tamper-proof legal record — this is the former.
//
// This file is canonical at services/_shared/activityLog.js and vendored
// byte-identical into every services/*/src/lib/. scripts/check-shared.sh enforces
// that.

const CHANNEL = 'activity:recorded';

// Reads answer a different question and are excluded — see WHAT IS RECORDED.
const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Infrastructure endpoints, not user activity. `/metrics` is scraped on a timer
// and would out-number every real row within the hour.
const SKIP_PATHS = [/^\/metrics\b/, /^\/health\b/, /^\/docs\b/];

// One publisher per process, same reasoning as lib/prisma.js: `require` caching
// plus globalThis, so the re-require that `node --watch` causes does not leak a
// connection per reload. Redis connections are cheap in a way Postgres pool slots
// are not, but "cheap" is not a reason to open one per module.
// `ioredis` is required lazily, inside here, for two reasons: a process that
// never publishes never loads the driver, and the unit test can inject its own
// `publish` and exercise this file with no dependencies installed at all.
function publisher() {
  if (!globalThis.__innsightActivityRedis) {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    // An unhandled 'error' on an ioredis client is an uncaught exception that
    // takes the whole service down. A log row is never worth that.
    client.on('error', (e) => console.warn('[activity] redis error:', e.message));
    globalThis.__innsightActivityRedis = client;
  }
  return globalThis.__innsightActivityRedis;
}

const VERBS = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
const VERB_PAST = { create: 'created', update: 'updated', delete: 'deleted', other: 'changed' };

// A path segment that is an id rather than a resource name: a uuid, a cuid, or a
// bare number. This is what lets "/api/reservations/<uuid>/cancel" be split into
// the resource, the row and the operation with no per-route configuration.
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{20,}|\d+)$/i;

/**
 * Split a request path into the resource acted on, an id, and any trailing verb.
 *
 *   /api/reservations               → { resource: 'reservations' }
 *   /api/reservations/<uuid>        → { resource: 'reservations', targetId: <uuid> }
 *   /api/reservations/<uuid>/cancel → { resource: 'reservations', targetId, tail: 'cancel' }
 *   /api/auth/login                 → { resource: 'auth', tail: 'login' }
 */
function describePath(pathname) {
  const parts = String(pathname || '')
    .split('/')
    .filter(Boolean);
  if (parts[0] === 'api') parts.shift();
  const resource = parts[0] || 'unknown';
  let targetId;
  let tail;
  for (let i = 1; i < parts.length; i += 1) {
    if (ID_SEGMENT.test(parts[i])) targetId = parts[i];
    else tail = parts[i];
  }
  return { resource, targetId, tail };
}

// Crude, but adequate for the resource names this codebase actually uses
// (reservations, guests, folios, rooms, work-orders, users, messages, stays).
function singular(word) {
  if (!word) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses') || word.endsWith('ches')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Build the row that gets stored. Exported and pure so it can be unit-tested —
 * which is the whole reason the parsing lives here instead of inline below.
 */
function buildEntry({ service, method, originalUrl, statusCode, user, override = {}, requestId, ip }) {
  const pathname = String(originalUrl || '').split('?')[0];
  const { resource, targetId, tail } = describePath(pathname);
  const verb = VERBS[method] || 'other';

  // `tail` is the operation whenever there is one ("cancel", "check-in", "login"),
  // because "cancelled reservation" says far more than "updated reservation".
  const operation = tail || verb;
  const actorName = override.actorName || user?.username || 'unknown';
  const phrase = tail
    ? `${tail.replace(/-/g, ' ')} ${singular(resource)}`
    : `${VERB_PAST[verb]} ${singular(resource)}`;

  return {
    at: new Date().toISOString(),
    service,
    actorId: override.actorId || user?.sub || null,
    actorName,
    actorRoles: Array.isArray(user?.roles) ? user.roles : [],
    action: override.action || `${resource}.${operation}`,
    summary: override.summary || `${actorName} ${phrase}${targetId ? ` ${targetId}` : ''}`.trim(),
    method,
    path: pathname,
    targetType: override.targetType || singular(resource),
    targetId: override.targetId || targetId || null,
    status: statusCode,
    requestId: requestId || null,
    ip: ip || null,
  };
}

/**
 * Express middleware. Mount it BEFORE the routes; it records on the way out:
 *
 *   app.use('/api', verifyToken, idempotency, activityLog({ service: 'folio' }), folioRoutes);
 *
 * Reading `req.user` on 'finish' rather than at call time is what lets the auth
 * service mount this above routes that run `verifyToken` themselves — by the time
 * the response finishes, the claims are on the request either way.
 *
 * A handler may enrich or override its row:
 *   res.locals.activity = { summary: 'Settled folio 204', targetId: folio.id };
 * A handler may suppress one entirely:
 *   res.locals.activity = false;
 */
function activityLog({ service, publish } = {}) {
  if (!service) throw new Error('activityLog({ service }) requires a service name');
  const send = publish || ((entry) => publisher().publish(CHANNEL, JSON.stringify(entry)));

  return function activityLogger(req, res, next) {
    if (SKIP_METHODS.has(req.method) || SKIP_PATHS.some((re) => re.test(req.path))) return next();

    res.on('finish', () => {
      try {
        if (res.locals?.activity === false) return; // handler opted out
        if (res.statusCode >= 400) return; // successful writes only

        const entry = buildEntry({
          service,
          method: req.method,
          originalUrl: req.originalUrl || req.url,
          statusCode: res.statusCode,
          user: req.user,
          override: res.locals?.activity || {},
          requestId: req.id || req.headers['x-request-id'],
          // Behind the nginx gateway every socket is the gateway's, so the
          // forwarded header is the only thing that identifies the client.
          ip:
            String(req.headers['x-forwarded-for'] || '')
              .split(',')[0]
              .trim() ||
            req.ip ||
            null,
        });

        Promise.resolve(send(entry)).catch((e) => console.warn('[activity] publish failed:', e.message));
      } catch (e) {
        // Never let logging break a request that has already succeeded.
        console.warn('[activity] record failed:', e.message);
      }
    });

    next();
  };
}

module.exports = { activityLog, buildEntry, describePath, singular, CHANNEL };
