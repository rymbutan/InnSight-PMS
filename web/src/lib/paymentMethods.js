// Mirrors services/folio/src/lib/paymentMethods.js. Kept as a static copy
// rather than fetched, because it is small, rarely changes, and several forms
// need it synchronously at render time — the same tradeoff this codebase
// already makes for splitDefaults.js. If you touch one file, touch the other.
//
// This is the single list every MANUAL payment-entry dropdown reads (Post
// Payment, Take Payment, New Reservation, Quick Edit). GCash and Maya are
// deliberately NOT listed here as individual choices — staff taking a payment
// pick the generic "E-Wallet", not the guest's specific wallet app. Before
// this module existed, three separate hardcoded copies of this list had
// drifted: one used the string `GCASH`, another used the unvalued option text
// `GCash` (a different string), and only one of the three offered Maya at all.
//
// The ONE place brand names still appear is ReservationDetail.jsx's own
// Pay-by-Link/QR generator — that page simulates what the GUEST sees on their
// own wallet app, not what staff enter, so it keeps its own short GCash/Maya
// list rather than reading this one.
export const PAYMENT_METHODS = [
  { code: 'CASH', label: 'Cash', category: 'CASH' },
  { code: 'CARD', label: 'Card', category: 'CARD' },
  { code: 'E_WALLET', label: 'E-Wallet', category: 'E_WALLET' },
  { code: 'BANK_TRANSFER', label: 'Bank Transfer', category: 'BANK_TRANSFER' },
];

// Classification is broader than the dropdown above: a real Payment row can
// also carry GCASH, MAYA or QR_WALLET, posted via the simulated QR/Pay-by-Link
// flow (which names the guest's actual wallet, or the generic unbranded QR
// method). All of those must still be recognised as e-wallets for
// dispute-filing eligibility (see Folios.jsx's Dispute button) even though
// they are no longer offered as manual-entry choices.
const E_WALLET_METHOD_CODES = ['E_WALLET', 'GCASH', 'MAYA', 'QR_WALLET'];

export function isEWallet(method) {
  return E_WALLET_METHOD_CODES.includes(String(method || '').toUpperCase());
}

export const CATEGORY_LABELS = {
  CASH: 'Cash',
  CARD: 'Card',
  E_WALLET: 'E-Wallet',
  BANK_TRANSFER: 'Bank Transfer',
};

// For rendering a <select>: methods that share a category with at least one
// sibling are grouped under an <optgroup>, and a category with only one
// method stays a plain top-level option, since its own label already says
// what it is and a group of one adds a header with nothing to distinguish.
// With GCash/Maya collapsed into the single generic "E-Wallet" entry above,
// every category here is currently a singleton, so this renders as a flat
// list today — but stays correct unfiltered if a second method is ever added
// to any category.
export function paymentMethodGroups(methods = PAYMENT_METHODS) {
  const byCategory = {};
  for (const m of methods) (byCategory[m.category] ||= []).push(m);
  const seen = new Set();
  const out = [];
  for (const m of methods) {
    if (seen.has(m.category)) continue;
    seen.add(m.category);
    const siblings = byCategory[m.category];
    out.push(
      siblings.length > 1
        ? { kind: 'group', label: CATEGORY_LABELS[m.category] || m.category, methods: siblings }
        : { kind: 'option', ...m }
    );
  }
  return out;
}
