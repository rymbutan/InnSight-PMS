// Route-level tests for POST /api/folios/:id/void-transaction/:txId.
//
// THE BUG THIS FILE EXISTS FOR
// ----------------------------
// The reversal row copied `-original.taxAmountCents` but wrote NO
// `taxBreakdown`. The print model's pre-migration fallback then attributed that
// whole NEGATIVE figure to VAT, so a voided 10,000.00 taxed room night printed
//
//   Add : Room Tax | VAT -1,000.00 | Service Charge +1,000.00 | subtotal 0.00
//
// on the guest's bill. The balance and every subtotal stayed correct, which is
// exactly why nothing caught it. lib/folioPrintModel.test.js asserts the
// rendering side at component level; this file asserts what actually gets
// STORED, before any JSON round-trip.
//
//   node --test src/routes/folioVoid.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

// ── In-memory store ─────────────────────────────────────────────────────────

const memDb = { folioTransaction: new Map(), folioTransactionDispute: new Map() };
let seq = 0;
// The object handed to prisma.folioTransaction.create for the most recent void,
// inspected directly so the assertions below see what is stored rather than a
// serialised copy.
let lastCreateData = null;

const mockPrisma = {
  folio: { findUnique: async ({ where: { id } }) => ({ id, status: 'OPEN', currency: 'PHP' }) },
  folioTransaction: {
    findUnique: async ({ where: { id } }) => memDb.folioTransaction.get(id) || null,
    findFirst: async ({ where }) =>
      [...memDb.folioTransaction.values()].find((r) => r.reversalOf === where.reversalOf) || null,
    create: async ({ data }) => {
      lastCreateData = data;
      const id = `tx${(seq += 1)}`;
      const row = { id, postedAt: new Date(), ...data };
      memDb.folioTransaction.set(id, row);
      return row;
    },
  },
  payment: { updateMany: async () => ({ count: 0 }) },
  folioTransactionDispute: {
    upsert: async ({ where: { transactionId }, create }) => {
      const row = { id: `d${(seq += 1)}`, transactionId, ...create };
      memDb.folioTransactionDispute.set(transactionId, row);
      return row;
    },
    findUnique: async ({ where: { transactionId } }) => memDb.folioTransactionDispute.get(transactionId) || null,
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

// A 10,000.00 room night: VAT 1,200.00 + service charge 1,000.00.
const TAXED_BREAKDOWN = [
  { key: 'vat', label: 'VAT', rate: 12, amountCents: '120000' },
  { key: 'serviceCharge', label: 'Service Charge', rate: 10, amountCents: '100000' },
  { key: 'localTax', label: 'Local Tax', rate: 0, amountCents: '0' },
  { key: 'realPropertyTax', label: 'Real Property Tax', rate: 0, amountCents: '0' },
];

function seedCharge(overrides = {}) {
  memDb.folioTransaction.clear();
  memDb.folioTransactionDispute.clear();
  seq = 0;
  lastCreateData = null;
  const row = {
    id: 'orig', folioId: 'f1', type: 'CHARGE', chargeCode: 'RM', description: 'Room charge',
    amountCents: 1000000n, taxAmountCents: 220000n, taxBreakdown: TAXED_BREAKDOWN,
    reversalOf: null, reference: null,
    ...overrides,
  };
  memDb.folioTransaction.set(row.id, row);
  return row;
}

// ── The regression gate ─────────────────────────────────────────────────────

test('voiding a taxed charge writes the NEGATED breakdown, not a null', async () => {
  seedCharge();
  const res = await call('POST', '/api/folios/f1/void-transaction/orig', { reason: 'test reason' });
  assert.equal(res.status, 200);

  assert.ok(
    Array.isArray(lastCreateData.taxBreakdown),
    'a null here is what made the print fabricate a negative VAT line'
  );
  const by = Object.fromEntries(lastCreateData.taxBreakdown.map((b) => [b.key, b.amountCents]));
  assert.equal(by.vat, '-120000');
  assert.equal(by.serviceCharge, '-100000');
  assert.equal(by.localTax, '0');
  assert.equal(by.realPropertyTax, '0');
});

test('the reversed breakdown sums to the reversed taxAmountCents', async () => {
  seedCharge();
  await call('POST', '/api/folios/f1/void-transaction/orig', { reason: 'test reason' });
  const sum = lastCreateData.taxBreakdown.reduce((a, b) => a + BigInt(b.amountCents), 0n);
  // taxAmountCents stays the single source of truth for every total; the
  // breakdown is presentational and must never disagree with it.
  assert.equal(sum, BigInt(lastCreateData.taxAmountCents));
  assert.equal(lastCreateData.taxAmountCents, -220000n);
  assert.equal(lastCreateData.amountCents, -1000000n);
});

test('breakdown amounts stay decimal STRINGS, never BigInt', async () => {
  seedCharge();
  await call('POST', '/api/folios/f1/void-transaction/orig', { reason: 'test reason' });
  for (const entry of lastCreateData.taxBreakdown) {
    assert.equal(typeof entry.amountCents, 'string', `${entry.key} must be JSON-safe`);
  }
  // The label and rate ride along unchanged — a voided line names the same tax.
  assert.equal(lastCreateData.taxBreakdown.find((b) => b.key === 'vat').label, 'VAT');
  assert.equal(lastCreateData.taxBreakdown.find((b) => b.key === 'vat').rate, 12);
});

test('voiding a charge that has NO breakdown still writes none — nothing is invented', async () => {
  // Pre-migration rows know nothing about the split. Manufacturing one here
  // would put a fabricated component figure on a guest's bill; the print model
  // handles this pair by falling both rows back to VAT, where they net to zero.
  seedCharge({ taxBreakdown: null });
  const res = await call('POST', '/api/folios/f1/void-transaction/orig', { reason: 'test reason' });
  assert.equal(res.status, 200);
  assert.equal(lastCreateData.taxBreakdown, null);
  assert.equal(lastCreateData.taxAmountCents, -220000n);
});

test('voiding an untaxed charge is unaffected', async () => {
  seedCharge({ taxAmountCents: 0n, taxBreakdown: null });
  await call('POST', '/api/folios/f1/void-transaction/orig', { reason: 'test reason' });
  assert.equal(lastCreateData.taxAmountCents, 0n);
  assert.equal(lastCreateData.taxBreakdown, null);
});

test('the reversal still points at its original and keeps the existing guards', async () => {
  seedCharge();
  const first = await call('POST', '/api/folios/f1/void-transaction/orig', { reason: 'test reason' });
  assert.equal(first.status, 200);
  assert.equal(lastCreateData.reversalOf, 'orig');

  // A second void is refused, and a reversal is itself un-voidable.
  const second = await call('POST', '/api/folios/f1/void-transaction/orig', { reason: 'test reason' });
  assert.equal(second.status, 409);

  const reversalId = [...memDb.folioTransaction.values()].find((r) => r.reversalOf === 'orig').id;
  const third = await call('POST', `/api/folios/f1/void-transaction/${reversalId}`, { reason: 'test reason' });
  assert.equal(third.status, 400);
});

test('a cross-folio void is still refused', async () => {
  seedCharge();
  const res = await call('POST', '/api/folios/OTHER/void-transaction/orig', { reason: 'test reason' });
  assert.equal(res.status, 400);
});

// ── Dispute/cancel: reason + evidence (Reservations & Walk-Ins item 1) ──────

test('a void with no reason is refused', async () => {
  seedCharge();
  const res = await call('POST', '/api/folios/f1/void-transaction/orig');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /reason is required/i);
  assert.equal(memDb.folioTransaction.size, 1, 'a refused void must not post a reversal');
});

test('a void with a blank reason is refused', async () => {
  seedCharge();
  const res = await call('POST', '/api/folios/f1/void-transaction/orig', { reason: '   ' });
  assert.equal(res.status, 400);
});

test('the reversal is stamped with who posted it', async () => {
  // Previously null on every void — an anonymous reversal in a ledger
  // otherwise stamped with who posted every other line.
  seedCharge();
  await call('POST', '/api/folios/f1/void-transaction/orig', { reason: 'Guest disputes this charge' });
  assert.equal(lastCreateData.postedBy, 'tester');
});

test('disputing a charge files a dispute record with the reason and reversal id', async () => {
  seedCharge();
  const res = await call('POST', '/api/folios/f1/void-transaction/orig', {
    reason: 'Guest showed a screenshot proving they were never charged this at the desk.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.dispute.reason, 'Guest showed a screenshot proving they were never charged this at the desk.');
  assert.equal(res.body.dispute.filedBy, 'tester');
  assert.equal(res.body.dispute.transactionId, 'orig');
  assert.equal(res.body.dispute.reversalTransactionId, res.body.id);

  const stored = memDb.folioTransactionDispute.get('orig');
  assert.ok(stored, 'the dispute must be findable by the ORIGINAL transaction id');
});
