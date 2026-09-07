import test from 'node:test';
import assert from 'node:assert';

import { defaultPayerCount } from './splitDefaults.js';

test('defaults to the reservation adult count', () => {
  assert.equal(defaultPayerCount(3), 3);
});

test('a solo guest still gets at least two payers, since a split needs two', () => {
  assert.equal(defaultPayerCount(1), 2);
});

test('a walk-in folio with no reservation data falls back to two', () => {
  assert.equal(defaultPayerCount(null), 2);
  assert.equal(defaultPayerCount(undefined), 2);
});

test('an implausibly large party is capped at the eight-payer limit', () => {
  assert.equal(defaultPayerCount(20), 8);
});

test('a fractional adult count (defensive against bad upstream data) is floored', () => {
  assert.equal(defaultPayerCount(3.7), 3);
});
