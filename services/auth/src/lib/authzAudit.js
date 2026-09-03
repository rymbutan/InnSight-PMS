// Router authorization audit — the mechanism that makes "default deny" enforceable.
//
// WHY THIS EXISTS
// ---------------
// Authorization here is per-route middleware, which means a new route is
// unprotected by DEFAULT: you have to remember to add `requireRole(...)`. That is
// exactly how this codebase ended up with every WRITE route guarded and the READS
// wide open — any authenticated account, including a HOUSEKEEPING trainee, could
// read all folios, all guest PII, daily revenue totals and printable statements.
//
// A runtime "deny anything unchecked" middleware can't work with Express: once a
// route handler sends a response, no later middleware runs. So the guarantee is
// enforced at TEST time instead — walk the router's own layer stack and assert
// every route carries a recognised authorization middleware. A route added without
// one fails CI rather than shipping open.
//
// Usage (see any service's authz.test.js):
//
//   const { auditRouter } = require('../lib/authzAudit');
//   const problems = auditRouter(router, { open: ['GET /health'] });
//   assert.deepEqual(problems, []);

// Middleware added by requireRole / requirePermission. Function names survive
// minification-free Node, and these are the names used in middleware/auth.js.
const AUTHZ_FN_NAMES = new Set(['roleGuard', 'permissionGuard']);

/**
 * Walk an Express router and return a list of routes with no authorization guard.
 *
 * @param {object}   router          an express.Router()
 * @param {object}  [opts]
 * @param {string[]}[opts.open]      routes that are DELIBERATELY open, as
 *                                   "METHOD /path" (e.g. 'POST /login'). Anything
 *                                   listed here should carry a comment at the route
 *                                   explaining why.
 * @returns {string[]} human-readable problems; empty means every route is guarded.
 */
function auditRouter(router, { open = [] } = {}) {
  const allowed = new Set(open.map((s) => s.trim().toUpperCase()));
  const problems = [];

  for (const layer of router.stack || []) {
    if (!layer.route) continue; // plain middleware, not a route
    const path = layer.route.path;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => m !== '_all');

    // Every function mounted on this route, in order.
    const handlers = (layer.route.stack || []).map((l) => l.name || '');
    const guarded = handlers.some((n) => AUTHZ_FN_NAMES.has(n));

    for (const method of methods) {
      const key = `${method.toUpperCase()} ${path}`;
      if (allowed.has(key.toUpperCase())) continue;
      if (!guarded) {
        problems.push(
          `${key} has no requireRole/requirePermission ` +
            `(handlers: ${handlers.map((h) => h || '<anon>').join(' → ')})`
        );
      }
    }
  }
  return problems;
}

// Every route on the router, as "METHOD /path" — useful for asserting a route
// inventory hasn't changed unexpectedly.
function listRoutes(router) {
  const out = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods || {})) {
      if (m !== '_all') out.push(`${m.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out.sort();
}

module.exports = { auditRouter, listRoutes, AUTHZ_FN_NAMES };
