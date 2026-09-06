const test = require('node:test');
const assert = require('node:assert');
const { quotePublicTotal } = require('./publicQuote');

test('adds computed tax at the fetched rates to the room subtotal', async () => {
  const quote = await quotePublicTotal({
    grossCents: 2535000, // ₱25,350.00
    getFolioTaxRates: async () => ({ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 }),
  });

  // ₱25,350 × 12% = ₱3,042; × 10% = ₱2,535 — the reference invoice figures.
  assert.strictEqual(quote.taxCents, 557700n);
  assert.strictEqual(quote.totalEstimateCents, 2535000n + 557700n);
});

test('falls back to the default rates when folio is unreachable, without failing the booking', async () => {
  const quote = await quotePublicTotal({
    grossCents: 2535000,
    getFolioTaxRates: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  // Same defaults DEFAULT_TAX_RATES uses (12% + 10%), so the fallback matches
  // the reference figures too.
  assert.strictEqual(quote.taxCents, 557700n);
  assert.strictEqual(quote.totalEstimateCents, 2535000n + 557700n);
});

test('an untaxed gross of zero produces a zero total, not a thrown error', async () => {
  const quote = await quotePublicTotal({
    grossCents: 0,
    getFolioTaxRates: async () => ({ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 }),
  });

  assert.strictEqual(quote.totalEstimateCents, 0n);
});
