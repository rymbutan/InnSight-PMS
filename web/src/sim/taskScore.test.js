// Tests for the shared outcome vocabulary and duration formatting.
//
// This file used to cover the mini-game scoring spine — slip budgets, par
// times, drop-zone hit tests, vacuum coverage. Those activities were removed
// with the mini-games, and their tests went with them: a suite that keeps
// asserting against deleted code inflates the pass count without covering
// anything that ships. The grading that replaced them is covered by
// sim/inspection/inspectionScore.test.js.
//
//   cd web && node --test src/sim/taskScore.test.js

import test from 'node:test';
import assert from 'node:assert';

import { GOOD, ISSUES, SKIPPED, fmtDuration } from './taskScore.js';

test('the outcome values are the strings Assessment renders against', () => {
  // Case matters: Assessment.jsx and inspectionScore.js compare against these
  // exact lowercase values, and a past bug came from a table keyed 'GOOD'.
  assert.strictEqual(GOOD, 'good');
  assert.strictEqual(ISSUES, 'issues');
  assert.strictEqual(SKIPPED, 'skipped');
});

test('formats sub-minute durations in seconds', () => {
  assert.strictEqual(fmtDuration(0), '0s');
  assert.strictEqual(fmtDuration(45), '45s');
  assert.strictEqual(fmtDuration(59), '59s');
});

test('formats a minute or more as m + zero-padded s', () => {
  assert.strictEqual(fmtDuration(60), '1m 00s');
  assert.strictEqual(fmtDuration(125), '2m 05s');
  assert.strictEqual(fmtDuration(3599), '59m 59s');
});

test('rounds fractional seconds and never returns a negative duration', () => {
  assert.strictEqual(fmtDuration(45.4), '45s');
  assert.strictEqual(fmtDuration(45.6), '46s');
  assert.strictEqual(fmtDuration(-10), '0s');
});
