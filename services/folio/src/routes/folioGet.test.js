// Route-level tests for GET /api/folios/:id.
//
// Split-bill defaults its payer count to the reservation's guest count (see
// SplitBillDialog), so this folio needs to be able to say how many adults are
// on the booking without the browser making a second, separate call to the
// reservation service.
//
//   node --test src/routes/folioGet.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

let folioRow = null;
let stayRow = null;
let reservationRow = null;

const mockPrisma = {
  folio: { findUnique: async () => folioRow },
};

require.cache[require.resolve('@prisma/client')] = {
  exports: { PrismaClient: function () { return mockPrisma; } },
};
require.cache[require.resolve('ioredis')] = {
  exports: function () { return { publish: () => {}, on: () => {}, disconnect: () => {} }; },
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

const originalFetch = global.fetch;
global.fetch = async (url) => {
  if (String(url).includes('/api/stays/')) {
    return stayRow
      ? { ok: true, json: async () => stayRow }
      : { ok: false, json: async () => null };
  }
  if (String(url).includes('/api/reservations/')) {
    return reservationRow
      ? { ok: true, json: async () => reservationRow }
      : { ok: false, json: async () => null };
  }
  return { ok: false, json: async () => null };
};

const router = require('./folio.routes');

function call(path) {
  return new Promise((resolve) => {
    const app = express();
    app.use('/api', router);
    const server = app.listen(0, () => {
      http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null });
        });
      });
    });
  });
}

test.after(() => { global.fetch = originalFetch; });

test('a folio on a stay reports the reservation adult count', async () => {
  folioRow = { id: 'f1', stayId: 'stay1' };
  stayRow = { reservationId: 'res1' };
  reservationRow = { adults: 3, children: 1 };

  const r = await call('/api/folios/f1');
  assert.equal(r.status, 200);
  assert.equal(r.body.adults, 3);
});

test('a walk-in folio with no stay reports no adult count', async () => {
  folioRow = { id: 'f2', stayId: null };
  stayRow = null;
  reservationRow = null;

  const r = await call('/api/folios/f2');
  assert.equal(r.status, 200);
  assert.equal(r.body.adults, null);
});
