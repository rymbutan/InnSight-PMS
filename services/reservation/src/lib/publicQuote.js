// Assembles the public booking engine's quote: the room subtotal plus tax
// computed at folio's configured rates, so a guest's quote matches what the
// folio will actually bill at checkout (see the 2026-09-05 folio spec's
// "Unresolved — for the product owner" note, now resolved as tax-inclusive).
//
// Folio being unreachable must never block a public booking — the same
// "best-effort, fall back and proceed" rule already applied to promo-code
// lookups in index.js — so a failed rate fetch falls back to the shared
// defaults rather than surfacing an error.
const { computeTax, DEFAULT_TAX_RATES } = require('./policies');

async function quotePublicTotal({ grossCents, getFolioTaxRates }) {
  let rates = DEFAULT_TAX_RATES;
  try {
    rates = await getFolioTaxRates();
  } catch (err) {
    // Never blocks the booking, but if folio is CONSISTENTLY unreachable every
    // public quote silently reverts to defaults — worth a log line so that
    // shows up somewhere other than a guest's confusion at checkout.
    console.error('[Reservation] could not fetch folio tax rates, using defaults:', err.message);
    rates = DEFAULT_TAX_RATES;
  }

  const { taxCents, breakdown } = computeTax({ subtotalCents: grossCents, category: 'ROOM', rates });
  return {
    totalEstimateCents: BigInt(grossCents) + taxCents,
    taxCents,
    taxBreakdown: breakdown,
  };
}

module.exports = { quotePublicTotal };
