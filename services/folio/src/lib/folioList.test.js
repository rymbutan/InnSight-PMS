const test = require('node:test');
const assert = require('node:assert');

const { folioListRow } = require('./folioList');

const CODES = { roomCodes: new Set(['RM']), facilityCodes: new Set(['POOL']) };

test('the row balance matches the classifier the bill is computed from', () => {
  const row = folioListRow(
    {
      id: 'f1', folioNumber: 'F-00011', status: 'OPEN', currency: 'PHP',
      stayId: 's1', guestId: 'g1', openedAt: new Date('2026-09-01T00:00:00.000Z'),
      transactions: [
        { type: 'CHARGE', chargeCode: 'RM', amountCents: 2535000n, taxAmountCents: 557700n },
        { type: 'PAYMENT', chargeCode: null, amountCents: 100000n, taxAmountCents: 0n },
      ],
    },
    CODES,
    'Jana Felismino'
  );
  assert.equal(row.folioNumber, 'F-00011');
  assert.equal(row.guestName, 'Jana Felismino');
  // 25,350.00 + 5,577.00 tax - 1,000.00 paid = 29,927.00
  assert.equal(row.balanceCents, '2992700');
});

test('balanceCents is a string, because JSON cannot carry BigInt', () => {
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', transactions: [] },
    CODES, null
  );
  assert.equal(typeof row.balanceCents, 'string');
  assert.equal(row.balanceCents, '0');
});

test('an unresolved guest name degrades to null rather than failing the row', () => {
  // The list must still render when the guest service is unreachable -- a folio
  // list that 500s because a NAME could not be fetched is a worse regression
  // than the missing search it replaces.
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', transactions: [] },
    CODES, undefined
  );
  assert.equal(row.guestName, null);
  assert.equal(row.folioNumber, 'F-1');
});

test('the transactions array is not leaked into the row', () => {
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP',
      transactions: [{ type: 'CHARGE', chargeCode: 'RM', amountCents: 100n, taxAmountCents: 0n }] },
    CODES, null
  );
  assert.equal(row.transactions, undefined, 'a list row must not carry a full ledger');
});
