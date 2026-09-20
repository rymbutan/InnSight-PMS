const test = require('node:test');
const assert = require('node:assert');

const { computeAddOns } = require('./addOns');

test('applies the fee percentage to the staff-entered cost', () => {
  const result = computeAddOns([{ description: 'Specific brand of cake', costCents: 85000 }], 10);
  assert.deepEqual(result, [
    { description: 'Specific brand of cake', costCents: 85000, feePercent: 10, totalCents: 93500 },
  ]);
});

test('rounds a fractional total to the nearest cent', () => {
  const result = computeAddOns([{ description: 'X', costCents: 999 }], 7.5);
  // 999 * 1.075 = 1073.925 → rounds to 1074
  assert.equal(result[0].totalCents, 1074);
});

test('filters out entries with a blank description', () => {
  const result = computeAddOns([{ description: '   ', costCents: 1000 }], 10);
  assert.deepEqual(result, []);
});

test('clamps a negative or missing cost to zero', () => {
  const result = computeAddOns([{ description: 'Y', costCents: -500 }, { description: 'Z' }], 10);
  assert.equal(result[0].costCents, 0);
  assert.equal(result[1].costCents, 0);
});

test('non-array input returns an empty list', () => {
  assert.deepEqual(computeAddOns(null, 10), []);
  assert.deepEqual(computeAddOns(undefined, 10), []);
});

test('a catalog-backed line is priced from the catalog, never the client-sent cost', () => {
  const catalog = { EXTRA_BED: { code: 'EXTRA_BED', label: 'Extra bed', priceCents: 50000 } };
  // A tampered/stale client sends 1 peso for something that actually costs 500.
  const result = computeAddOns([{ code: 'EXTRA_BED', description: 'whatever', costCents: 100 }], 10, catalog);
  assert.deepEqual(result, [
    { code: 'EXTRA_BED', description: 'Extra bed', costCents: 50000, feePercent: 10, totalCents: 55000 },
  ]);
});

test('a code that is not in the catalog falls back to the staff-entered line, same as no code at all', () => {
  const result = computeAddOns([{ code: 'UNKNOWN', description: 'Custom thing', costCents: 1000 }], 10, {});
  assert.deepEqual(result, [
    { description: 'Custom thing', costCents: 1000, feePercent: 10, totalCents: 1100 },
  ]);
});
