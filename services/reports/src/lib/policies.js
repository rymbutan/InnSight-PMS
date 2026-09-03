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
// Returns { taxCents, breakdown: [{ name, rate, amountCents }] }.
// 12% VAT applies to most charges. 10% service charge is *not* a tax in PH
// (it's a service fee tracked separately). Local government tax varies.
const TAX_RULES = {
  ROOM: [{ name: 'VAT (12%)', rate: 0.12 }],
  FNB: [{ name: 'VAT (12%)', rate: 0.12 }],
  SERVICE: [{ name: 'VAT (12%)', rate: 0.12 }],
  TAX: [],
  OTHER: [{ name: 'VAT (12%)', rate: 0.12 }],
  // Non-taxable categories
  PAYMENT: [],
  REFUND: [],
  ADJUSTMENT: [],
};

function computeTax({ subtotalCents, category = 'ROOM' }) {
  const rules = TAX_RULES[category] || TAX_RULES.OTHER;
  let total = 0;
  const breakdown = [];
  for (const rule of rules) {
    const amt = Math.round(Number(subtotalCents) * rule.rate);
    total += amt;
    breakdown.push({ name: rule.name, rate: rule.rate, amountCents: amt });
  }
  return { taxCents: total, breakdown };
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
  TAX_RULES,
  CHANNEL_COMMISSION,
};
