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
const crypto = require('node:crypto');

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

// A believable-looking gateway/bank reference for a MANUALLY posted payment
// that didn't come with its own — the QR flow already mints one of these
// (lib/paymentIntent.js's SIM-<hex>) the moment an intent is confirmed, but
// Post Payment / Take Payment left Payment.gatewayRef blank unless staff
// happened to type one in. Same shape, extended to the methods that actually
// have something real-world to imitate:
//   CARD          -> an authorization code a terminal would print
//   BANK_TRANSFER -> a bank's own transaction/reference number
//   everything else (CASH, a manual E_WALLET entry, an unknown method)
//     -> null: there is no gateway or bank behind a cash payment, and a
//        manual e-wallet entry is staff typing in what the guest's own app
//        already showed them, not something this system can invent.
//
// A route call site decides whether to USE this — it never overrides a
// gatewayRef staff actually entered, so this only ever fills a gap.
function simulateGatewayRef(method) {
  const hex = () => crypto.randomBytes(6).toString('hex').toUpperCase();
  switch (String(method || '').toUpperCase()) {
    case 'CARD':
      return `AUTH-${hex()}`;
    case 'BANK_TRANSFER':
      return `BANKREF-${hex()}`;
    default:
      return null;
  }
}

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_METHOD_CODES,
  E_WALLET_METHODS,
  categoryOf,
  isEWallet,
  simulateGatewayRef,
};
