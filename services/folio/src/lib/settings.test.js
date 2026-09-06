const test = require('node:test');
const assert = require('node:assert');

const { parseTaxRates, validateTaxRates, parseHotel, TAX_RATE_KEYS } = require('./settings');

test('missing rows fall back to the shipped defaults', () => {
  const rates = parseTaxRates([]);
  assert.deepEqual(rates, { vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 });
});

test('stored rows override the defaults', () => {
  const rates = parseTaxRates([
    { key: 'tax_vat_percent', value: '10' },
    { key: 'tax_local_percent', value: '1.85' },
  ]);
  assert.equal(rates.vat, 10);
  assert.equal(rates.localTax, 1.85);
  assert.equal(rates.serviceCharge, 10, 'an unset key keeps its default');
});

test('a corrupt stored value falls back rather than yielding NaN', () => {
  // A NaN rate would silently produce NaN tax on a guest's bill.
  const rates = parseTaxRates([{ key: 'tax_vat_percent', value: 'twelve' }]);
  assert.equal(rates.vat, 12);
});

test('every component has a settings key', () => {
  assert.deepEqual(Object.keys(TAX_RATE_KEYS).sort(), [
    'localTax', 'realPropertyTax', 'serviceCharge', 'vat',
  ]);
});

test('validation accepts a full, in-range payload', () => {
  const r = validateTaxRates({ vat: 12, serviceCharge: 10, localTax: 1.85, realPropertyTax: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.rates.localTax, 1.85);
});

test('validation accepts a partial payload and keeps the rest at their defaults', () => {
  const r = validateTaxRates({ vat: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.rates.vat, 8);
  assert.equal(r.rates.serviceCharge, 10);
});

test('validation rejects out-of-range and non-numeric rates', () => {
  for (const bad of [{ vat: -1 }, { vat: 101 }, { vat: 'abc' }, { serviceCharge: NaN }, { localTax: Infinity }]) {
    assert.equal(validateTaxRates(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('validation rejects an unknown key rather than silently dropping it', () => {
  const r = validateTaxRates({ vat: 12, wineTax: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /wineTax/);
});

test('hotel identity defaults to InnSight, never to the reference property', () => {
  const hotel = parseHotel([]);
  assert.equal(hotel.name, 'InnSight PMS');
  // The reference invoice belongs to a real business. Shipping its details as
  // defaults would make every printed folio impersonate it.
  const joined = JSON.stringify(hotel).toLowerCase();
  assert.ok(!joined.includes('aureliscita'), 'must not ship a real property as a default');
});

test('stored hotel rows override the defaults', () => {
  const hotel = parseHotel([
    { key: 'hotel_name', value: 'Test Grand Hotel' },
    { key: 'hotel_email', value: 'desk@example.test' },
  ]);
  assert.equal(hotel.name, 'Test Grand Hotel');
  assert.equal(hotel.email, 'desk@example.test');
  assert.equal(typeof hotel.address, 'string', 'unset fields are still present as strings');
});
