import test from 'node:test';
import assert from 'node:assert';

import { afterPromoCents } from './money.js';

test('takes the percentage off and rounds to whole cents', () => {
  assert.strictEqual(afterPromoCents(100000, 20), 80000);
  assert.strictEqual(afterPromoCents(33333, 10), 30000);
});

test('is a no-op for no or zero discount', () => {
  assert.strictEqual(afterPromoCents(5000, 0), 5000);
  assert.strictEqual(afterPromoCents(5000, undefined), 5000);
});
