// How much of a cancelled reservation's deposit is still owed back to the
// guest — what the cancellation fee did not already claim, less whatever has
// already been refunded. Pulled out of the route so the money math is
// testable without a database: it's exactly the kind of arithmetic that is
// easy to get backwards under a deadline (a fee bigger than the deposit, a
// second partial refund on top of the first).
//
// Never negative: cancellationFeeCents is computed off the booking's total
// estimate, not the deposit actually collected (see lib/policies.js), so a
// last-minute cancellation's fee can exceed the deposit outright. That
// shortfall is money the hotel is out, not something to claw back from a
// refund that was never that large to begin with.
function remainingDepositRefundCents(reservation) {
  const depositCents = Number(reservation.depositCents || 0);
  const feeCents = Number(reservation.cancellationFeeCents || 0);
  const refundedCents = Number(reservation.depositRefundedCents || 0);
  return Math.max(0, depositCents - feeCents - refundedCents);
}

module.exports = { remainingDepositRefundCents };
