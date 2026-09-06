// Route-level tests for POST /api/folios/:id/charges — specifically the tax
// wiring added in the "persist the per-component tax breakdown and compute tax
// on posting" task.
//
// WHY THIS FILE EXISTS
// --------------------
// folioSummary.test.js proves classifyTransactions is INDIFFERENT to
// taxBreakdown (by design — see that file's two newest tests). That is the
// correct behaviour for classifyTransactions, but it means nothing in this repo
// actually locks in what the charges ROUTE itself does: whether tax gets
// computed at all, whether an explicit taxAmountCents (including the falsy
// zero) still wins over computeTax, whether a non-taxable charge code is
// respected, whether quantity is applied before tax, and whether the stored
// breakdown is JSON-safe (decimal strings, not BigInt). This route changes
// what a guest is billed, so hand-traced correctness is not a substitute for a
// regression gate here.
//
//   node --test src/routes/folioCharges.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// Production sets this once, globally, in src/index.js before mounting routes
// (BigInt has no native toJSON, so res.json() would otherwise throw on any
// BigInt field). This test drives the route over real HTTP, so it needs the
// same patch to round-trip amountCents/taxAmountCents through the response.
BigInt.prototype.toJSON = function () {
  return this.toString();
};

// ── In-memory Folio / ChargeCode / FolioTransaction store ──────────────────

const memDb = { folio: new Map(), chargeCode: new Map() };
let seq = 0;
// The exact object handed to prisma.folioTransaction.create for the most
// recent POST — inspected directly (before any JSON round-trip) so the
// BigInt-vs-string assertions below test what actually gets stored, not a
// serialised copy that a global toJSON patch could paper over.
let lastCreateData = null;

const mockPrisma = {
  folio: {
    findUnique: async ({ where: { id } }) => memDb.folio.get(id) || null,
  },
  chargeCode: {
    findUnique: async ({ where: { code } }) => memDb.chargeCode.get(code) || null,
  },
  folioTransaction: {
    create: async ({ data }) => {
      lastCreateData = data;
      const id = `tx${(seq += 1)}`;
      return { id, postedAt: new Date(), ...data };
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

// getTaxRates() is Prisma-backed (reads AppSetting). Pinned here to fixed
// values so the expected tax figures below never drift with whatever an
// operator last saved — vat 12 / serviceCharge 10 / localTax 0 /
// realPropertyTax 0 are the documented Philippine defaults.
const FIXED_RATES = { vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 };
require.cache[require.resolve('../lib/settingsStore')] = {
  exports: {
    getTaxRates: async () => ({ ...FIXED_RATES }),
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

function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const data = body !== undefined ? JSON.stringify(body) : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: { 'Content-Type': 'application/json', ...(data && { 'Content-Length': Buffer.byteLength(data) }) },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
        }
      );
      if (data) req.write(data);
      req.end();
    });
  });
}

function reset() {
  memDb.folio.clear();
  memDb.chargeCode.clear();
  seq = 0;
  lastCreateData = null;
  memDb.folio.set('f1', { id: 'f1', status: 'OPEN' });
  memDb.chargeCode.set('RM', {
    code: 'RM', name: 'Room Charge', category: 'ROOM', taxable: true, glAccount: null, createdAt: new Date(),
  });
  memDb.chargeCode.set('NOTAX', {
    code: 'NOTAX', name: 'No-Tax Item', category: 'ROOM', taxable: false, glAccount: null, createdAt: new Date(),
  });
}

function post(body) {
  return call(makeApp(), 'POST', '/api/folios/f1/charges', body);
}

// ── 1. No taxAmountCents supplied → computeTax runs ─────────────────────────

test('a charge with no taxAmountCents gets tax computed', async () => {
  reset();
  const res = await post({ chargeCode: 'RM', amountCents: 2535000 });
  assert.equal(res.status, 201);
  assert.equal(lastCreateData.amountCents, 2535000n);
  assert.equal(lastCreateData.taxAmountCents, 557700n, 'VAT 12% + SC 10% of 2,535,000');
  assert.equal(lastCreateData.taxBreakdown.find((b) => b.key === 'vat').amountCents, '304200');
  assert.equal(lastCreateData.taxBreakdown.find((b) => b.key === 'serviceCharge').amountCents, '253500');
  // Round-tripped through real HTTP too, not just the captured create() call.
  assert.equal(res.body.taxAmountCents, '557700');
});

// ── 2. Explicit taxAmountCents: 0 — the falsy-zero trap ─────────────────────

test('an explicit taxAmountCents of 0 wins — computeTax is not consulted', async () => {
  reset();
  const res = await post({ chargeCode: 'RM', amountCents: 100000, taxAmountCents: 0 });
  assert.equal(res.status, 201);
  assert.equal(lastCreateData.taxAmountCents, 0n);
  assert.equal(lastCreateData.taxBreakdown, null, 'a caller-supplied figure — even zero — must not get a computed breakdown');
});

// ── 3. Explicit non-zero taxAmountCents — the night-audit path ──────────────

test('an explicit non-zero taxAmountCents wins and is multiplied by quantity', async () => {
  reset();
  const res = await post({ chargeCode: 'RM', amountCents: 50000, taxAmountCents: 5000, quantity: 2 });
  assert.equal(res.status, 201);
  assert.equal(lastCreateData.amountCents, 100000n, 'base × quantity');
  assert.equal(lastCreateData.taxAmountCents, 10000n, 'the SUPPLIED tax × quantity, not a recomputed figure');
  assert.equal(lastCreateData.taxBreakdown, null);
});

// ── 4. A non-taxable charge code attracts no tax ────────────────────────────

test('a charge code marked taxable:false attracts no tax and stores no breakdown', async () => {
  reset();
  const res = await post({ chargeCode: 'NOTAX', amountCents: 75000 });
  assert.equal(res.status, 201);
  assert.equal(lastCreateData.taxAmountCents, 0n);
  assert.equal(lastCreateData.taxBreakdown, null);
});

// ── 5. quantity multiplies the base BEFORE tax is computed ──────────────────

test('quantity multiplies the base before tax, not the other way round', async () => {
  reset();
  // Chosen so that computing tax once on the full line (208) and computing it
  // per unit (104) then multiplying by quantity give DIFFERENT answers —
  // rounding-half-up at 104 truncates below the total's rounding boundary.
  // If a future change computed tax on the unit amount and multiplied the
  // resulting tax by quantity, this would silently under-tax the line and
  // this assertion would catch it (44 instead of 46).
  const res = await post({ chargeCode: 'RM', amountCents: 104, quantity: 2 });
  assert.equal(res.status, 201);
  assert.equal(lastCreateData.amountCents, 208n);
  assert.equal(lastCreateData.taxAmountCents, 46n, 'tax on the full 208-cent line, not 2× the tax on 104');
});

// ── 6. Unknown / absent chargeCode falls back to category OTHER, still taxed ─

test('an absent chargeCode falls back to category OTHER and is still taxed', async () => {
  reset();
  const res = await post({ amountCents: 100000 }); // no chargeCode at all
  assert.equal(res.status, 201);
  assert.equal(lastCreateData.taxAmountCents, 22000n, 'OTHER is not in the untaxed set — the safer failure direction');
  assert.ok(Array.isArray(lastCreateData.taxBreakdown) && lastCreateData.taxBreakdown.length === 4);
});

test('an unrecognised chargeCode also falls back to category OTHER and is still taxed', async () => {
  reset();
  const res = await post({ chargeCode: 'DOES-NOT-EXIST', amountCents: 100000 });
  assert.equal(res.status, 201);
  assert.equal(lastCreateData.taxAmountCents, 22000n);
});

// ── 7. Stored breakdown amounts are decimal strings, not BigInt ─────────────

test('taxBreakdown amounts are stored as strings, never BigInt', async () => {
  reset();
  await post({ chargeCode: 'RM', amountCents: 2535000 });
  for (const entry of lastCreateData.taxBreakdown) {
    assert.equal(typeof entry.amountCents, 'string', `${entry.key} must be a JSON-safe decimal string, not a BigInt`);
  }
});
