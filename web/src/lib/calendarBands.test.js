import test from 'node:test';
import assert from 'node:assert';

import { stayLengthBand } from './calendarBands.js';

test('bands 1-2 nights as short', () => {
  assert.equal(stayLengthBand(1), 'short');
  assert.equal(stayLengthBand(2), 'short');
});

test('bands 3-6 nights as medium', () => {
  assert.equal(stayLengthBand(3), 'medium');
  assert.equal(stayLengthBand(6), 'medium');
});

test('bands 7+ nights as long', () => {
  assert.equal(stayLengthBand(7), 'long');
  assert.equal(stayLengthBand(30), 'long');
});
