const test = require('node:test');
const assert = require('node:assert');

const { arrivalsWindow, ARRIVAL_RANGES } = require('./arrivalsWindow');

// A fixed "now" so these tests do not drift. Deliberately late in the LOCAL day
// for a UTC+8 property: 2026-09-05T23:30+08:00 is 2026-09-05T15:30Z. Reservation
// checkIn values are UTC midnight (Convention 2 in lib/date.js), so the window
// must be built from the UTC calendar day, and must NOT roll over just because
// the local clock is near midnight.
const NOW = new Date('2026-09-05T15:30:00.000Z');

test('today is a single UTC day, upper bound exclusive', () => {
  const w = arrivalsWindow('today', NOW);
  assert.equal(w.checkInFrom, '2026-09-05');
  assert.equal(w.checkInTo, '2026-09-06');
});

test('week is a rolling 7 days from today', () => {
  const w = arrivalsWindow('week', NOW);
  assert.equal(w.checkInFrom, '2026-09-05');
  assert.equal(w.checkInTo, '2026-09-12');
});

test('month is a rolling 30 days from today', () => {
  const w = arrivalsWindow('month', NOW);
  assert.equal(w.checkInFrom, '2026-09-05');
  assert.equal(w.checkInTo, '2026-10-05');
});

// Overdue is the same for every range: anything due before today that never
// arrived. This is what stopped a guest who was due yesterday from vanishing
// off the desk's screen entirely instead of demanding action.
test('overdueBefore is today for every range', () => {
  for (const r of ARRIVAL_RANGES) {
    assert.equal(arrivalsWindow(r, NOW).overdueBefore, '2026-09-05', `range ${r}`);
  }
});

test('an unknown or missing range falls back to today', () => {
  assert.equal(arrivalsWindow(undefined, NOW).range, 'today');
  assert.equal(arrivalsWindow('', NOW).range, 'today');
  assert.equal(arrivalsWindow('fortnight', NOW).range, 'today');
  assert.equal(arrivalsWindow('fortnight', NOW).checkInTo, '2026-09-06');
});

test('range is normalised case-insensitively', () => {
  assert.equal(arrivalsWindow('WEEK', NOW).range, 'week');
  assert.equal(arrivalsWindow('Month', NOW).checkInTo, '2026-10-05');
});

// Crossing a month boundary is where naive date arithmetic breaks.
test('a rolling window crosses month and year boundaries correctly', () => {
  const w = arrivalsWindow('week', new Date('2026-12-29T02:00:00.000Z'));
  assert.equal(w.checkInFrom, '2026-12-29');
  assert.equal(w.checkInTo, '2027-01-05');
});
