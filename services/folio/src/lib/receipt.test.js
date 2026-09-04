const test = require('node:test');
const assert = require('node:assert');
const { receiptModel } = require('./receipt');

const PAYMENT = {
  id: '9f3c1a2b-0000-4000-8000-000000000001',
  amountCents: 250000n,
  method: 'CASH',
  status: 'CAPTURED',
  createdAt: new Date('2026-09-04T02:30:00Z'),
};
const FOLIO = { id: 'f1', folioNumber: 'F-000123', currency: 'PHP' };

test('the receipt number is derived from the folio and payment', () => {
  const m = receiptModel(PAYMENT, FOLIO, 'Santos, Grace');
  // Derived rather than sequential on purpose: a gapless official-receipt series
  // is a BIR requirement for a real hotel, and inventing one in a teaching system
  // would be teaching students the wrong thing. This is reproducible instead —
  // reprinting a receipt gives the same number rather than consuming a new one.
  assert.equal(m.receiptNumber, 'OR-F-000123-000000000001');
  assert.equal(m.folioNumber, 'F-000123');
});

test('the amount stays in cents and is never a float', () => {
  const m = receiptModel(PAYMENT, FOLIO, 'Santos, Grace');
  assert.equal(m.paidCents, 250000n);
  assert.equal(typeof m.paidCents, 'bigint');
});

test('the amount is spelled out for the words line', () => {
  const m = receiptModel(PAYMENT, FOLIO, 'Santos, Grace');
  assert.match(m.paidInWords, /TWO THOUSAND FIVE HUNDRED/);
});

test('a missing guest name renders as a dash, not "undefined"', () => {
  const m = receiptModel(PAYMENT, FOLIO, null);
  assert.equal(m.guestName, '—');
});

test('a voided payment cannot be receipted', () => {
  assert.throws(() => receiptModel({ ...PAYMENT, status: 'VOIDED' }, FOLIO, 'X'), /voided/i);
});

test('a failed payment cannot be receipted', () => {
  // Handing a guest proof of payment for a declined card is worse than no receipt.
  assert.throws(() => receiptModel({ ...PAYMENT, status: 'FAILED' }, FOLIO, 'X'), /not been captured|failed/i);
});

test('a refunded payment is still receipted, and says so', () => {
  // The original payment did happen; the receipt records history. Hiding it would
  // leave the guest unable to show what they had paid.
  const m = receiptModel({ ...PAYMENT, status: 'REFUNDED' }, FOLIO, 'Santos, Grace');
  assert.equal(m.refunded, true);
});

test('string amounts from JSON are coerced', () => {
  const m = receiptModel({ ...PAYMENT, amountCents: '250000' }, FOLIO, 'X');
  assert.equal(m.paidCents, 250000n);
});
