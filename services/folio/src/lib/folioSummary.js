// Pure classification of a folio's transactions into the sections a printed
// guest receipt shows. No Prisma, no HTTP, no pdfkit, so the arithmetic that
// decides what a guest is billed can be unit-tested without a database.
//
// roomCodes: a Set of ChargeCode.code values whose category is 'ROOM'. Room
// revenue is classified by the charge code's category, not a hardcoded
// string — the seeded room code is 'RM', not 'ROOM' (see the identical
// convention in the daily-totals route in folio.routes.js).
function classifyTransactions(transactions, roomCodes) {
  let roomChargeCents = 0n;
  let extraChargeCents = 0n;
  let taxCents = 0n;
  let paymentsCents = 0n;
  let refundsCents = 0n;
  let adjustmentsCents = 0n;

  for (const tx of transactions) {
    const amount = BigInt(tx.amountCents);
    const tax = BigInt(tx.taxAmountCents || 0);
    if (tx.type === 'CHARGE') {
      if (roomCodes.has(tx.chargeCode)) roomChargeCents += amount;
      else extraChargeCents += amount;
      taxCents += tax;
    } else if (tx.type === 'PAYMENT') {
      paymentsCents += amount;
    } else if (tx.type === 'REFUND') {
      refundsCents += amount;
    } else if (tx.type === 'ADJUSTMENT') {
      adjustmentsCents += amount; // may be negative — a credit
    }
    // A standalone TAX-type transaction is never actually created anywhere in
    // this codebase (tax always rides on a CHARGE's taxAmountCents), so there
    // is deliberately no branch for it here.
  }

  const totalChargesCents = roomChargeCents + extraChargeCents + taxCents;
  // Mirrors the balance formula in the daily-totals endpoint and the original
  // print route: a refund reduces net payments taken; a positive adjustment
  // increases what's owed, a negative one (a credit) reduces it.
  const netPaymentsCents = paymentsCents - refundsCents;
  const balanceCents = totalChargesCents - netPaymentsCents + adjustmentsCents;

  return {
    roomChargeCents,
    extraChargeCents,
    taxCents,
    totalChargesCents,
    paymentsCents,
    refundsCents,
    netPaymentsCents,
    adjustmentsCents,
    balanceCents,
  };
}

module.exports = { classifyTransactions };
