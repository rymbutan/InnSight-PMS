// Pure functions implementing PMS business rules. Stateless, easy to test,
// and shared by the reservation, folio, and audit services. Each service
// keeps a copy in src/lib/policies.js (deployed via the same convention as
// observability.js / openapi.js).

// ── Cancellation policy ────────────────────────────────────────────
// Returns the fee amount in cents based on how far ahead the guest cancels.
// Defaults match a typical hostel policy:
//   • > 48h before check-in   → free
//   • 24-48h before           → 1 night
//   • < 24h or after check-in → full reservation total
function cancellationFeeCents({
  totalEstimateCents,
  checkIn,
  now = new Date(),
  nights = 1,
  policy = 'STANDARD',
}) {
  const ms = new Date(checkIn).getTime() - new Date(now).getTime();
  const hours = ms / 36e5;
  const oneNightCents = Math.round(Number(totalEstimateCents) / Math.max(1, nights));
  if (policy === 'FLEX') {
    // Free up to 24h before
    if (hours >= 24) return 0;
    return oneNightCents;
  }
  if (policy === 'STRICT') {
    // 50% up to 7 days, 100% within 7 days
    if (hours >= 24 * 7) return Math.round(Number(totalEstimateCents) * 0.5);
    return Number(totalEstimateCents);
  }
  // STANDARD (default)
  if (hours >= 48) return 0;
  if (hours >= 24) return oneNightCents;
  return Number(totalEstimateCents);
}

// ── Deposit policy ─────────────────────────────────────────────────
// Returns the suggested deposit cents based on a percentage rule.
// Default: 50% of grand total. OTAs that pre-pay fully → 100%.
function depositCents({ grandTotalCents, source = 'DIRECT' }) {
  const PREPAID_SOURCES = ['BOOKING_COM', 'EXPEDIA', 'AGODA', 'AIRBNB'];
  const pct = PREPAID_SOURCES.includes(source) ? 1.0 : 0.5;
  return Math.round(Number(grandTotalCents) * pct);
}

// ── Tax engine (Philippines defaults) ──────────────────────────────
// Returns { taxCents, breakdown: [{ key, label, rate, amountCents }] }, all
// amounts as BigInt cents.
//
// FOUR COMPONENTS, NOT ONE COMBINED FIGURE
// ----------------------------------------
// The guest folio this system prints itemises tax the way the reference invoice
// does: VAT, service charge, local tax and real property tax on their own lines.
// A single combined number cannot be decomposed back into those rows, so the
// components are computed separately and persisted per transaction.
//
// Note this function was previously dead code — nothing called it, which is why
// every folio in the system carried zero tax until the charge route was wired up
// to it.
//
// RATES ARE PASSED IN, NEVER READ FROM A DATABASE
// -----------------------------------------------
// Keeps this pure and unit-testable. The folio service reads them from its
// AppSetting table and hands them over.
//
// VAT 12% and service charge 10% are the Philippine standards. Local tax and RPT
// default to ZERO deliberately: they vary by locality, and inventing a plausible
// rate would put fabricated tax on a guest's bill. An operator sets them.
const TAX_COMPONENTS = [
  { key: 'vat', label: 'VAT' },
  { key: 'serviceCharge', label: 'Service Charge' },
  { key: 'localTax', label: 'Local Tax' },
  { key: 'realPropertyTax', label: 'Real Property Tax' },
];

const DEFAULT_TAX_RATES = { vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 };

// Categories that are never taxed. An unknown category IS taxed — the safer
// direction of failure for a billing system is to compute tax and have someone
// remove it, not to silently omit it.
const UNTAXED_CATEGORIES = new Set(['PAYMENT', 'REFUND', 'ADJUSTMENT', 'TAX']);

function computeTax({ subtotalCents, category = 'ROOM', rates } = {}) {
  if (UNTAXED_CATEGORIES.has(category)) return { taxCents: 0n, breakdown: [] };

  const effective = { ...DEFAULT_TAX_RATES, ...(rates || {}) };
  const base = BigInt(subtotalCents ?? 0);

  let taxCents = 0n;
  const breakdown = [];
  for (const { key, label } of TAX_COMPONENTS) {
    const rate = Number(effective[key]) || 0;
    // Percent × cents in integer space: multiply by the rate scaled to four
    // decimal places, then divide out. Doing this in floating point loses
    // centavos on large folios, and money must never round through a float.
    const scaled = BigInt(Math.round(rate * 10000));
    const amountCents = (base * scaled + 500000n) / 1000000n;
    taxCents += amountCents;
    breakdown.push({ key, label, rate, amountCents });
  }
  return { taxCents, breakdown };
}

// ── Late checkout / early arrival fees ─────────────────────────────
// Charged as fractions of the nightly rate based on hours offset from
// the standard check-in/out times.
function lateCheckoutFeeCents({ nightlyCents, hoursAfterStandard }) {
  if (hoursAfterStandard <= 1) return 0;
  if (hoursAfterStandard <= 3) return Math.round(Number(nightlyCents) * 0.25);
  if (hoursAfterStandard <= 6) return Math.round(Number(nightlyCents) * 0.5);
  return Number(nightlyCents); // beyond 6h → full night
}

function earlyArrivalFeeCents({ nightlyCents, hoursBeforeStandard }) {
  if (hoursBeforeStandard <= 1) return 0;
  if (hoursBeforeStandard <= 4) return Math.round(Number(nightlyCents) * 0.25);
  return Math.round(Number(nightlyCents) * 0.5);
}

// ── Commission tracking ────────────────────────────────────────────
// Estimated take per channel — for net-revenue reports.
const CHANNEL_COMMISSION = {
  DIRECT: 0,
  WALK_IN: 0,
  BOOKING_COM: 0.15,
  EXPEDIA: 0.2,
  AGODA: 0.18,
  AIRBNB: 0.03,
  OTA: 0.15,
};

function commissionCents({ totalEstimateCents, source = 'DIRECT' }) {
  const rate = CHANNEL_COMMISSION[source] ?? 0;
  return Math.round(Number(totalEstimateCents) * rate);
}

module.exports = {
  cancellationFeeCents,
  depositCents,
  computeTax,
  lateCheckoutFeeCents,
  earlyArrivalFeeCents,
  commissionCents,
  TAX_COMPONENTS,
  DEFAULT_TAX_RATES,
  CHANNEL_COMMISSION,
};
