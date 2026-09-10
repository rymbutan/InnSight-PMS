// Route-level tests for GET /api/folios — specifically the bill-split fix:
// a stay split into two folios (e.g. "Jeffrey Par" and "Andrei Sumilang")
// used to show "Jeffrey Par" on BOTH rows in this list, because
// Folio.guestId links the STAY's overall guest, not who each specific folio
// actually bills. Also locks in the new `chargeType` column
// (SPLIT/SOLO) — see lib/folioList.js for the pure row-building logic this
// route feeds.
//
//   node --test src/routes/folioListRoute.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

let folioRows = [];

const mockPrisma = {
  folio: {
    findMany: async () => folioRows,
    // Mirrors what Postgres would return: one row per distinct stayId among
    // the ones asked for, with how many folios share it.
    groupBy: async ({ where }) => {
      const wanted = new Set(where.stayId.in);
      const counts = new Map();
      for (const f of folioRows) {
        if (!f.stayId || !wanted.has(f.stayId)) continue;
        counts.set(f.stayId, (counts.get(f.stayId) || 0) + 1);
      }
      return [...counts.entries()].map(([stayId, count]) => ({ stayId, _count: { _all: count } }));
    },
  },
  chargeCode: {
    findMany: async () => [],
  },
};

require.cache[require.resolve('@prisma/client')] = {
  exports: {
    PrismaClient: function () {
      return mockPrisma;
    },
  },
};
require.cache[require.resolve('ioredis')] = {
  exports: function () {
    return { publish: () => {}, on: () => {}, disconnect: () => {} };
  },
};
require.cache[require.resolve('../middleware/auth')] = {
  exports: {
    ROLE_GROUPS: new Proxy({}, { get: () => ['ADMIN'] }),
    requireRole: () => (req, _res, next) => {
      req.user = { sub: 'u1', username: 'tester', roles: ['ADMIN'] };
      next();
    },
    signServiceToken: () => 'test-token',
  },
};

// The guest-service batch lookup — every folio in these tests shares one
// guestId (the stay's actual guest), so the list would show that ONE name on
// every row if payerName were not preferred.
const originalFetch = global.fetch;
global.fetch = async (url) => {
  if (String(url).includes('/api/guests/batch')) {
    return { ok: true, json: async () => [{ id: 'guest-jeffrey', displayName: 'Jeffrey Par' }] };
  }
  return { ok: false, json: async () => null };
};
test.after(() => {
  global.fetch = originalFetch;
});

const router = require('./folio.routes');

function call(path) {
  return new Promise((resolve) => {
    const app = express();
    app.use('/api', router);
    const server = app.listen(0, () => {
      http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null });
        });
      });
    });
  });
}

test('a bill split into two folios shows each payer, and both are marked SPLIT', async () => {
  folioRows = [
    {
      id: 'source',
      folioNumber: 'F-source',
      status: 'OPEN',
      currency: 'PHP',
      stayId: 'stay1',
      guestId: 'guest-jeffrey',
      payerName: null, // the source folio still bills the stay's own guest
      openedAt: new Date(),
      transactions: [],
    },
    {
      id: 'split-1',
      folioNumber: 'F-source-1',
      status: 'OPEN',
      currency: 'PHP',
      stayId: 'stay1',
      guestId: 'guest-jeffrey', // same guestId — this is the bug's root cause
      payerName: 'Andrei Sumilang',
      openedAt: new Date(),
      transactions: [],
    },
  ];

  const r = await call('/api/folios');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);

  const source = r.body.find((f) => f.id === 'source');
  const split = r.body.find((f) => f.id === 'split-1');

  assert.equal(source.guestName, 'Jeffrey Par');
  assert.equal(
    split.guestName,
    'Andrei Sumilang',
    'the split folio must show its OWN payer, not the stay guest'
  );
  assert.equal(source.payerName, null);
  assert.equal(split.payerName, 'Andrei Sumilang');

  assert.equal(source.chargeType, 'SPLIT');
  assert.equal(split.chargeType, 'SPLIT');
});

test('a stay with only one folio is SOLO', async () => {
  folioRows = [
    {
      id: 'lonely',
      folioNumber: 'F-lonely',
      status: 'OPEN',
      currency: 'PHP',
      stayId: 'stay2',
      guestId: 'guest-jeffrey',
      payerName: null,
      openedAt: new Date(),
      transactions: [],
    },
  ];

  const r = await call('/api/folios');
  assert.equal(r.status, 200);
  assert.equal(r.body[0].chargeType, 'SOLO');
});

test('a folio with no stay at all is always SOLO', async () => {
  folioRows = [
    {
      id: 'walkin',
      folioNumber: 'F-walkin',
      status: 'OPEN',
      currency: 'PHP',
      stayId: null,
      guestId: null,
      payerName: null,
      openedAt: new Date(),
      transactions: [],
    },
  ];

  const r = await call('/api/folios');
  assert.equal(r.status, 200);
  assert.equal(r.body[0].chargeType, 'SOLO');
});
