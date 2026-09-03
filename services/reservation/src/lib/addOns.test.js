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
