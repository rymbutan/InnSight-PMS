// Route-level tests for POST /api/folios/:id/payments — the per-method
// required-field validation (Dynamic Payment Selector spec: Card needs a
// masked card + cardholder name, Bank Transfer needs a bank, network, sender
// name AND its own reference/control number — nothing simulated for bank
// transfers any more), the "simulate a gateway reference" fallback that
// still applies to Card alone, and the proof-of-transfer upload/download
// routes for Bank Transfer.
//
// Also locks in the invariant this route (and the QR-confirm route) both
// depend on: the FolioTransaction's `reference` is ALWAYS the Payment's own
// id, never its gatewayRef — postRefund() looks the Payment row back up by
// exactly that field, and a QR-confirm bug once broke this by conflating the
// two (see folioPublicPaymentIntents.test.js).
//
//   node --test src/routes/folioPayments.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

let folioRow = null;
let payments = [];
let folioTransactions = [];
let paymentDocuments = new Map();
let feePercentValue = null; // null = unset (settingsStore falls back to 0)
let seq = 0;

const mockPrisma = {
  folio: {
    findUnique: async ({ where: { id } }) => (folioRow && id === folioRow.id ? folioRow : null),
  },
  appSetting: {
    findUnique: async ({ where: { key } }) =>
      key === 'payment_processing_fee_percent' && feePercentValue !== null
        ? { key, value: String(feePercentValue) }
        : null,
  },
  payment: {
    create: async ({ data }) => {
      const p = { id: `pay${(seq += 1)}`, ...data };
      payments.push(p);
      return p;
    },
    findFirst: async ({ where }) =>
      payments.find((p) => p.id === where.id && p.folioId === where.folioId) || null,
  },
  folioTransaction: {
    create: async ({ data }) => {
      const tx = { id: `tx${(seq += 1)}`, ...data };
      folioTransactions.push(tx);
      return tx;
    },
  },
  paymentDocument: {
    findUnique: async ({ where: { paymentId } }) => paymentDocuments.get(paymentId) || null,
    upsert: async ({ where: { paymentId }, create, update }) => {
      const doc = {
        id: paymentDocuments.get(paymentId)?.id || `doc${(seq += 1)}`,
        paymentId,
        ...(paymentDocuments.has(paymentId) ? update : create),
      };
      paymentDocuments.set(paymentId, doc);
      return doc;
    },
  },
  $transaction: async (fn) => fn(mockPrisma),
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

const storageState = { put: [], removed: [] };
require.cache[require.resolve('../lib/storage')] = {
  exports: {
    ensureBucket: async () => {},
    objectKeyFor: (paymentId, filename) => `payments/${paymentId}/test-${filename}`,
    putDocument: async (objectKey, buffer, contentType) => {
      storageState.put.push({ objectKey, size: buffer.length, contentType });
    },
    getDocumentStream: async () => {
      const { Readable } = require('node:stream');
      return Readable.from([Buffer.from('fake-file-bytes')]);
    },
    removeDocument: async (objectKey) => {
      storageState.removed.push(objectKey);
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
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const buf = Buffer.concat(chunks);
            const contentType = res.headers['content-type'] || '';
            const parsedBody = contentType.includes('application/json')
              ? buf.length
                ? JSON.parse(buf.toString())
                : null
              : buf;
            resolve({ status: res.statusCode, body: parsedBody, headers: res.headers });
          });
        }
      );
      if (data) req.write(data);
      req.end();
    });
  });
}

const VALID_CARD = {
  method: 'CARD',
  amountCents: 150000,
  cardMasked: 'VISA •••• 4242',
  cardholderName: 'Dela Cruz, Juan',
};
const VALID_BANK = {
  method: 'BANK_TRANSFER',
  amountCents: 150000,
  bankName: 'BDO',
  transferNetwork: 'InstaPay',
  senderName: 'Santos, Grace',
  reference: '20260910-8812',
};

function reset() {
  folioRow = { id: 'f1', status: 'OPEN' };
  payments = [];
  folioTransactions = [];
  paymentDocuments = new Map();
  feePercentValue = null;
  storageState.put = [];
  storageState.removed = [];
  seq = 0;
}

test('a fully-completed CARD payment posts, and gets a simulated AUTH- gatewayRef', async () => {
  reset();
  const r = await call('POST', '/api/folios/f1/payments', VALID_CARD);
  assert.equal(r.status, 201);
  assert.match(r.body.gatewayRef, /^AUTH-[0-9A-F]{12}$/);
  assert.equal(r.body.cardMasked, 'VISA •••• 4242');
  assert.equal(r.body.cardholderName, 'Dela Cruz, Juan');
});

test('a CARD payment with no cardMasked is refused', async () => {
  reset();
  const { cardMasked: _cardMasked, ...rest } = VALID_CARD;
  const r = await call('POST', '/api/folios/f1/payments', rest);
  assert.equal(r.status, 400);
  assert.equal(payments.length, 0);
});

test('a CARD payment with no cardholder name is refused', async () => {
  reset();
  const { cardholderName: _cardholderName, ...rest } = VALID_CARD;
  const r = await call('POST', '/api/folios/f1/payments', rest);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cardholder/i);
  assert.equal(payments.length, 0);
});

test('a fully-completed BANK_TRANSFER payment posts with its own reference — nothing simulated', async () => {
  reset();
  const r = await call('POST', '/api/folios/f1/payments', VALID_BANK);
  assert.equal(r.status, 201);
  assert.equal(r.body.gatewayRef, '20260910-8812');
  assert.equal(r.body.bankName, 'BDO');
  assert.equal(r.body.transferNetwork, 'InstaPay');
  assert.equal(r.body.senderName, 'Santos, Grace');
});

test('a BANK_TRANSFER payment with no bank reference is refused, not simulated', async () => {
  reset();
  const { reference: _reference, ...rest } = VALID_BANK;
  const r = await call('POST', '/api/folios/f1/payments', rest);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /bank reference|control number/i);
  assert.equal(payments.length, 0);
});

test('a BANK_TRANSFER payment with no bank name is refused', async () => {
  reset();
  const { bankName: _bankName, ...rest } = VALID_BANK;
  const r = await call('POST', '/api/folios/f1/payments', rest);
  assert.equal(r.status, 400);
  assert.equal(payments.length, 0);
});

test('a BANK_TRANSFER payment with no transfer network is refused', async () => {
  reset();
  const { transferNetwork: _transferNetwork, ...rest } = VALID_BANK;
  const r = await call('POST', '/api/folios/f1/payments', rest);
  assert.equal(r.status, 400);
  assert.equal(payments.length, 0);
});

test('a BANK_TRANSFER payment with no sender name is refused', async () => {
  reset();
  const { senderName: _senderName, ...rest } = VALID_BANK;
  const r = await call('POST', '/api/folios/f1/payments', rest);
  assert.equal(r.status, 400);
  assert.equal(payments.length, 0);
});

test('a BANK_TRANSFER transferredAt is stored as a real Date', async () => {
  reset();
  const r = await call('POST', '/api/folios/f1/payments', {
    ...VALID_BANK,
    transferredAt: '2026-09-10T08:15:00.000Z',
  });
  assert.equal(r.status, 201);
  assert.equal(payments[0].transferredAt.toISOString(), '2026-09-10T08:15:00.000Z');
});

test('an invalid transferredAt is refused', async () => {
  reset();
  const r = await call('POST', '/api/folios/f1/payments', { ...VALID_BANK, transferredAt: 'not-a-date' });
  assert.equal(r.status, 400);
});

test('a CASH payment gets no invented gatewayRef and needs none of the card/bank fields', async () => {
  reset();
  const r = await call('POST', '/api/folios/f1/payments', { method: 'CASH', amountCents: 150000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.gatewayRef, undefined);
});

test('a staff-supplied gatewayRef always wins over the simulated CARD one', async () => {
  reset();
  const r = await call('POST', '/api/folios/f1/payments', {
    ...VALID_CARD,
    gatewayRef: 'REAL-TERMINAL-CODE-123',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.gatewayRef, 'REAL-TERMINAL-CODE-123');
});

test('the ledger row references the Payment id, never its gatewayRef', async () => {
  reset();
  const r = await call('POST', '/api/folios/f1/payments', VALID_CARD);
  assert.equal(folioTransactions.length, 1);
  assert.equal(folioTransactions[0].reference, r.body.id);
  assert.notEqual(folioTransactions[0].reference, r.body.gatewayRef);
});

test('uploading a proof of transfer stores it via lib/storage and records its metadata', async () => {
  reset();
  const posted = await call('POST', '/api/folios/f1/payments', VALID_BANK);
  const paymentId = posted.body.id;

  const r = await call('POST', `/api/folios/f1/payments/${paymentId}/proof`, {
    filename: 'slip.jpg',
    contentType: 'image/jpeg',
    contentBase64: Buffer.from('fake-image-bytes').toString('base64'),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.filename, 'slip.jpg');
  assert.equal(storageState.put.length, 1);
  assert.match(storageState.put[0].objectKey, new RegExp(`payments/${paymentId}/`));
});

test('a second proof upload REPLACES the first rather than erroring', async () => {
  reset();
  const posted = await call('POST', '/api/folios/f1/payments', VALID_BANK);
  const paymentId = posted.body.id;

  await call('POST', `/api/folios/f1/payments/${paymentId}/proof`, {
    filename: 'first.jpg',
    contentType: 'image/jpeg',
    contentBase64: Buffer.from('one').toString('base64'),
  });
  const second = await call('POST', `/api/folios/f1/payments/${paymentId}/proof`, {
    filename: 'second.pdf',
    contentType: 'application/pdf',
    contentBase64: Buffer.from('two').toString('base64'),
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.filename, 'second.pdf');
  assert.equal(paymentDocuments.size, 1);
  assert.equal(storageState.removed.length, 1, 'the old object should have been removed');
});

test('uploading a proof for a payment on another folio is a 404', async () => {
  reset();
  const posted = await call('POST', '/api/folios/f1/payments', VALID_BANK);
  const r = await call('POST', `/api/folios/other-folio/payments/${posted.body.id}/proof`, {
    filename: 'slip.jpg',
    contentType: 'image/jpeg',
    contentBase64: Buffer.from('x').toString('base64'),
  });
  assert.equal(r.status, 404);
});

test('downloading a proof streams the stored file back', async () => {
  reset();
  const posted = await call('POST', '/api/folios/f1/payments', VALID_BANK);
  const paymentId = posted.body.id;
  await call('POST', `/api/folios/f1/payments/${paymentId}/proof`, {
    filename: 'slip.jpg',
    contentType: 'image/jpeg',
    contentBase64: Buffer.from('fake-image-bytes').toString('base64'),
  });

  const r = await call('GET', `/api/folios/f1/payments/${paymentId}/proof`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.equal(r.body.toString(), 'fake-file-bytes');
});

test('downloading a proof that was never uploaded is a 404', async () => {
  reset();
  const posted = await call('POST', '/api/folios/f1/payments', VALID_BANK);
  const r = await call('GET', `/api/folios/f1/payments/${posted.body.id}/proof`);
  assert.equal(r.status, 404);
});

test('a configured processing fee posts as its own CHARGE for a CARD payment', async () => {
  reset();
  feePercentValue = 2;
  const r = await call('POST', '/api/folios/f1/payments', VALID_CARD);
  assert.equal(r.status, 201);
  assert.equal(r.body.feePercent, 2);
  assert.equal(r.body.feeCents, '3000'); // 2% of 150000

  const feeTx = folioTransactions.find((t) => t.chargeCode === 'PF');
  assert.ok(feeTx, 'expected a PF charge on the ledger');
  assert.equal(feeTx.type, 'CHARGE');
  assert.equal(feeTx.amountCents, 3000n);
  assert.equal(feeTx.reference, `PROCESSINGFEE-${r.body.id}`);
});

test('a configured processing fee posts for a BANK_TRANSFER payment too', async () => {
  reset();
  feePercentValue = 1.5;
  const r = await call('POST', '/api/folios/f1/payments', VALID_BANK);
  assert.equal(r.status, 201);
  assert.equal(r.body.feeCents, '2250'); // 1.5% of 150000
  assert.ok(folioTransactions.some((t) => t.chargeCode === 'PF' && t.amountCents === 2250n));
});

test('no processing fee is invented for CASH, even with a fee percent configured', async () => {
  reset();
  feePercentValue = 5;
  const r = await call('POST', '/api/folios/f1/payments', { method: 'CASH', amountCents: 150000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.feeCents, '0');
  assert.equal(folioTransactions.filter((t) => t.chargeCode === 'PF').length, 0);
});

test('with no fee percent configured, a CARD payment posts no fee charge at all', async () => {
  reset();
  const r = await call('POST', '/api/folios/f1/payments', VALID_CARD);
  assert.equal(r.status, 201);
  assert.equal(r.body.feeCents, '0');
  assert.equal(folioTransactions.filter((t) => t.chargeCode === 'PF').length, 0);
});

test('the fee is a CHARGE on top of the payment, not a deduction from it', async () => {
  reset();
  feePercentValue = 2;
  const r = await call('POST', '/api/folios/f1/payments', VALID_CARD);
  const paymentTx = folioTransactions.find((t) => t.type === 'PAYMENT');
  assert.equal(paymentTx.amountCents, 150000n, 'the guest is credited the FULL amount they paid');
  assert.equal(r.body.amountCents, 150000n);
});
