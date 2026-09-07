// Route-level tests for the folio's payment-intent routes: the existing
// in-person QR flow (must keep working unchanged — Folios.jsx already calls it
// with no `to`), plus the new "Sent Pay by Link" additions: emailing a link and
// listing what has been sent.
//
//   node --test src/routes/folioPaymentIntents.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

let folioRow = null;
let intents = [];
let seq = 0;

const mockPrisma = {
  folio: { findUnique: async ({ where: { id } }) => (folioRow && id === folioRow.id ? folioRow : null) },
  paymentIntent: {
    create: async ({ data }) => {
      const row = { id: `pi${(seq += 1)}`, status: 'PENDING', createdAt: new Date(), ...data };
      intents.push(row);
      return row;
    },
    findMany: async ({ where = {} } = {}) =>
      intents
        .filter((i) => where.folioId === undefined || i.folioId === where.folioId)
        .sort((a, b) => b.createdAt - a.createdAt),
  },
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

const notifierStub = { sent: [] };
require.cache[require.resolve('../lib/notifier')] = {
  exports: {
    send: async (msg) => {
      notifierStub.sent.push(msg);
      return { ok: true };
    },
  },
};

const router = require('./folio.routes');

function call(method, path, body) {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api', router);
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

function seed() {
  folioRow = { id: 'f1', status: 'OPEN' };
  intents = [];
  seq = 0;
  notifierStub.sent = [];
}

test('creating an intent with no `to` behaves exactly as before — no email, no sentTo', async () => {
  seed();
  const r = await call('POST', '/api/folios/f1/payment-intents', { amountCents: 50000 });
  assert.equal(r.status, 201);
  assert.ok(r.body.qrDataUrl);
  assert.equal(notifierStub.sent.length, 0);
  assert.ok(!intents[0].sentTo);
});

test('creating an intent with `to` emails the link and records who it went to', async () => {
  seed();
  const r = await call('POST', '/api/folios/f1/payment-intents', {
    amountCents: 50000,
    to: 'guest@example.com',
  });
  assert.equal(r.status, 201);
  assert.equal(notifierStub.sent.length, 1);
  assert.equal(notifierStub.sent[0].to, 'guest@example.com');
  assert.match(notifierStub.sent[0].body, /http/); // the pay link itself
  assert.equal(intents[0].sentTo, 'guest@example.com');
});

test('an emailed link lives much longer than an in-person QR code', async () => {
  seed();
  const inPerson = await call('POST', '/api/folios/f1/payment-intents', { amountCents: 50000 });
  const emailed = await call('POST', '/api/folios/f1/payment-intents', {
    amountCents: 50000,
    to: 'guest@example.com',
  });
  const inPersonTtl = new Date(inPerson.body.expiresAt) - Date.now();
  const emailedTtl = new Date(emailed.body.expiresAt) - Date.now();
  assert.ok(emailedTtl > inPersonTtl * 10, `expected the emailed link to outlast the QR by far, got ${emailedTtl} vs ${inPersonTtl}`);
});

test('GET lists every intent created for the folio, newest first', async () => {
  seed();
  await call('POST', '/api/folios/f1/payment-intents', { amountCents: 10000 });
  await call('POST', '/api/folios/f1/payment-intents', { amountCents: 20000, to: 'guest@example.com' });

  const r = await call('GET', '/api/folios/f1/payment-intents');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.equal(r.body[0].amountCents, '20000');
  assert.equal(r.body[0].sentTo, 'guest@example.com');
  assert.equal(r.body[1].sentTo, null);
});

test('listing intents for an unknown folio is a 404', async () => {
  seed();
  const r = await call('GET', '/api/folios/nope/payment-intents');
  assert.equal(r.status, 404);
});
