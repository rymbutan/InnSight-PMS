import test from 'node:test';
import assert from 'node:assert';

import { overdueMs, overdueLabel, overdueStays } from './overstay.js';

const NOW = new Date('2026-10-18T10:00:00Z').getTime();
const stay = (extra) => ({ id: 's', status: 'IN_HOUSE', expectedCheckOut: '2026-10-18T04:00:00Z', ...extra });

test('a stay past its expected check-out is overdue by the difference', () => {
  assert.strictEqual(overdueMs(stay(), NOW), 6 * 3600000);
});

test('a stay still within its check-out time is not overdue', () => {
  assert.strictEqual(overdueMs(stay({ expectedCheckOut: '2026-10-18T12:00:00Z' }), NOW), null);
});

test('only IN_HOUSE stays with an expected check-out can be overdue', () => {
  assert.strictEqual(overdueMs(stay({ status: 'DEPARTED' }), NOW), null);
  assert.strictEqual(overdueMs(stay({ status: 'PRE_ARRIVAL' }), NOW), null);
  assert.strictEqual(overdueMs(stay({ expectedCheckOut: null }), NOW), null);
  assert.strictEqual(overdueMs(stay({ expectedCheckOut: 'not a date' }), NOW), null);
  assert.strictEqual(overdueMs(null, NOW), null);
});

test('labels read in minutes, hours, then days', () => {
  assert.strictEqual(overdueLabel(10 * 1000), '1 min overdue');
  assert.strictEqual(overdueLabel(45 * 60000), '45 min overdue');
  assert.strictEqual(overdueLabel(3 * 3600000 + 59 * 60000), '3h overdue');
  assert.strictEqual(overdueLabel(24 * 3600000), '1 day overdue');
  assert.strictEqual(overdueLabel(5 * 24 * 3600000 + 3600000), '5 days overdue');
});

test('overdueStays lists the longest overdue first and flags a full day as an overstay', () => {
  const list = overdueStays(
    [
      stay({ id: 'late', expectedCheckOut: '2026-10-18T09:00:00Z' }),
      stay({ id: 'ok', expectedCheckOut: '2026-10-19T04:00:00Z' }),
      stay({ id: 'old', expectedCheckOut: '2026-10-13T04:00:00Z' }),
    ],
    NOW
  );
  assert.deepStrictEqual(
    list.map((x) => [x.stay.id, x.overstay]),
    [
      ['old', true],
      ['late', false],
    ]
  );
  assert.strictEqual(list[0].label, '5 days overdue');
});

test('overdueStays tolerates no list', () => {
  assert.deepStrictEqual(overdueStays(undefined, NOW), []);
});
