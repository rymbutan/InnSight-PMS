const test = require('node:test');
const assert = require('node:assert');

const { centsToWords } = require('./receiptWords');

test('spells out a reference amount exactly (₱35,029.50)', () => {
  assert.equal(centsToWords(3502950), 'THIRTY-FIVE THOUSAND TWENTY-NINE AND FIFTY');
});

test('zero amount', () => {
  assert.equal(centsToWords(0), 'ZERO ONLY');
});

test('whole pesos, no centavos', () => {
  assert.equal(centsToWords(10000), 'ONE HUNDRED ONLY');
});

test('centavos only, under one peso', () => {
  assert.equal(centsToWords(150), 'ONE AND FIFTY');
});

test('accepts a BigInt (as Prisma returns for amountCents columns)', () => {
  assert.equal(centsToWords(3502950n), 'THIRTY-FIVE THOUSAND TWENTY-NINE AND FIFTY');
});
