const { test } = require('node:test');
const assert = require('node:assert/strict');

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT-DENY GUARD.
//
// Express authorization is opt-in per route, so a new route ships UNPROTECTED
// unless someone remembers `requireRole(...)`. That is exactly how this service
// ended up with its writes guarded and its reads open to any authenticated
// account. This test walks the router's own layer stack and fails if ANY route
// lacks an authorization guard.
//
// If you add a route and this test fails: add `requireRole(...ROLE_GROUPS.X)`, or —
// if the route is genuinely meant to be open to any authenticated caller — add it to
// OPEN below WITH a comment saying why.
// ─────────────────────────────────────────────────────────────────────────────

// The route module pulls in prisma/ioredis at require time; stub them out.
require.cache[require.resolve('../lib/prisma')] = { exports: new Proxy({}, { get: () => () => {} }) };
try {
  require.cache[require.resolve('ioredis')] = {
    exports: function Redis() {
      return { publish: () => {}, on: () => {}, disconnect: () => {}, set: () => {}, getdel: () => {} };
    },
  };
} catch {
  /* not installed in this service */
}

const { auditRouter, listRoutes } = require('../lib/authzAudit');
const router = require('./audit.routes');
const activityRouter = require('./activity.routes');

// Deliberately open routes, as 'METHOD /path'.
const OPEN = [];

test('every route has an authorization guard', () => {
  const problems = auditRouter(router, { open: OPEN });
  assert.deepEqual(problems, [], `unguarded routes:\n  ${problems.join('\n  ')}`);
});

test('every activity route has an authorization guard', () => {
  const problems = auditRouter(activityRouter, { open: [] });
  assert.deepEqual(problems, [], `unguarded routes:\n  ${problems.join('\n  ')}`);
});

test('the router actually exposes routes (guards the audit itself)', () => {
  // A require failure or a refactor that empties the stack would make the audit
  // above pass vacuously. Assert there is something to audit.
  const routes = listRoutes(router);
  assert.ok(routes.length > 0, 'no routes found on the router — the audit would be vacuous');
});

test('the activity log stays read-only', () => {
  // The guarantee from activity.routes.js: rows come from the Redis subscriber
  // alone, so an admin cannot edit or delete the record of what they did from the
  // screen that shows it. A route added here that writes would quietly remove
  // that property, so assert the shape rather than trusting the comment.
  const routes = listRoutes(activityRouter);
  assert.ok(routes.length > 0, 'no activity routes found — this test would be vacuous');
  const writes = routes.filter((r) => !r.startsWith('GET '));
  assert.deepEqual(
    writes,
    [],
    `the activity log must expose no write routes, found:\n  ${writes.join('\n  ')}`
  );
});
