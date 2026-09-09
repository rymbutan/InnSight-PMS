// Route-level tests for the folio's QR code: the token it rides on, and the
// PUBLIC route the code links to.
//
// The QR is printed on the staff PDF (GET /folios/:id/print) but scanned by a
// guest's phone, which cannot authenticate — so the token it encodes is the
// credential, exactly like a PaymentIntent token, and the public route it
// resolves to must serve the same document unauthenticated.
//
//   node --test src/routes/folioPublicPrint.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

let folioRow = null;

const mockPrisma = {
  folio: {
    findUnique: async ({ where }) => {
      if (where.id) return where.id === folioRow?.id ? folioRow : null;
      if (where.publicToken) return where.publicToken === folioRow?.publicToken ? folioRow : null;
      return null;
    },
    findMany: async () => [],
    update: async ({ data }) => {
      Object.assign(folioRow, data);
      return folioRow;
    },
  },
  chargeCode: { findMany: async () => [] },
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
  app.use('/api/public', router.publicRouter);
  app.use('/api', router);
  return app;
}

function getPdf(path) {
  return new Promise((resolve, reject) => {
    const server = makeApp().listen(0, () => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, method: 'GET', path },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  });
}

function seed(over = {}) {
  folioRow = {
    id: 'f1',
    folioNumber: 'F-1',
    stayId: null,
    guestId: null,
    payerName: null,
    currency: 'PHP',
    publicToken: null,
    transactions: [],
    ...over,
  };
}

test('printing a folio for the first time mints it a public token', async () => {
  seed();
  assert.equal(folioRow.publicToken, null);
  const r = await getPdf('/api/folios/f1/print');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.ok(folioRow.publicToken, 'a token should have been generated and persisted');
});

test('printing the same folio twice keeps the same token', async () => {
  seed();
  await getPdf('/api/folios/f1/print');
  const first = folioRow.publicToken;
  await getPdf('/api/folios/f1/print');
  assert.equal(folioRow.publicToken, first);
});

test('the public route serves the same folio PDF, unauthenticated, by token', async () => {
  seed({ publicToken: 'tok123' });
  const r = await getPdf('/api/public/folios/tok123/pdf');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.ok(r.buf.toString('latin1').startsWith('%PDF'));
});

test('an unknown token is a 404, not a folio', async () => {
  seed({ publicToken: 'tok123' });
  const r = await getPdf('/api/public/folios/nope/pdf');
  assert.equal(r.status, 404);
});

test('a folio with no token yet cannot be found on the public route', async () => {
  // Only a folio that has actually been printed at least once has a token to
  // scan — nothing here should mint one on the public path itself, since that
  // would let a guessed id be turned into a valid link.
  seed({ publicToken: null });
  const r = await getPdf('/api/public/folios/null/pdf');
  assert.equal(r.status, 404);
});
