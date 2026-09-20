// Route-level tests for POST /api/folios/:id/split.
//
// lib/split.test.js covers the arithmetic. This file covers what the ROUTE does
// with it: which requests it refuses and why, that a dry run writes nothing, and
// that every payer's folio — the source folio included — ends up named.
//
// The failure this guards hardest against is a dry run that disagrees with the
// real split. The dialog shows the operator dry-run figures and then asks them
// to confirm; if the two paths can differ, the confirmation is meaningless.
//
//   node --test src/routes/folioSplit.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

// ── In-memory store ─────────────────────────────────────────────────────────

const memDb = { folio: new Map(), folioTransaction: new Map() };
let seq = 0;
let txSeq = 0;
let transactionCalls = 0;

function folioRow(id, over = {}) {
  return {
    id,
    folioNumber: `F-${id}`,
    stayId: 'stay1',
    guestId: 'guest1',
    payerName: null,
    type: 'GUEST',
    status: 'OPEN',
    currency: 'PHP',
    openedAt: new Date(),
    ...over,
  };
}

const folioDelegate = {
  findUnique: async ({ where: { id } }) => {
    const f = memDb.folio.get(id);
    if (!f) return null;
    return {
      ...f,
      transactions: [...memDb.folioTransaction.values()].filter((t) => t.folioId === id),
    };
  },
  findMany: async ({ where = {} } = {}) =>
    [...memDb.folio.values()].filter(
      (f) =>
        (where.stayId === undefined || f.stayId === where.stayId) &&
        (where.id?.not === undefined || f.id !== where.id.not)
    ),
  create: async ({ data }) => {
    const id = `new${(seq += 1)}`;
    const row = folioRow(id, { ...data });
    memDb.folio.set(id, row);
    return row;
  },
  update: async ({ where: { id }, data }) => {
    const row = { ...memDb.folio.get(id), ...data };
    memDb.folio.set(id, row);
    return row;
  },
};

const txDelegate = {
  findUnique: async ({ where: { id } }) => memDb.folioTransaction.get(id) || null,
  findFirst: async ({ where }) =>
    [...memDb.folioTransaction.values()].find((r) => r.reversalOf === where.reversalOf) || null,
  findMany: async ({ where = {} } = {}) =>
    [...memDb.folioTransaction.values()].filter(
      (t) => where.folioId === undefined || t.folioId === where.folioId
    ),
  create: async ({ data }) => {
    const id = `t${(txSeq += 1)}`;
    const row = { id, postedAt: new Date(), ...data };
    memDb.folioTransaction.set(id, row);
    return row;
  },
};

const mockPrisma = {
  folio: folioDelegate,
  folioTransaction: txDelegate,
  chargeCode: { findMany: async () => [] },
  payment: { updateMany: async () => ({ count: 0 }) },
  // void-transaction files a dispute record alongside the reversal it posts
  // — not this file's concern (folioVoid.test.js covers its shape), just
  // needs to not throw here.
  folioTransactionDispute: { upsert: async ({ create }) => ({ id: 'd1', ...create }) },
  // Interactive form only — the split issues everything through one callback so
  // it cannot half-apply.
  $transaction: async (fn) => {
    transactionCalls += 1;
    if (typeof fn === 'function') return fn(mockPrisma);
    return Promise.all(fn);
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

// A folio with a ₱5,600 room night and a ₱150 minibar charge.
function seed(folioOver = {}, transactions = null) {
  memDb.folio.clear();
  memDb.folioTransaction.clear();
  seq = 0;
  txSeq = 0;
  transactionCalls = 0;
  memDb.folio.set('src', folioRow('src', folioOver));
  const rows =
    transactions ||
    [
      {
        id: 'rm1', folioId: 'src', type: 'CHARGE', chargeCode: 'RM', description: 'Room charge',
        amountCents: 560000n, taxAmountCents: 67200n, taxBreakdown: null, quantity: 1,
      },
      {
        id: 'mb1', folioId: 'src', type: 'CHARGE', chargeCode: 'MB', description: 'Minibar',
        amountCents: 15000n, taxAmountCents: 1800n, taxBreakdown: null, quantity: 1,
      },
    ];
  for (const r of rows) memDb.folioTransaction.set(r.id, { postedAt: new Date(), ...r });
}

const TWO = [{ payerName: 'Arym Vendiola', percent: 60 }, { payerName: 'Bartolome Vendiola', percent: 40 }];

// ── Validation ──────────────────────────────────────────────────────────────

test('an unknown method is refused', async () => {
  seed();
  const r = await call('POST', '/api/folios/src/split', { method: 'HALVES', payers: TWO });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /EQUAL|PERCENT/);
});

test('fewer than two payers is not a split', async () => {
  seed();
  const r = await call('POST', '/api/folios/src/split', {
    method: 'PERCENT',
    payers: [{ payerName: 'Solo', percent: 100 }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /2 and 8/);
});

test('more than eight payers is refused', async () => {
  seed();
  const payers = Array.from({ length: 9 }, (_, i) => ({ payerName: `P${i}`, percent: 100 / 9 }));
  const r = await call('POST', '/api/folios/src/split', { method: 'EQUAL', payers });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /2 and 8/);
});

test('a payer with no name is refused, not silently defaulted', async () => {
  // A folio that cannot say who it bills is the exact problem this feature was
  // extended to fix, so it must not be possible to create one.
  seed();
  const r = await call('POST', '/api/folios/src/split', {
    method: 'PERCENT',
    payers: [{ payerName: 'Named', percent: 50 }, { payerName: '   ', percent: 50 }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /name/i);
});

test('an over-long payer name is refused', async () => {
  seed();
  const r = await call('POST', '/api/folios/src/split', {
    method: 'PERCENT',
    payers: [{ payerName: 'A'.repeat(121), percent: 50 }, { payerName: 'B', percent: 50 }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /120/);
});

test('shares that do not add up to 100% are refused', async () => {
  seed();
  const r = await call('POST', '/api/folios/src/split', {
    method: 'PERCENT',
    payers: [{ payerName: 'A', percent: 60 }, { payerName: 'B', percent: 30 }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /100/);
});

test('thirds that do not sum to a round 100 are still accepted', async () => {
  // 33.33 + 33.33 + 33.34 is a legitimate three-way split and must not be
  // rejected by float arithmetic.
  seed();
  const r = await call('POST', '/api/folios/src/split', {
    method: 'PERCENT',
    dryRun: true,
    payers: [
      { payerName: 'A', percent: 33.33 },
      { payerName: 'B', percent: 33.33 },
      { payerName: 'C', percent: 33.34 },
    ],
  });
  assert.equal(r.status, 200);
});

test('a zero or negative share is refused', async () => {
  seed();
  for (const percent of [0, -10]) {
    const r = await call('POST', '/api/folios/src/split', {
      method: 'PERCENT',
      payers: [{ payerName: 'A', percent: 100 - percent }, { payerName: 'B', percent }],
    });
    assert.equal(r.status, 400);
  }
});

test('EQUAL ignores any percentages sent with it', async () => {
  // Nothing sensible can be sent for "100 divided by 3", so the server derives
  // equal shares rather than trusting whatever the client rounded to.
  seed();
  const r = await call('POST', '/api/folios/src/split', {
    method: 'EQUAL',
    dryRun: true,
    payers: [
      { payerName: 'A', percent: 1 },
      { payerName: 'B', percent: 1 },
      { payerName: 'C', percent: 1 },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.payers.length, 3);
  const totals = r.body.payers.map((p) => BigInt(p.totalCents));
  assert.equal(totals[0] + totals[1] + totals[2], 560000n + 67200n + 15000n + 1800n);
});

// ── Folio guards ────────────────────────────────────────────────────────────

test('a missing folio is a 404', async () => {
  seed();
  const r = await call('POST', '/api/folios/nope/split', { method: 'PERCENT', payers: TWO });
  assert.equal(r.status, 404);
});

test('a closed folio cannot be split', async () => {
  seed({ status: 'CLOSED' });
  const r = await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /open/i);
});

test('a walk-in folio with no stay cannot be split', async () => {
  // The transfer guard refuses to move charges off a POS sale; a split must not
  // become a way around it.
  seed({ stayId: null });
  const r = await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /stay/i);
});

test('a folio with nothing divisible left is refused rather than reported a success', async () => {
  seed({}, [
    { id: 'p1', folioId: 'src', type: 'PAYMENT', description: 'Cash', amountCents: 100000n, taxAmountCents: 0n },
  ]);
  const r = await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no charges/i);
});

test('a folio whose charges are already fully split is refused', async () => {
  seed({}, [
    {
      id: 'rm1', folioId: 'src', type: 'CHARGE', chargeCode: 'RM', description: 'Room charge',
      amountCents: 560000n, taxAmountCents: 67200n, taxBreakdown: null,
    },
    {
      id: 'tr1', folioId: 'src', type: 'TRANSFER', chargeCode: 'RM', description: 'moved',
      amountCents: -560000n, taxAmountCents: -67200n, reversalOf: 'rm1',
    },
  ]);
  const r = await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  assert.equal(r.status, 409);
});

// ── Dry run ─────────────────────────────────────────────────────────────────

test('a dry run writes nothing at all', async () => {
  seed();
  const before = { folios: memDb.folio.size, txs: memDb.folioTransaction.size };
  const r = await call('POST', '/api/folios/src/split', { method: 'PERCENT', dryRun: true, payers: TWO });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(memDb.folio.size, before.folios, 'no folio may be opened by a preview');
  assert.equal(memDb.folioTransaction.size, before.txs, 'no row may be posted by a preview');
  assert.equal(memDb.folio.get('src').payerName, null, 'a preview must not name the source folio');
});

test('a dry run predicts exactly what the real split then produces', async () => {
  // The dialog shows these figures and asks the operator to confirm them. If the
  // two paths can disagree, that confirmation means nothing.
  seed();
  const dry = await call('POST', '/api/folios/src/split', { method: 'PERCENT', dryRun: true, payers: TWO });
  seed();
  const real = await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  assert.equal(real.status, 201);
  assert.deepEqual(
    dry.body.payers.map((p) => [p.payerName, p.totalCents]),
    real.body.payers.map((p) => [p.payerName, p.totalCents])
  );
});

// ── The split itself ────────────────────────────────────────────────────────

test('a split opens one folio per additional payer and names every one', async () => {
  seed();
  const r = await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  assert.equal(r.status, 201);
  assert.equal(r.body.folios.length, 2);
  assert.deepEqual(
    r.body.folios.map((f) => f.payerName),
    ['Arym Vendiola', 'Bartolome Vendiola']
  );
});

test('the SOURCE folio is named too, not just the folios the split opens', async () => {
  // Without this the folio keeping the largest share is the one document that
  // still cannot say who it bills.
  seed();
  await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  assert.equal(memDb.folio.get('src').payerName, 'Arym Vendiola');
});

test('new folios inherit the stay, guest, type and currency of the source', async () => {
  seed();
  await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  const opened = [...memDb.folio.values()].filter((f) => f.id !== 'src');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].stayId, 'stay1');
  assert.equal(opened[0].guestId, 'guest1');
  assert.equal(opened[0].currency, 'PHP');
});

test('every folio number a split creates is distinct', async () => {
  // nextFolioNumber() is Date.now() plus three random digits, and these are
  // created inside one millisecond — a collision would abort the whole split
  // against a @unique column.
  seed();
  const payers = Array.from({ length: 8 }, (_, i) => ({ payerName: `Payer ${i}`, percent: 12.5 }));
  const r = await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers });
  assert.equal(r.status, 201);
  const numbers = r.body.folios.map((f) => f.folioNumber);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('the whole split is issued inside one transaction', async () => {
  seed();
  await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  assert.equal(transactionCalls, 1, 'a half-applied split would invent or destroy money');
});

test('the rows written are TRANSFER pairs that net to zero', async () => {
  seed();
  await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  const written = [...memDb.folioTransaction.values()].filter((t) => t.sourceSystem === 'split');
  assert.ok(written.length > 0);
  assert.equal(
    written.reduce((a, t) => a + BigInt(t.amountCents), 0n),
    0n
  );
  assert.equal(
    written.reduce((a, t) => a + BigInt(t.taxAmountCents), 0n),
    0n
  );
  assert.ok(written.every((t) => t.type === 'TRANSFER'));
});

test("split rows are tagged 'split', so the audit trail can tell them from a manual move", async () => {
  seed();
  await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  const written = [...memDb.folioTransaction.values()].filter((t) => t.reversalOf);
  assert.ok(written.length > 0);
  assert.ok(written.every((t) => t.sourceSystem === 'split'));
  assert.ok(written.every((t) => t.postedBy === 'tester'));
});

test('a payment on the folio is left where it was taken', async () => {
  // Moving it would say someone paid who did not.
  seed({}, [
    {
      id: 'rm1', folioId: 'src', type: 'CHARGE', chargeCode: 'RM', description: 'Room charge',
      amountCents: 560000n, taxAmountCents: 0n, taxBreakdown: null,
    },
    { id: 'p1', folioId: 'src', type: 'PAYMENT', description: 'Cash', amountCents: 100000n, taxAmountCents: 0n },
  ]);
  await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  const moved = [...memDb.folioTransaction.values()].filter((t) => t.reversalOf === 'p1');
  assert.equal(moved.length, 0);
});

// ── The void guard's honest reason ──────────────────────────────────────────

test('a split charge is refused for being split, not for being voided', async () => {
  // reversalOf means both "voids that row" and "is half of a transfer pair".
  // Both block a void and should, but reporting a transferred charge as already
  // voided sends the desk hunting for a void that never happened.
  seed();
  await call('POST', '/api/folios/src/split', { method: 'PERCENT', payers: TWO });
  const r = await call('POST', '/api/folios/src/void-transaction/rm1', { reason: 'test reason' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /split or transferred/i);
  assert.doesNotMatch(r.body.error, /already been voided/i);
});

test('a genuinely voided charge still reports that it was voided', async () => {
  seed();
  const first = await call('POST', '/api/folios/src/void-transaction/rm1', { reason: 'test reason' });
  assert.equal(first.status, 200);
  const second = await call('POST', '/api/folios/src/void-transaction/rm1', { reason: 'test reason' });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already been voided/i);
});
