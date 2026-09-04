const test = require('node:test');
const assert = require('node:assert');

const { classifyTransactions } = require('./folioSummary');

const ROOM_CODES = new Set(['RM']);

test('classifies a room charge with tax, plus a payment', () => {
  const result = classifyTransactions(
    [
      { type: 'CHARGE', chargeCode: 'RM', amountCents: 500000n, taxAmountCents: 60000n },
      { type: 'PAYMENT', chargeCode: null, amountCents: 300000n, taxAmountCents: 0n },
    ],
    ROOM_CODES
  );
  assert.equal(result.roomChargeCents, 500000n);
  assert.equal(result.extraChargeCents, 0n);
  assert.equal(result.taxCents, 60000n);
  assert.equal(result.totalChargesCents, 560000n);
  assert.equal(result.netPaymentsCents, 300000n);
  assert.equal(result.balanceCents, 260000n);
});

test('a non-room charge code is classified as an extra charge', () => {
  const result = classifyTransactions(
    [{ type: 'CHARGE', chargeCode: 'MB', amountCents: 15000n, taxAmountCents: 0n }],
    ROOM_CODES
  );
  assert.equal(result.roomChargeCents, 0n);
  assert.equal(result.extraChargeCents, 15000n);
});

test('a refund reduces net payments, not total charges', () => {
  const result = classifyTransactions(
    [
      { type: 'PAYMENT', chargeCode: null, amountCents: 100000n, taxAmountCents: 0n },
      { type: 'REFUND', chargeCode: null, amountCents: 20000n, taxAmountCents: 0n },
    ],
    ROOM_CODES
  );
  assert.equal(result.paymentsCents, 100000n);
  assert.equal(result.refundsCents, 20000n);
  assert.equal(result.netPaymentsCents, 80000n);
});

test('a negative adjustment (a credit) reduces the balance', () => {
  const result = classifyTransactions(
    [
      { type: 'CHARGE', chargeCode: 'RM', amountCents: 100000n, taxAmountCents: 0n },
      { type: 'ADJUSTMENT', chargeCode: null, amountCents: -50000n, taxAmountCents: 0n },
    ],
    ROOM_CODES
  );
  assert.equal(result.adjustmentsCents, -50000n);
  assert.equal(result.balanceCents, 50000n);
});

test('empty transaction list is all zeros', () => {
  const result = classifyTransactions([], ROOM_CODES);
  assert.equal(result.totalChargesCents, 0n);
  assert.equal(result.balanceCents, 0n);
});

// ── Facility revenue ────────────────────────────────────────────────────────
// The client asked for walk-in facility transactions to be auditable on their own
// line. Facility charges used to fall into extraChargeCents alongside minibar and
// laundry, so pool and function-hall income could not be reported separately.

test('facility charges are counted apart from other extras', () => {
  const result = classifyTransactions(
    [
      { type: 'CHARGE', chargeCode: 'RM', amountCents: 500000n, taxAmountCents: 0n },
      { type: 'CHARGE', chargeCode: 'POOL', amountCents: 20000n, taxAmountCents: 0n },
      { type: 'CHARGE', chargeCode: 'MB', amountCents: 15000n, taxAmountCents: 0n },
    ],
    { roomCodes: new Set(['RM']), facilityCodes: new Set(['POOL']) }
  );
  assert.equal(result.roomChargeCents, 500000n);
  assert.equal(result.facilityChargeCents, 20000n);
  assert.equal(result.extraChargeCents, 15000n, 'a facility charge must not also land in extras');
});

test('facility charges are still billed — they count towards the total', () => {
  const result = classifyTransactions(
    [{ type: 'CHARGE', chargeCode: 'HALL', amountCents: 80000n, taxAmountCents: 9600n }],
    { roomCodes: new Set(['RM']), facilityCodes: new Set(['HALL']) }
  );
  assert.equal(result.totalChargesCents, 89600n, 'reclassifying must not lose the money');
  assert.equal(result.balanceCents, 89600n);
});

test('a bare Set still means roomCodes', () => {
  // Back-compat: the statement and print routes call this with a positional Set.
  const result = classifyTransactions(
    [{ type: 'CHARGE', chargeCode: 'RM', amountCents: 1000n, taxAmountCents: 0n }],
    new Set(['RM'])
  );
  assert.equal(result.roomChargeCents, 1000n);
  assert.equal(result.facilityChargeCents, 0n);
});

test('with no facility codes configured nothing changes', () => {
  const result = classifyTransactions(
    [{ type: 'CHARGE', chargeCode: 'POOL', amountCents: 20000n, taxAmountCents: 0n }],
    { roomCodes: new Set(['RM']) }
  );
  assert.equal(result.facilityChargeCents, 0n);
  assert.equal(result.extraChargeCents, 20000n);
});
