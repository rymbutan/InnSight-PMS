// The audit service drives night-audit steps by calling other services directly
// and publishes audit:* events. It now also CONSUMES one channel:
// `activity:recorded` — the system-wide user activity log.
//
// Every service mounts lib/activityLog.js, which publishes one event per
// successful write request with the actor taken from the verified token claims.
// This is the only writer of the ActivityLog table; there is no HTTP route that
// creates a row, so the log cannot be edited from the admin screen that reads it.
//
// WHY A SUBSCRIBER AND NOT A DIRECT WRITE
// ---------------------------------------
// The nine other services have their own databases and no access to this one.
// Writing over HTTP would put an extra service call on the response path of every
// check-in and every folio posting, and would fail those requests when this
// service is down. Fire-and-forget on the bus that already exists costs the
// caller nothing and degrades by losing log rows rather than by refusing work.
// That is the right trade for an operational log and the wrong one for a
// tamper-proof legal record — see services/_shared/activityLog.js.

const prisma = require('../lib/prisma');
const { CHANNEL } = require('../lib/activityLog');

// A row whose text fields are unbounded is a denial-of-service waiting for a long
// URL. Postgres TEXT has no length limit, so the cap has to be applied here.
const MAX_TEXT = 512;
const MAX_SUMMARY = 1024;

function clamp(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The event arrives over a network from another process, so nothing in it is
// trusted: every field is coerced to the type the column expects and anything
// missing falls back rather than throwing. A malformed event should cost one row,
// not the subscriber.
function toRow(data) {
  const at = data.at ? new Date(data.at) : new Date();
  return {
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    service: clamp(data.service, 64) || 'unknown',
    actorId: clamp(data.actorId, MAX_TEXT),
    actorName: clamp(data.actorName, MAX_TEXT) || 'unknown',
    actorRoles: Array.isArray(data.actorRoles) ? data.actorRoles.map((r) => String(r).slice(0, 64)) : [],
    action: clamp(data.action, MAX_TEXT) || 'unknown',
    summary: clamp(data.summary, MAX_SUMMARY) || '',
    method: clamp(data.method, 16) || 'UNKNOWN',
    path: clamp(data.path, MAX_TEXT) || '',
    targetType: clamp(data.targetType, MAX_TEXT),
    targetId: clamp(data.targetId, MAX_TEXT),
    status: Number.isInteger(data.status) ? data.status : 0,
    requestId: clamp(data.requestId, MAX_TEXT),
    ip: clamp(data.ip, 64),
  };
}

function startSubscriber() {
  // Required here rather than at module scope so that `toRow` — the pure part,
  // and the part worth testing — can be imported without the driver installed.
  // Same reasoning as lib/activityLog.js.
  const Redis = require('ioredis');
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  subscriber.on('error', (e) => console.error('[Audit] activity subscriber redis error:', e.message));

  subscriber.subscribe(CHANNEL, (err) => {
    if (err) {
      console.error('[Audit] Redis subscribe error:', err);
      return;
    }
    console.log(`[Audit] Redis subscriber active — recording user activity on "${CHANNEL}".`);
  });

  subscriber.on('message', async (channel, message) => {
    if (channel !== CHANNEL) return;
    try {
      await prisma.activityLog.create({ data: toRow(JSON.parse(message)) });
    } catch (err) {
      // Losing a log row must never take the subscriber down with it — that would
      // turn one bad event into a permanent stop on all activity logging.
      console.error('[Audit] activity record failed:', err.message);
    }
  });

  return subscriber;
}

module.exports = { startSubscriber, toRow };
