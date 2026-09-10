// Pure functions implementing PMS business rules. Stateless, easy to test,
// and shared by the reservation, folio, and audit services. Each service
// keeps a copy in src/lib/policies.js (deployed via the same convention as
// observability.js / openapi.js).

// ── Cancellation policy ────────────────────────────────────────────
// Returns the fee amount in cents based on how far ahead the guest cancels.
// Tiers match the hotel's own Terms & Conditions, section 4 (also printed on
// the registration card — see services/stay/src/lib/regCardRender.js's
// TERMS_SECTIONS):
//   • Non-refundable / promo rate → 100%, always, regardless of timing
//   • >= 72h before check-in      → a small processing deduction only: 3% of
//                                    the total on a gateway/e-wallet rail, or
//                                    a flat PHP 200 if the deposit was CASH
//   • 24-72h before check-in      → 50%
//   • < 24h before check-in, or   → 100% (this is also the tier an overdue,
//     at/after check-in             never-confirmed booking always lands in,
//                                    since its hours-until-checkIn is <= 0)
function cancellationFeeCents({
  totalEstimateCents,
  checkIn,
  now = new Date(),
  method = null,
  isNonRefundable = false,
} = {}) {
  const total = Number(totalEstimateCents);
  if (isNonRefundable) return total;
  const hours = (new Date(checkIn).getTime() - new Date(now).getTime()) / 36e5;
  if (hours >= 72) {
    const FLAT_ADMIN_FEE_CENTS = 20000; // PHP 200
    return method === 'CASH' ? FLAT_ADMIN_FEE_CENTS : Math.round(total * 0.03);
  }
  if (hours >= 24) return Math.round(total * 0.5);
  return total;
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

// ── Country jurisdiction ────────────────────────────────────────────────────
// Tax is owed to whatever country the PROPERTY operates in, not the guest's
// own nationality — a guest from abroad staying at a PH property still pays PH
// VAT. DEFAULT_COUNTRY is that property's jurisdiction until Settings says
// otherwise (see lib/settings.js's `hotel_country`).
//
// Only PH ships a real default rate set, for the same reason localTax and
// realPropertyTax already default to zero above: inventing a plausible rate
// for a jurisdiction nobody has configured would put fabricated tax on a
// guest's bill. A country with no rates configured gets 0% on every
// component — an honest, obviously-incomplete number — rather than silently
// borrowing PH's.
const DEFAULT_COUNTRY = 'PH';
const DEFAULT_TAX_RATES_BY_COUNTRY = {
  [DEFAULT_COUNTRY]: { vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 },
};
const ZERO_TAX_RATES = { vat: 0, serviceCharge: 0, localTax: 0, realPropertyTax: 0 };

function defaultRatesForCountry(country) {
  return { ...(DEFAULT_TAX_RATES_BY_COUNTRY[country] || ZERO_TAX_RATES) };
}

// Unchanged name and value for every existing caller: this is simply
// DEFAULT_TAX_RATES_BY_COUNTRY's entry for DEFAULT_COUNTRY.
const DEFAULT_TAX_RATES = DEFAULT_TAX_RATES_BY_COUNTRY[DEFAULT_COUNTRY];

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
    //
    // The +500000n/1000000n step is round-half-up, which only works for a
    // non-negative dividend: BigInt division truncates toward zero, and
    // truncation toward zero equals floor only when the value is >= 0. For a
    // negative subtotal (discounts, charge reversals), truncation toward zero
    // acts as a ceiling instead, so adding the same positive offset pushes the
    // result toward zero and silently drops up to a full cent -- even on an
    // exact multiple that needs no rounding at all. Rounding the magnitude and
    // re-applying the sign keeps this "round half away from zero" for every
    // sign of subtotal, which is the trap the next reader should not re-add.
    const scaled = BigInt(Math.round(rate * 10000));
    const negative = base < 0n;
    const magnitude = negative ? -base : base;
    const rounded = (magnitude * scaled + 500000n) / 1000000n;
    const amountCents = negative ? -rounded : rounded;
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

// ── Payment processing fee (CARD / BANK_TRANSFER surcharge) ───────────────
// Same round-half-up, scaled-integer arithmetic as computeTax's own
// per-component loop, kept separate: this fee is a percentage of the PAYMENT
// (deposit) amount, not of a charge subtotal. Ported verbatim from
// services/folio/src/lib/policies.js, which owns the property's configured
// feePercent (Settings → payment_processing_fee_percent).
function paymentProcessingFeeCents({ amountCents, feePercent }) {
  const rate = Number(feePercent) || 0;
  if (rate <= 0) return 0n;
  const base = BigInt(amountCents ?? 0);
  const scaled = BigInt(Math.round(rate * 10000));
  const negative = base < 0n;
  const magnitude = negative ? -base : base;
  const rounded = (magnitude * scaled + 500000n) / 1000000n;
  return negative ? -rounded : rounded;
}

module.exports = {
  cancellationFeeCents,
  depositCents,
  computeTax,
  lateCheckoutFeeCents,
  earlyArrivalFeeCents,
  commissionCents,
  paymentProcessingFeeCents,
  TAX_COMPONENTS,
  DEFAULT_TAX_RATES,
  DEFAULT_COUNTRY,
  DEFAULT_TAX_RATES_BY_COUNTRY,
  ZERO_TAX_RATES,
  defaultRatesForCountry,
  CHANNEL_COMMISSION,
};
