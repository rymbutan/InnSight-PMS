const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT-DENY GUARD.
//
// Express authorization is opt-in per route, so a new route ships UNPROTECTED
// unless someone remembers `requireRole(...)`. This test walks the router's own
// layer stack and fails if ANY route lacks an authorization guard.
//
// MESSAGING IS THE ONE SERVICE WHERE EVERY ROUTE IS DELIBERATELY ROLE-OPEN, so
// the whole router is listed in OPEN below. That is not an exemption granted to
// get the test passing — it is the feature. Messages belong to the two people in
// the conversation, not to a department, so restricting them by role would mean
// deciding that (say) housekeeping may not write to a manager. Every role,
// admin included, can message every other role.
//
// What stands in for the role check is ownership, enforced in the handlers: each
// route derives the caller from `req.user.sub` (set by verifyToken, which the
// whole /api tree is mounted behind in src/index.js) and never from a path or
// body parameter. So you can only read your own inbox, only open a conversation
// you are part of, and only publish your own presence. A route added here that
// takes a user id from the REQUEST instead of the token would break that and
// must not simply be appended to this list.
// ─────────────────────────────────────────────────────────────────────────────

// The route module pulls in prisma/ioredis at require time; stub them out.
require.cache[require.resolve('../lib/prisma')] = { exports: new Proxy({}, { get: () => () => {} }) };
try {
  require.cache[require.resolve('ioredis')] = {
    exports: function Redis() {
      return {
        publish: () => Promise.resolve(),
        on: () => {},
        disconnect: () => {},
        set: () => Promise.resolve(),
        mget: () => Promise.resolve([]),
      };
    },
  };
} catch {
  /* not installed in this service */
}

const { auditRouter, listRoutes } = require('../lib/authzAudit');
const router = require('./messages.routes');
const settingsRouter = require('./settings.routes');

// Deliberately open to any authenticated caller, per the reasoning above.
const OPEN = [
  'GET /messages/contacts', // your own contact list; excludes you, reads req.user.sub
  'GET /messages/unread-count', // counts only messages addressed to req.user.sub
  'GET /messages/with/:userId', // one side of the pair is always req.user.sub
  'POST /messages', // senderId is req.user.sub, never client-supplied
  'POST /messages/presence/ping', // publishes presence for req.user.sub only
];

test('every route is either guarded or deliberately open', () => {
  const problems = auditRouter(router, { open: OPEN });
  assert.deepEqual(problems, [], `unguarded routes:\n  ${problems.join('\n  ')}`);
});

// ── The settings router is the exception to the exception ────────────────────
// Message retention is hotel configuration, not correspondence: it changes what
// every user sees and it DELETES data. So unlike everything above, its write has
// a real role guard, and it lives in its own file precisely so that the "no role
// guards in this service" statement above stays true of the file it describes.
const SETTINGS_OPEN = [
  // Read-only. Staff are told, on the Messages page, how long what they type
  // will survive — a retention rule people cannot see is one they get caught by.
  // Mirrors GET /api/settings/theme in the reservation service, open for the
  // same reason: it is a fact about the product, not about anyone's data.
  'GET /messages/settings/retention',
];

test('the settings router guards its write and opens only its read', () => {
  const problems = auditRouter(settingsRouter, { open: SETTINGS_OPEN });
  assert.deepEqual(problems, [], `unguarded routes:\n  ${problems.join('\n  ')}`);
  // PUT must NOT be in the open list — pin that, because adding it there is the
  // one edit that would silently let any signed-in user wipe everyone's history.
  assert.ok(
    !SETTINGS_OPEN.includes('PUT /messages/settings/retention'),
    'the retention write must stay role-guarded'
  );
});

test('the router actually exposes routes (guards the audit itself)', () => {
  // A require failure or a refactor that empties the stack would make the audit
  // above pass vacuously. Assert there is something to audit.
  const routes = listRoutes(router);
  assert.ok(routes.length > 0, 'no routes found on the router — the audit would be vacuous');
});

test('OPEN lists exactly the routes that exist — no stale or blanket entries', () => {
  // The OPEN list above is the whole router, which makes it uniquely easy for it
  // to drift into a rubber stamp: a route deleted here leaves a dead entry, and
  // a route added elsewhere gets waved through by a copy-pasted line. Pin the
  // two lists to each other so adding a route is a deliberate edit to BOTH.
  assert.deepEqual(listRoutes(router).sort(), [...OPEN].sort());
});

// ── Activity log ────────────────────────────────────────────────────────────

const ROUTE_SRC = readFileSync(join(__dirname, 'messages.routes.js'), 'utf8');

test('the presence heartbeat opts out of the activity log', () => {
  // The heartbeat fires every 25 seconds per open browser (web/src/components/
  // Layout.jsx beats against the 45s TTL), so without this opt-out one route
  // writes thousands of rows a day and buries every real action an admin came to
  // the Activity Log to find. It shipped that way once and was caught only by
  // reading the deployed table after the deploy — hence a test.
  const route = ROUTE_SRC.slice(ROUTE_SRC.indexOf("router.post('/messages/presence/ping'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(
    body,
    /res\.locals\.activity\s*=\s*false/,
    'the presence ping must set res.locals.activity = false, or it floods the Activity Log'
  );
});

test('sending a message is still recorded', () => {
  // Guards the guard: applying the opt-out to the whole router, or to the send
  // handler, would keep the test above green while the log quietly stopped
  // recording the one messaging action that matters.
  const send = ROUTE_SRC.slice(ROUTE_SRC.indexOf("router.post('/messages',"));
  const body = send.slice(0, send.indexOf('\nrouter.'));
  assert.doesNotMatch(body, /res\.locals\.activity\s*=\s*false/, 'sending a message must stay logged');
});
