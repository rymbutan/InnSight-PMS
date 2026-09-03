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
const router = require('./stay.routes');

// Deliberately open routes, as 'METHOD /path'.
const OPEN = [];

test('every route has an authorization guard', () => {
  const problems = auditRouter(router, { open: OPEN });
  assert.deepEqual(problems, [], `unguarded routes:\n  ${problems.join('\n  ')}`);
});

test('the router actually exposes routes (guards the audit itself)', () => {
  // A require failure or a refactor that empties the stack would make the audit
  // above pass vacuously. Assert there is something to audit.
  const routes = listRoutes(router);
  assert.ok(routes.length > 0, 'no routes found on the router — the audit would be vacuous');
});
