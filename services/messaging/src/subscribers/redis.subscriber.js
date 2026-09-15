const Redis = require('ioredis');

const prisma = require('../lib/prisma');
const { makeServiceCaller, ServiceCallError } = require('../lib/serviceCall');
const retention = require('../retention/policy');

const AUTH_URL = process.env.AUTH_URL || 'http://auth-service:3010';

// No roles and no permissions, which is the narrowest claim this caller can
// make: /api/users/directory asks only that you be authenticated. Naming a role
// here would assert authority this service has no use for.
const auth = makeServiceCaller({ name: 'messaging', roles: [], permissions: [] });

// Mirror one directory entry. Upsert rather than create so a replayed event, a
// restart mid-backfill, or an event that arrives before the backfill finishes
// all converge on the same row instead of colliding on the primary key.
async function upsertUser(u) {
  const roles = (u.roles || []).map((r) => (typeof r === 'string' ? r : r.roleCode)).filter(Boolean);
  const data = {
    username: u.username,
    displayName: u.displayName || u.username,
    roles,
    status: u.status || 'ACTIVE',
  };
  await prisma.userCache.upsert({ where: { id: u.id }, create: { id: u.id, ...data }, update: data });
}

// Pull the whole directory once at boot.
//
// The event stream alone cannot populate this table: Redis pub/sub has no
// backlog, so every account that existed before this service first started —
// which, on an established deployment, is all of them — would be invisible
// forever. This is the only place the synchronous cross-service call happens,
// and it happens once per process start rather than once per poll.
async function backfill() {
  try {
    const users = await auth.call(`${AUTH_URL}/api/users/directory`);
    if (!Array.isArray(users)) throw new Error('directory did not return a list');
    for (const u of users) await upsertUser(u);
    console.log(`[Messaging] Directory backfill complete — ${users.length} user(s) mirrored.`);
  } catch (err) {
    // A failed backfill means an empty or stale contact list, not a broken
    // service: existing conversations still work, and the next restart (or any
    // auth:user_* event) repairs it. Starting up is more useful than crash-looping.
    const detail =
      err instanceof ServiceCallError ? `${err.message} (${err.statusCode ?? 'no status'})` : err.message;
    console.error(`[Messaging] Directory backfill failed — contact list may be incomplete: ${detail}`);
  }
}

function startSubscriber() {
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  subscriber.subscribe(
    'auth:user_created',
    'auth:user_roles_changed',
    'auth:user_disabled',
    'auth:user_deleted',
    // Session boundaries, for the 'logout' retention mode. Both ends, not just
    // the sign-out: a browser that is simply closed never fires a logout, so
    // purging on sign-in too is what makes "a session starts empty" actually
    // true rather than true only for people who click the button.
    'auth:logout',
    'auth:login',
    (err) => {
      if (err) {
        console.error('[Messaging] Redis subscribe error:', err);
        return;
      }
      console.log('[Messaging] Redis subscriber active — mirroring auth directory changes.');
    }
  );

  subscriber.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);
      if (!data.userId) return;

      if (channel === 'auth:logout' || channel === 'auth:login') {
        // Only in the session-scoped mode. Every other mode is governed by age,
        // so signing in and out must leave the history exactly as it was.
        const policy = await retention.getPolicy();
        if (policy.mode !== 'logout') return;
        const count = await retention.purgeForUser(data.userId);
        if (count > 0) {
          console.log(
            `[Messaging] Session retention: cleared ${count} message(s) for ${data.userId} on ${channel}.`
          );
        }
        return;
      }

      if (channel === 'auth:user_deleted') {
        // Drop the contact. Their messages stay — a conversation is a record of
        // what was said, and deleting it because an account was closed would
        // silently rewrite the other person's history.
        await prisma.userCache.deleteMany({ where: { id: data.userId } });
        return;
      }

      if (channel === 'auth:user_disabled') {
        await prisma.userCache.updateMany({ where: { id: data.userId }, data: { status: 'DISABLED' } });
        return;
      }

      // Created or roles changed: the event carries an id but not the full
      // record, so re-read that one user from the directory rather than trusting
      // a partial payload.
      const users = await auth.call(`${AUTH_URL}/api/users/directory`);
      const fresh = Array.isArray(users) ? users.find((u) => u.id === data.userId) : null;
      if (fresh) await upsertUser(fresh);
    } catch (err) {
      console.error('[Messaging] Event handler error:', err.message);
    }
  });

  // Deliberately not awaited: the server should start listening and answering
  // /health immediately, and the backfill repairs the cache behind it.
  backfill();

  return subscriber;
}

module.exports = { startSubscriber, backfill, upsertUser };
