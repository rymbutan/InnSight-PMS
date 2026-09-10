const test = require('node:test');
const assert = require('node:assert');

const { cancellationFeeCents, paymentProcessingFeeCents } = require('./policies');

// Terms & Conditions, section 4 ("Cancellation, Refund Policies, and
// Administrative Deductions") — these tiers are the printed contract, not an
// implementation detail, so each assertion below maps to one bullet there.
const DAY = 24 * 3600 * 1000;

test('>= 72h before check-in: flat PHP 200 for a CASH deposit', () => {
  const fee = cancellationFeeCents({
    totalEstimateCents: 1000000,
    checkIn: new Date(Date.now() + 96 * 3600 * 1000),
    method: 'CASH',
  });
  assert.equal(fee, 20000);
});

test('>= 72h before check-in: 3% of total for a gateway-rail deposit', () => {
  const fee = cancellationFeeCents({
    totalEstimateCents: 1000000,
    checkIn: new Date(Date.now() + 96 * 3600 * 1000),
    method: 'CARD',
  });
  assert.equal(fee, 30000); // 3% of 1,000,000
});

test('24-72h before check-in: 50% fee regardless of method', () => {
  const fee = cancellationFeeCents({
    totalEstimateCents: 1000000,
    checkIn: new Date(Date.now() + 48 * 3600 * 1000),
    method: 'E_WALLET',
  });
  assert.equal(fee, 500000);
});

test('< 24h before check-in: 100% forfeiture', () => {
  const fee = cancellationFeeCents({
    totalEstimateCents: 1000000,
    checkIn: new Date(Date.now() + 12 * 3600 * 1000),
    method: 'CARD',
  });
  assert.equal(fee, 1000000);
});

test('past check-in (overdue auto-cancel): 100% forfeiture', () => {
  const fee = cancellationFeeCents({
    totalEstimateCents: 1000000,
    checkIn: new Date(Date.now() - DAY),
    method: 'CASH',
  });
  assert.equal(fee, 1000000);
});

test('non-refundable/promo tier: always 100%, even far out', () => {
  const fee = cancellationFeeCents({
    totalEstimateCents: 1000000,
    checkIn: new Date(Date.now() + 30 * DAY),
    method: 'CASH',
    isNonRefundable: true,
  });
  assert.equal(fee, 1000000);
});

test('paymentProcessingFeeCents: 0 when feePercent is not positive', () => {
  assert.equal(paymentProcessingFeeCents({ amountCents: 100000n, feePercent: 0 }), 0n);
  assert.equal(paymentProcessingFeeCents({ amountCents: 100000n, feePercent: -5 }), 0n);
});

test('paymentProcessingFeeCents: round-half-up on a percentage of the amount', () => {
  assert.equal(paymentProcessingFeeCents({ amountCents: 100000n, feePercent: 3.5 }), 3500n);
});
