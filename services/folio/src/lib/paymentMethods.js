// Canonical payment methods and the category each belongs to.
//
// WHY THIS EXISTS
// ---------------
// `Payment.method` and `FolioTransaction.paymentMethod` are plain strings —
// nothing ever validated them. Three different screens each grew their own
// hardcoded option list (Folios.jsx, two separate modals in
// ReservationDetail.jsx), and they had drifted: one used `GCASH`, another
// used unvalued `<option>GCash</option>` (a different string), and only one
// of the three offered Maya at all. This is the one list every screen and
// every route now reads instead, so GCash and Maya cannot silently mean two
// different strings in two different places again.
//
// PURE — no Prisma, no I/O, so it is unit-testable without a database and
// importable from a route file without pulling in Prisma at module load.
const PAYMENT_METHODS = {
  CASH: { label: 'Cash', category: 'CASH' },
  CARD: { label: 'Card', category: 'CARD' },
  // The generic choice offered wherever staff manually enter a payment —
  // Post Payment, Take Payment, New Reservation, Quick Edit (web/src/lib/
  // paymentMethods.js's PAYMENT_METHODS). A cashier taking a payment picks
  // "E-Wallet", not the guest's specific wallet app.
  E_WALLET: { label: 'E-Wallet', category: 'E_WALLET' },
  GCASH: { label: 'GCash', category: 'E_WALLET' },
  MAYA: { label: 'Maya', category: 'E_WALLET' },
  BANK_TRANSFER: { label: 'Bank Transfer', category: 'BANK_TRANSFER' },
  // The generic simulated-QR method (services/folio/src/lib/paymentIntent.js's
  // default) — an unbranded stand-in for "some e-wallet", used when a QR
  // intent is generated without picking GCash or Maya specifically.
  //
  // GCASH, MAYA and QR_WALLET all stay real, distinct method codes even
  // though none of them are manual-entry choices any more: they still name
  // what a payment posted through the Pay-by-Link/QR flow (ReservationDetail.jsx)
  // actually was, and existing Payment rows already carry those exact strings.
  QR_WALLET: { label: 'QR wallet (unbranded)', category: 'E_WALLET' },
};

const PAYMENT_METHOD_CODES = Object.keys(PAYMENT_METHODS);
const E_WALLET_METHODS = PAYMENT_METHOD_CODES.filter((m) => PAYMENT_METHODS[m].category === 'E_WALLET');

function categoryOf(method) {
  return PAYMENT_METHODS[String(method || '').toUpperCase()]?.category || null;
}

// Whether a payment method is billed through an e-wallet gateway (GCash,
// Maya, or the generic QR wallet) — the category a chargeback/refund-dispute
// case can be filed against. Cash and card use the existing direct /refund
// route; neither has a "gateway" to dispute with.
function isEWallet(method) {
  return categoryOf(method) === 'E_WALLET';
}

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_METHOD_CODES,
  E_WALLET_METHODS,
  categoryOf,
  isEWallet,
};
