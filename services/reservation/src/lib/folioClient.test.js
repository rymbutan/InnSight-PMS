const test = require('node:test');
const assert = require('node:assert');

// Stub the shared service-caller so this test never opens a real socket —
// the same pattern services/stay/src/routes/arrivals.test.js uses for its
// cross-service reservation lookups.
let lastUrl = null;
let response = null;
let failure = null;

require.cache[require.resolve('./serviceCall')] = {
  exports: {
    ServiceCallError: class extends Error {},
    makeServiceCaller: () => ({
      call: async (url) => {
        lastUrl = url;
        if (failure) throw failure;
        return response;
      },
    }),
  },
};

const { makeFolioClient } = require('./folioClient');

test('getTaxRates calls the folio tax-rates endpoint and returns the parsed rates', async () => {
  response = { vat: 12, serviceCharge: 10, localTax: 5, realPropertyTax: 0 };
  failure = null;
  const folio = makeFolioClient({ name: 'reservation', baseUrl: 'http://folio-service:3007' });

  const rates = await folio.getTaxRates();

  assert.deepStrictEqual(rates, response);
  assert.match(lastUrl, /^http:\/\/folio-service:3007\/api\/settings\/tax-rates$/);
});

test('getTaxRates propagates the failure when folio is unreachable', async () => {
  failure = new Error('ECONNREFUSED');
  const folio = makeFolioClient({ name: 'reservation', baseUrl: 'http://folio-service:3007' });

  await assert.rejects(() => folio.getTaxRates(), /ECONNREFUSED/);
});
