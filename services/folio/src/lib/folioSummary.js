// Pure classification of a folio's transactions into the sections a printed
// guest receipt shows. No Prisma, no HTTP, no pdfkit, so the arithmetic that
// decides what a guest is billed can be unit-tested without a database.
//
// `codes` is either { roomCodes, facilityCodes } — Sets of ChargeCode.code values
// whose category is 'ROOM' and 'FACILITY' — or, for the older call sites, a bare
// Set meaning roomCodes alone. Revenue is classified by the charge code's category
// and never by a hardcoded string: the seeded room code is 'RM', not 'ROOM' (the
// daily-totals route in folio.routes.js follows the same convention).
//
// Facility income is split out because a non-guest paying for the pool is walk-in
// facility revenue, and the night audit has to report it apart from a resident
// guest's minibar. It still counts towards the folio total — reclassifying money
// must never lose it.
function classifyTransactions(transactions, codes) {
  const roomCodes = codes instanceof Set ? codes : codes?.roomCodes || new Set();
  const facilityCodes = codes instanceof Set ? new Set() : codes?.facilityCodes || new Set();

  let roomChargeCents = 0n;
  let facilityChargeCents = 0n;
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
      else if (facilityCodes.has(tx.chargeCode)) facilityChargeCents += amount;
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

  const totalChargesCents = roomChargeCents + facilityChargeCents + extraChargeCents + taxCents;
  // Mirrors the balance formula in the daily-totals endpoint and the original
  // print route: a refund reduces net payments taken; a positive adjustment
  // increases what's owed, a negative one (a credit) reduces it.
  const netPaymentsCents = paymentsCents - refundsCents;
  const balanceCents = totalChargesCents - netPaymentsCents + adjustmentsCents;

  return {
    roomChargeCents,
    facilityChargeCents,
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
