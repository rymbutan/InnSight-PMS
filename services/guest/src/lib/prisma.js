// Single PrismaClient per service process.
//
// WHY THIS EXISTS
// ---------------
// Every service used to call `new PrismaClient()` in each module that needed the
// database — its routes file, its Redis subscriber, and (for inventory and
// reservation) its index.js public-route handlers. That is 19 clients across the
// 9 long-running processes.
//
// Each client opens its OWN connection pool, and Prisma's default pool size is
// `num_cpus * 2 + 1` — about 9 on a 4-core host. 19 clients × 9 ≈ 171 potential
// connections against Postgres' default `max_connections = 100`. The failure mode
// is not graceful degradation: it is `FATAL: sorry, too many clients already` on
// every service at once, i.e. a total outage under exactly the load a demo
// creates.
//
// One client per process, one pool, sized explicitly by `connection_limit` in the
// DATABASE_URL (set in docker-compose.yml). Sharing is safe and is what Prisma
// documents: the client is stateless with respect to callers and manages its own
// pool concurrency.
//
// USAGE
//   const prisma = require('../lib/prisma');    // from src/routes/ or src/subscribers/
//   const prisma = require('./lib/prisma');     // from src/index.js
//
// This file is canonical at services/_shared/prisma.js and vendored byte-identical
// into every services/*/src/lib/. scripts/check-shared.sh enforces that.

const { PrismaClient } = require('@prisma/client');

// `connection_limit` is what bounds this pool. Without it Prisma silently picks a
// CPU-derived default, which is how the 171-vs-100 arithmetic above happened, so
// say something loud rather than let it regress unnoticed.
if (process.env.DATABASE_URL && !/[?&]connection_limit=/.test(process.env.DATABASE_URL)) {
  console.warn(
    '[prisma] DATABASE_URL has no connection_limit — Prisma will default to ' +
      '(cpus * 2 + 1) connections for this pool. Set it explicitly so the sum ' +
      'across all services stays under Postgres max_connections.'
  );
}

// In production, query-level logging is both noisy and a leak risk (bound
// parameters can include guest PII). Keep warnings and errors always.
const log = process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error', 'info'];

// Node caches modules, so `require` returns this same instance everywhere in the
// process. `globalThis` additionally survives the re-require that `node --watch`
// and Jest-style module resets cause, which would otherwise leak a pool per reload.
const prisma = globalThis.__innsightPrisma || new PrismaClient({ log });
if (!globalThis.__innsightPrisma) globalThis.__innsightPrisma = prisma;

module.exports = prisma;
