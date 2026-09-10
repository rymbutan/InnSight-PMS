// Route-level tests for the PUBLIC payment-intent routes — what a phone opens
// after scanning a QR code (GET .../:token) and what runs when it taps
// "Confirm payment" (POST .../:token/confirm). These used to live directly in
// index.js, untested, and had a real bug: the confirm handler never returned
// a reference to the caller at all, and a first attempt at fixing that here
// made the FolioTransaction's `reference` the Payment's gatewayRef instead of
// its id — which quietly broke postRefund()'s lookup of the Payment row for
// every QR-paid folio. They were moved into folio.routes.js's `publicRouter`
// (same place the folio-PDF public route already lives) specifically so this
// money-handling path could be tested the same way every other route in this
// file is, and both bugs are pinned down below.
//
//   node --test src/routes/folioPublicPaymentIntents.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

let intents = new Map();
let payments = [];
let folioTransactions = [];
let seq = 0;

function reservedFieldsGuard(where) {
  // Prisma throws P2025 when an `update`'s `where` (id + a guard column, here
  // `status: 'PENDING'`) matches no row — exactly the double-scan race this
  // route relies on. Reproduce that here instead of silently updating.
  const current = intents.get(where.id);
  if (!current || (where.status !== undefined && current.status !== where.status)) {
    const err = new Error('Record to update not found.');
    err.code = 'P2025';
    throw err;
  }
  return current;
}

const mockPrisma = {
  paymentIntent: {
    findUnique: async ({ where: { token, id } }) => {
      if (token !== undefined) return [...intents.values()].find((i) => i.token === token) || null;
      return intents.get(id) || null;
    },
    update: async ({ where, data }) => {
      const current = reservedFieldsGuard(where);
      Object.assign(current, data);
      return current;
    },
  },
  payment: {
    create: async ({ data }) => {
      const p = { id: `pay${(seq += 1)}`, ...data };
      payments.push(p);
      return p;
    },
  },
  folioTransaction: {
    create: async ({ data }) => {
      const tx = { id: `tx${(seq += 1)}`, ...data };
      folioTransactions.push(tx);
      return tx;
    },
  },
  // The confirm route's interactive transaction — runs the callback against
  // this same mock, mirroring how every other route file in this service
  // mocks $transaction(async (px) => ...).
  $transaction: async (fn) => fn(mockPrisma),
};

require.cache[require.resolve('@prisma/client')] = {
  exports: {
    PrismaClient: function () {
      return mockPrisma;
    },
  },
};

const published = [];
require.cache[require.resolve('ioredis')] = {
  exports: function () {
    return {
      publish: (channel, message) => published.push({ channel, message }),
      on: () => {},
      disconnect: () => {},
    };
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

const { publicRouter } = require('./folio.routes');

function call(method, path, body) {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/public', publicRouter);
    const server = app.listen(0, () => {
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
          res.on('data', (c) => {
            buf += c;
          });
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

function seed(overrides = {}) {
  intents = new Map();
  payments = [];
  folioTransactions = [];
  published.length = 0;
  seq = 0;
  const intent = {
    id: 'pi1',
    token: 'tok1',
    folioId: 'f1',
    amountCents: 50000n,
    method: 'GCASH',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    confirmedAt: null,
    ...overrides,
  };
  intents.set(intent.id, intent);
  return intent;
}

test('GET returns state, amount, method and expiry — never the folio or guest', async () => {
  seed();
  const r = await call('GET', '/api/public/payment-intents/tok1');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'PENDING');
  assert.equal(r.body.amountCents, '50000');
  assert.equal(r.body.method, 'GCASH');
  assert.equal(r.body.folioId, undefined);
});

test('GET on an unknown token is a 404', async () => {
  seed();
  const r = await call('GET', '/api/public/payment-intents/nope');
  assert.equal(r.status, 404);
});

test('confirming posts a PAYMENT whose gatewayRef rides back to the phone', async () => {
  seed();
  const r = await call('POST', '/api/public/payment-intents/tok1/confirm');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'CONFIRMED');
  assert.equal(r.body.amountCents, '50000');

  // The bug this locks in: the response must carry a reference at all
  // (formerly missing entirely), and it must be the Payment's ACTUAL
  // gatewayRef, not something invented separately.
  assert.ok(r.body.reference, 'confirm response should carry a reference');
  assert.match(r.body.reference, /^SIM-/);

  assert.equal(payments.length, 1);
  assert.equal(payments[0].gatewayRef, r.body.reference);
  assert.equal(payments[0].status, 'CAPTURED');

  // The ledger row's `reference` is the PAYMENT'S OWN ID, never gatewayRef —
  // postRefund() looks the Payment back up by this exact field
  // (`payment.updateMany({ where: { id: original.reference } })`), so a
  // refund against a QR-paid folio must still find it.
  assert.equal(folioTransactions.length, 1);
  assert.equal(folioTransactions[0].type, 'PAYMENT');
  assert.equal(folioTransactions[0].folioId, 'f1');
  assert.equal(folioTransactions[0].amountCents, 50000n);
  assert.equal(folioTransactions[0].reference, payments[0].id);
  assert.notEqual(folioTransactions[0].reference, payments[0].gatewayRef);

  assert.equal(intents.get('pi1').status, 'CONFIRMED');
  assert.ok(intents.get('pi1').confirmedAt);
});

test('confirming publishes folio:payment_received so the desk screen updates live', async () => {
  seed();
  await call('POST', '/api/public/payment-intents/tok1/confirm');
  assert.equal(published.length, 1);
  assert.equal(published[0].channel, 'folio:payment_received');
  const msg = JSON.parse(published[0].message);
  assert.equal(msg.folioId, 'f1');
  assert.equal(msg.amountCents, '50000');
});

test('a double scan (already CONFIRMED) is refused, not double-posted', async () => {
  seed();
  await call('POST', '/api/public/payment-intents/tok1/confirm');
  const second = await call('POST', '/api/public/payment-intents/tok1/confirm');
  assert.equal(second.status, 409);
  assert.equal(second.body.state, 'CONFIRMED');

  // Exactly one payment and one ledger row exist — the second scan wrote nothing.
  assert.equal(payments.length, 1);
  assert.equal(folioTransactions.length, 1);
});

test('confirming an expired intent is refused', async () => {
  seed({ expiresAt: new Date(Date.now() - 1000) });
  const r = await call('POST', '/api/public/payment-intents/tok1/confirm');
  assert.equal(r.status, 409);
  assert.equal(r.body.state, 'EXPIRED');
  assert.equal(payments.length, 0);
});

test('confirming a cancelled intent reports its actual state', async () => {
  seed({ status: 'CANCELLED' });
  const r = await call('POST', '/api/public/payment-intents/tok1/confirm');
  assert.equal(r.status, 409);
  assert.equal(r.body.state, 'CANCELLED');
});

test('confirming an unknown token is a 404', async () => {
  seed();
  const r = await call('POST', '/api/public/payment-intents/nope/confirm');
  assert.equal(r.status, 404);
});
