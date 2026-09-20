// Route-level tests for POST /api/folios/:id/close.
//
// THE BUG THIS FILE EXISTS FOR
// -----------------------------
// This route used to update the folio straight to CLOSED with no read first —
// no balance check, not even a check that it wasn't already closed. A folio
// with charges still exceeding its payments could be closed anyway, which is
// exactly the "restrict folios from being closed until payments are fully
// completed" gap this file guards against.
//
//   node --test src/routes/folioClose.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

// ── In-memory store ─────────────────────────────────────────────────────────

const memDb = { folio: new Map() };

const mockPrisma = {
  folio: {
    findUnique: async ({ where: { id } }) => memDb.folio.get(id) || null,
    update: async ({ where: { id }, data }) => {
      const row = { ...memDb.folio.get(id), ...data };
      memDb.folio.set(id, row);
      return row;
    },
  },
};

// ── Stubs, installed before the route module loads ──────────────────────────

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
require.cache[require.resolve('../lib/settingsStore')] = {
  exports: {
    getTaxRates: async () => ({ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 }),
    getHotel: async () => ({}),
    saveTaxRates: async () => {},
    saveHotel: async () => {},
  },
};

const router = require('./folio.routes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

function call(method, path, body) {
  return new Promise((resolve) => {
    const server = makeApp().listen(0, () => {
      const data = body !== undefined ? JSON.stringify(body) : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          method,
          path,
          headers: {
            'Content-Type': 'application/json',
            ...(data && { 'Content-Length': Buffer.byteLength(data) }),
          },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null });
          });
        }
      );
      if (data) req.write(data);
      req.end();
    });
  });
}

function seedFolio(transactions, overrides = {}) {
  memDb.folio.clear();
  const folio = { id: 'f1', status: 'OPEN', stayId: 's1', guestId: 'g1', currency: 'PHP', transactions, ...overrides };
  memDb.folio.set(folio.id, folio);
  return folio;
}

// ── The regression gate ──────────────────────────────────────────────────────

test('a folio with charges exceeding payments is refused, not closed', async () => {
  seedFolio([
    { type: 'CHARGE', amountCents: 500000n, taxAmountCents: 0n },
    { type: 'PAYMENT', amountCents: 200000n, taxAmountCents: 0n },
  ]);
  const res = await call('POST', '/api/folios/f1/close');
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /outstanding balance/i);
  assert.strictEqual(res.body.balanceCents, '300000');
  assert.strictEqual(memDb.folio.get('f1').status, 'OPEN', 'a refused close must not change status');
});

test('a fully paid folio closes successfully', async () => {
  seedFolio([
    { type: 'CHARGE', amountCents: 500000n, taxAmountCents: 0n },
    { type: 'PAYMENT', amountCents: 500000n, taxAmountCents: 0n },
  ]);
  const res = await call('POST', '/api/folios/f1/close');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(memDb.folio.get('f1').status, 'CLOSED');
});

test('an overpaid folio (credit balance) is still allowed to close', async () => {
  seedFolio([
    { type: 'CHARGE', amountCents: 500000n, taxAmountCents: 0n },
    { type: 'PAYMENT', amountCents: 600000n, taxAmountCents: 0n },
  ]);
  const res = await call('POST', '/api/folios/f1/close');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(memDb.folio.get('f1').status, 'CLOSED');
});

test('a refund is added back into the balance owed', async () => {
  // Charged 5,000, paid 5,000, then 5,000 refunded — the guest is owed nothing
  // back but the room is unpaid again.
  seedFolio([
    { type: 'CHARGE', amountCents: 500000n, taxAmountCents: 0n },
    { type: 'PAYMENT', amountCents: 500000n, taxAmountCents: 0n },
    { type: 'REFUND', amountCents: 500000n, taxAmountCents: 0n },
  ]);
  const res = await call('POST', '/api/folios/f1/close');
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.balanceCents, '500000');
});

test('tax is included in the balance owed', async () => {
  seedFolio([{ type: 'CHARGE', amountCents: 500000n, taxAmountCents: 60000n }]);
  const res = await call('POST', '/api/folios/f1/close');
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.balanceCents, '560000');
});

test('an already-closed folio is refused, not re-closed', async () => {
  seedFolio([], { status: 'CLOSED' });
  const res = await call('POST', '/api/folios/f1/close');
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /already closed/i);
});

test('an unknown folio is a 404', async () => {
  memDb.folio.clear();
  const res = await call('POST', '/api/folios/does-not-exist/close');
  assert.strictEqual(res.status, 404);
});
