const prisma = require('../lib/prisma');

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE RETENTION — how long a staff message survives.
//
// WHY THIS EXISTS
// ---------------
// A chat thread in a PMS accumulates operational chatter nobody intends to keep:
// room numbers, guest names, who is covering whose shift. On a shared front-desk
// terminal that history outlives the shift that produced it. An admin picks one
// policy here and it applies to everybody — deliberately NOT a per-user
// preference, because a conversation has two ends, and letting one of them
// choose the lifetime would mean the same message is both kept and deleted.
//
// THREE LAYERS, AND WHY ALL THREE ARE NEEDED
// ------------------------------------------
// 1. The SWEEP (purgeExpired, on an interval) is what actually frees the rows.
// 2. The READ CUTOFF (cutoffFor, applied to every query in messages.routes.js)
//    is what makes the policy honest. The sweep runs once a minute; without a
//    read filter a message would stay on screen for up to a minute past its own
//    deadline, which reads as the setting not working.
// 3. The SESSION PURGE (purgeForUser, driven by auth events in
//    subscribers/redis.subscriber.js) covers the 'logout' mode, where the
//    lifetime is a session rather than a duration.
//
// WHAT 'logout' MEANS, PRECISELY
// ------------------------------
// Purge on sign-OUT and again on sign-IN, for the user the event names. The
// sign-out half is the obvious one. The sign-in half is what makes the mode
// trustworthy: a browser closed without clicking Sign out never fires a logout
// event, so a purge keyed only to sign-out would leave that session's messages
// sitting there indefinitely — exactly the case the setting exists to prevent.
// Purging on sign-in guarantees the invariant people actually want: a new
// session always starts empty, however the last one ended.
//
// A purge removes every message the user is party to, in both directions. There
// is one row per message shared by both participants, so clearing Alice's
// history necessarily clears Bob's copy of that conversation. That is the intent
// of "cleared from the system" rather than a bug — but it is why this mode is
// spelled out in the admin UI instead of just being labelled "on logout".
// ─────────────────────────────────────────────────────────────────────────────

const SETTING_KEY = 'message_retention';

const HOUR = 3600 * 1000;

// The catalogue. `ms` is the message lifetime; null means "not a duration" —
// either kept forever, or governed by the session.
const MODES = [
  {
    mode: 'never',
    label: 'Keep messages',
    detail: 'Nothing is deleted automatically. This is the shipped default.',
    ms: null,
  },
  { mode: '1h', label: 'Clear after 1 hour', detail: null, ms: HOUR },
  { mode: '3h', label: 'Clear after 3 hours', detail: null, ms: 3 * HOUR },
  { mode: '5h', label: 'Clear after 5 hours', detail: null, ms: 5 * HOUR },
  { mode: '12h', label: 'Clear after 12 hours', detail: null, ms: 12 * HOUR },
  { mode: '24h', label: 'Clear after 1 day', detail: null, ms: 24 * HOUR },
  { mode: '7d', label: 'Clear after 7 days', detail: null, ms: 7 * 24 * HOUR },
  {
    mode: 'logout',
    label: 'Clear when a participant signs out',
    detail:
      'Conversations are deleted when a user signs out, and again when they next sign in — so a ' +
      'session always starts empty even if the browser was simply closed. Both sides of a ' +
      'conversation are cleared, because a message is one record shared by two people.',
    ms: null,
  },
];

const BY_MODE = new Map(MODES.map((m) => [m.mode, m]));
const DEFAULT_MODE = 'never';

// Read on every messaging request, so cache it in-process rather than issuing a
// SELECT per poll. Five seconds mirrors navScope.js's CONFIG_TTL_MS: a policy
// change reaches every replica within five seconds, which is far inside the
// resolution of a setting measured in hours.
const CACHE_TTL_MS = 5000;
let cache = { at: 0, policy: null };

function isMode(mode) {
  return BY_MODE.has(mode);
}

function modeOf(mode) {
  return BY_MODE.get(mode) || BY_MODE.get(DEFAULT_MODE);
}

// The policy as the rest of the service consumes it. Never throws: a database
// blip must not take messaging down, and "keep everything" is the safe failure —
// the alternative is deleting on a policy we could not actually read.
async function getPolicy() {
  const now = Date.now();
  if (cache.policy && now - cache.at < CACHE_TTL_MS) return cache.policy;
  let mode = DEFAULT_MODE;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    if (row?.value && isMode(row.value)) mode = row.value;
  } catch (err) {
    console.error('[Messaging] Retention read failed, assuming "never":', err.message);
  }
  cache = { at: now, policy: modeOf(mode) };
  return cache.policy;
}

async function setPolicy(mode) {
  if (!isMode(mode)) throw new Error(`Unknown retention mode: ${mode}`);
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: mode },
    update: { value: mode },
  });
  // Skip the TTL for the admin who just saved — otherwise the value they read
  // back in the confirmation could still be the previous one.
  cache = { at: Date.now(), policy: modeOf(mode) };
  return cache.policy;
}

// The oldest createdAt still considered live, or null when nothing expires by
// age. Pure, which is why this is the part that is unit-tested.
function cutoffFor(policy, now = Date.now()) {
  return policy?.ms ? new Date(now - policy.ms) : null;
}

// Convenience for the routes: `{ createdAt: { gte: cutoff } }` where a cutoff
// applies and `{}` where it does not, so callers spread it into a where clause
// without branching.
async function createdAtFilter() {
  const cutoff = cutoffFor(await getPolicy());
  return cutoff ? { createdAt: { gte: cutoff } } : {};
}

// Delete everything past its deadline. A no-op in the modes with no duration.
async function purgeExpired() {
  const cutoff = cutoffFor(await getPolicy());
  if (!cutoff) return 0;
  const { count } = await prisma.message.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

// Delete every message a user is party to. Only reached in 'logout' mode; the
// mode check lives at the call site (the subscriber) so this stays a plain,
// testable "forget this person's conversations".
async function purgeForUser(userId) {
  const { count } = await prisma.message.deleteMany({
    where: { OR: [{ senderId: userId }, { recipientId: userId }] },
  });
  return count;
}

// One minute. The read cutoff already hides expired messages instantly, so this
// interval governs only how promptly rows leave the table, not what anyone sees.
// A shorter sweep would be write load for no visible difference.
const SWEEP_INTERVAL_MS = 60 * 1000;

function startSweeper(intervalMs = SWEEP_INTERVAL_MS) {
  const tick = async () => {
    try {
      const count = await purgeExpired();
      if (count > 0) console.log(`[Messaging] Retention sweep removed ${count} expired message(s).`);
    } catch (err) {
      // A failed sweep is recoverable — the next one catches up, and the read
      // cutoff means nothing expired was visible in the meantime.
      console.error('[Messaging] Retention sweep failed:', err.message);
    }
  };
  const timer = setInterval(tick, intervalMs);
  // Housekeeping must not hold the process open on shutdown.
  timer.unref?.();
  tick();
  return timer;
}

module.exports = {
  SETTING_KEY,
  MODES,
  DEFAULT_MODE,
  isMode,
  modeOf,
  getPolicy,
  setPolicy,
  cutoffFor,
  createdAtFilter,
  purgeExpired,
  purgeForUser,
  startSweeper,
};
