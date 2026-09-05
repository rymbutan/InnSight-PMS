const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const memDb = { guest: new Map() };

const mockPrisma = {
  guest: {
    findMany: async ({ where, select } = {}) => {
      let rows = [...memDb.guest.values()];
      if (where?.id?.in) rows = rows.filter((g) => where.id.in.includes(g.id));
      if (!select) return rows;
      return rows.map((g) => Object.fromEntries(Object.keys(select).map((k) => [k, g[k]])));
    },
    findUnique: async ({ where: { id } }) => memDb.guest.get(id) || null,
    create: async ({ data }) => data,
    update: async ({ data }) => data,
    count: async () => memDb.guest.size,
  },
  guestContact: { findMany: async () => [], create: async ({ data }) => data },
  $transaction: async (fn) => fn(mockPrisma),
};

require.cache[require.resolve('@prisma/client')] = {
  exports: { PrismaClient: function () { return mockPrisma; } },
};
try {
  require.cache[require.resolve('ioredis')] = {
    exports: function () { return { publish: () => {}, on: () => {}, disconnect: () => {} }; },
  };
} catch { /* not installed in this service */ }
require.cache[require.resolve('../middleware/auth')] = {
  exports: {
    ROLE_GROUPS: new Proxy({}, { get: () => ['ADMIN'] }),
    verifyToken: (req, _res, next) => { req.user = { sub: 'u1', roles: ['ADMIN'] }; next(); },
    requireRole: () => (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
  },
};

const router = require('./guest.routes');

function call(method, path) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, method, path },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
        }
      );
      req.end();
    });
  });
}

test('batch returns the named guests', async () => {
  memDb.guest.clear();
  memDb.guest.set('g1', { id: 'g1', displayName: 'Jana Felismino', profileNumber: 'P-1', nationality: 'Filipino' });
  memDb.guest.set('g2', { id: 'g2', displayName: 'Mark Santos', profileNumber: 'P-2', nationality: 'Filipino' });
  memDb.guest.set('g3', { id: 'g3', displayName: 'Unwanted', profileNumber: 'P-3', nationality: null });

  const res = await call('GET', '/api/guests/batch?ids=g1,g2');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.deepEqual(res.body.map((g) => g.id).sort(), ['g1', 'g2']);
  assert.equal(res.body.find((g) => g.id === 'g1').displayName, 'Jana Felismino');
});

// THE ORDERING HAZARD. /guests/:id is declared in this router; if the literal
// path is registered after it, Express matches 'batch' as a guest id and this
// endpoint silently 404s. lib comment on /folios/outstanding documents the same
// trap.
test('batch is not swallowed by the /guests/:id route', async () => {
  memDb.guest.clear();
  const res = await call('GET', '/api/guests/batch?ids=');
  assert.equal(res.status, 200, 'must not be handled as a guest whose id is "batch"');
  assert.deepEqual(res.body, []);
});

test('unknown ids are omitted rather than returned as nulls', async () => {
  memDb.guest.clear();
  memDb.guest.set('g1', { id: 'g1', displayName: 'Jana', profileNumber: 'P-1', nationality: null });
  const res = await call('GET', '/api/guests/batch?ids=g1,nope');
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'g1');
});

test('a missing ids param returns an empty list, not every guest in the hotel', async () => {
  memDb.guest.clear();
  memDb.guest.set('g1', { id: 'g1', displayName: 'Jana', profileNumber: 'P-1', nationality: null });
  const res = await call('GET', '/api/guests/batch');
  assert.deepEqual(res.body, []);
});
