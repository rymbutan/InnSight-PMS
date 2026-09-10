const test = require('node:test');
const assert = require('node:assert');

const {
  computeTax,
  DEFAULT_TAX_RATES,
  TAX_COMPONENTS,
  paymentProcessingFeeCents,
  cancellationFeeCents,
} = require('./policies');

// Terms & Conditions, section 4 — same tiers as
// services/reservation/src/lib/policies.test.js, since this is a kept-in-sync
// copy of that file.
const DAY = 24 * 3600 * 1000;

test('cancellationFeeCents: >= 72h, CASH → flat PHP 200', () => {
  assert.equal(
    cancellationFeeCents({
      totalEstimateCents: 1000000,
      checkIn: new Date(Date.now() + 96 * 3600 * 1000),
      method: 'CASH',
    }),
    20000
  );
});

test('cancellationFeeCents: >= 72h, gateway rail → 3%', () => {
  assert.equal(
    cancellationFeeCents({
      totalEstimateCents: 1000000,
      checkIn: new Date(Date.now() + 96 * 3600 * 1000),
      method: 'CARD',
    }),
    30000
  );
});

test('cancellationFeeCents: 24-72h → 50%', () => {
  assert.equal(
    cancellationFeeCents({
      totalEstimateCents: 1000000,
      checkIn: new Date(Date.now() + 48 * 3600 * 1000),
    }),
    500000
  );
});

test('cancellationFeeCents: < 24h or past check-in → 100%', () => {
  assert.equal(
    cancellationFeeCents({ totalEstimateCents: 1000000, checkIn: new Date(Date.now() - DAY) }),
    1000000
  );
});

test('cancellationFeeCents: non-refundable tier is always 100%', () => {
  assert.equal(
    cancellationFeeCents({
      totalEstimateCents: 1000000,
      checkIn: new Date(Date.now() + 30 * DAY),
      isNonRefundable: true,
    }),
    1000000
  );
});

// The reference invoice (FELISMINO-JANA-MARIE_GUEST-FOLIO.pdf): a room charge of
// 25,350.00 P produces 3,042.00 VAT and 2,535.00 service charge. If these two
// assertions ever fail, the printed folio no longer matches the document this
// layout was copied from.
const REFERENCE_ROOM_CENTS = 2535000n;

test('the default rates reproduce the reference invoice exactly', () => {
  const { taxCents, breakdown } = computeTax({
    subtotalCents: REFERENCE_ROOM_CENTS,
    category: 'ROOM',
    rates: DEFAULT_TAX_RATES,
  });
  const by = Object.fromEntries(breakdown.map((b) => [b.key, b.amountCents]));
  assert.equal(by.vat, 304200n, 'VAT at 12% of 25,350.00');
  assert.equal(by.serviceCharge, 253500n, 'service charge at 10% of 25,350.00');
  assert.equal(by.localTax, 0n, 'local tax is property-specific and defaults to 0');
  assert.equal(by.realPropertyTax, 0n, 'RPT is property-specific and defaults to 0');
  assert.equal(taxCents, 557700n);
});

// The invariant that keeps the breakdown from ever disagreeing with the total
// the balance is computed from.
test('the components always sum exactly to taxCents', () => {
  for (const subtotal of [0n, 1n, 7n, 333n, 99999n, 2535000n, 123456789n]) {
    const { taxCents, breakdown } = computeTax({
      subtotalCents: subtotal,
      category: 'ROOM',
      rates: { vat: 12, serviceCharge: 10, localTax: 1.85, realPropertyTax: 14.33 },
    });
    const summed = breakdown.reduce((a, b) => a + b.amountCents, 0n);
    assert.equal(summed, taxCents, `components must sum to the total for ${subtotal}`);
  }
});

test('every component is returned even at a zero rate, so the print has all four rows', () => {
  const { breakdown } = computeTax({
    subtotalCents: 100000n,
    category: 'ROOM',
    rates: DEFAULT_TAX_RATES,
  });
  assert.equal(breakdown.length, 4);
  assert.deepEqual(
    breakdown.map((b) => b.key),
    TAX_COMPONENTS.map((c) => c.key),
    'order must match the reference invoice'
  );
});

test('amounts are BigInt cents, never floats', () => {
  const { taxCents, breakdown } = computeTax({
    subtotalCents: 33333n,
    category: 'ROOM',
    rates: DEFAULT_TAX_RATES,
  });
  assert.equal(typeof taxCents, 'bigint');
  for (const b of breakdown) assert.equal(typeof b.amountCents, 'bigint');
});

test('non-taxable categories produce no tax and no rows', () => {
  for (const category of ['PAYMENT', 'REFUND', 'ADJUSTMENT', 'TAX']) {
    const { taxCents, breakdown } = computeTax({
      subtotalCents: 100000n,
      category,
      rates: DEFAULT_TAX_RATES,
    });
    assert.equal(taxCents, 0n, `${category} must not be taxed`);
    assert.deepEqual(breakdown, [], `${category} must produce no rows`);
  }
});

test('omitted rates fall back to the defaults', () => {
  const withDefaults = computeTax({ subtotalCents: 100000n, category: 'ROOM' });
  const explicit = computeTax({ subtotalCents: 100000n, category: 'ROOM', rates: DEFAULT_TAX_RATES });
  assert.equal(withDefaults.taxCents, explicit.taxCents);
});

test('a partial rates object fills the gaps from the defaults', () => {
  const { breakdown } = computeTax({
    subtotalCents: 100000n,
    category: 'ROOM',
    rates: { localTax: 2 },
  });
  const by = Object.fromEntries(breakdown.map((b) => [b.key, b.amountCents]));
  assert.equal(by.vat, 12000n, 'VAT still uses its default');
  assert.equal(by.localTax, 2000n, 'the supplied rate is used');
});

test('a number-typed subtotal is accepted and returns BigInt', () => {
  // Callers holding a plain Number must not silently produce a float result.
  const { taxCents } = computeTax({ subtotalCents: 100000, category: 'ROOM' });
  assert.equal(taxCents, 22000n);
});

// Negative subtotals show up as discounts and charge reversals. Rounding must
// go half away from zero for these too, not silently truncate toward zero.
test('negative subtotals round half away from zero, not toward it', () => {
  const exactVat = computeTax({ subtotalCents: -100n, category: 'ROOM', rates: { vat: 12 } });
  const byExactVat = Object.fromEntries(exactVat.breakdown.map((b) => [b.key, b.amountCents]));
  assert.equal(byExactVat.vat, -12n, '-100 at 12% is an exact multiple: -12, not -11');

  const exactHalf = computeTax({ subtotalCents: -2n, category: 'ROOM', rates: { vat: 50 } });
  const byExactHalf = Object.fromEntries(exactHalf.breakdown.map((b) => [b.key, b.amountCents]));
  assert.equal(byExactHalf.vat, -1n, '-2 at 50% is an exact multiple: -1, not 0');

  const halfCentBoundary = computeTax({ subtotalCents: -1n, category: 'ROOM', rates: { vat: 50 } });
  const byBoundary = Object.fromEntries(halfCentBoundary.breakdown.map((b) => [b.key, b.amountCents]));
  assert.equal(byBoundary.vat, -1n, '-1 at 50% is a genuine half-cent boundary: rounds away from zero to -1');
});

test('the components still sum exactly to taxCents for negative subtotals', () => {
  for (const subtotal of [-1n, -2n, -100n, -333n, -99999n, -2535000n, -123456789n]) {
    const { taxCents, breakdown } = computeTax({
      subtotalCents: subtotal,
      category: 'ROOM',
      rates: { vat: 12, serviceCharge: 10, localTax: 1.85, realPropertyTax: 14.33 },
    });
    const summed = breakdown.reduce((a, b) => a + b.amountCents, 0n);
    assert.equal(summed, taxCents, `components must sum to the total for ${subtotal}`);
  }
});

test('positive results are unchanged by the sign-aware rounding', () => {
  const { breakdown } = computeTax({
    subtotalCents: REFERENCE_ROOM_CENTS,
    category: 'ROOM',
    rates: { vat: 12 },
  });
  const by = Object.fromEntries(breakdown.map((b) => [b.key, b.amountCents]));
  assert.equal(by.vat, 304200n, 'VAT at 12% of 25,350.00 is still exactly 304200');
});

test('paymentProcessingFeeCents computes a round-half-up percentage of the payment', () => {
  assert.equal(paymentProcessingFeeCents({ amountCents: 500000n, feePercent: 2 }), 10000n);
  assert.equal(paymentProcessingFeeCents({ amountCents: 150000n, feePercent: 2.5 }), 3750n);
});

test('paymentProcessingFeeCents is zero with no percent, a zero percent, or a missing one', () => {
  assert.equal(paymentProcessingFeeCents({ amountCents: 500000n, feePercent: 0 }), 0n);
  assert.equal(paymentProcessingFeeCents({ amountCents: 500000n }), 0n);
  assert.equal(paymentProcessingFeeCents({ amountCents: 500000n, feePercent: -5 }), 0n);
});

test('paymentProcessingFeeCents handles a negative base (a refund of the fee itself) with the same sign', () => {
  assert.equal(paymentProcessingFeeCents({ amountCents: -500000n, feePercent: 2 }), -10000n);
});

test('paymentProcessingFeeCents accepts a string amountCents, like every JSON-round-tripped BigInt in this codebase', () => {
  assert.equal(paymentProcessingFeeCents({ amountCents: '500000', feePercent: 2 }), 10000n);
});
