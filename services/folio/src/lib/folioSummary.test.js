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
