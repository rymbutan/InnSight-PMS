const test = require('node:test');
const assert = require('node:assert/strict');

const { remainingDepositRefundCents } = require('./depositRefund');

test('a deposit with no fee and no prior refund is refundable in full', () => {
  assert.equal(
    remainingDepositRefundCents({ depositCents: 500000, cancellationFeeCents: 0, depositRefundedCents: 0 }),
    500000
  );
});

test('the cancellation fee is subtracted from what is refundable', () => {
  assert.equal(
    remainingDepositRefundCents({ depositCents: 500000, cancellationFeeCents: 150000, depositRefundedCents: 0 }),
    350000
  );
});

test('a prior partial refund is subtracted too, so it cannot be paid twice', () => {
  assert.equal(
    remainingDepositRefundCents({
      depositCents: 500000,
      cancellationFeeCents: 150000,
      depositRefundedCents: 200000,
    }),
    150000
  );
});

test('a fee larger than the deposit floors at zero, not negative', () => {
  // cancellationFeeCents is computed off the booking's TOTAL, not the
  // deposit (see lib/policies.js) — a last-minute cancellation can make it
  // exceed the deposit outright. That shortfall is the hotel's loss, not a
  // negative number to claw back from a refund.
  assert.equal(
    remainingDepositRefundCents({ depositCents: 100000, cancellationFeeCents: 250000, depositRefundedCents: 0 }),
    0
  );
});

test('missing fields default to zero rather than throwing', () => {
  assert.equal(remainingDepositRefundCents({ depositCents: 100000 }), 100000);
  assert.equal(remainingDepositRefundCents({}), 0);
});

test('BigInt fields (as Prisma returns them) work the same as plain numbers', () => {
  assert.equal(
    remainingDepositRefundCents({
      depositCents: 500000n,
      cancellationFeeCents: 150000n,
      depositRefundedCents: 200000n,
    }),
    150000
  );
});
