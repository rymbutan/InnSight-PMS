const test = require('node:test');
const assert = require('node:assert');

const { computeTax, DEFAULT_TAX_RATES, TAX_COMPONENTS } = require('./policies');

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
