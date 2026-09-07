import test from 'node:test';
import assert from 'node:assert';

import { buildFacilityBars, MIN_SLOT_FRAC } from './facilityBars.js';

// The same window shape the board uses, kept short so the assertions read.
const days = Array.from({ length: 5 }, (_, i) => new Date(2026, 8, 5 + i));

const facilities = [
  { id: 'f-hall', code: 'HALL', name: 'Function Hall' },
  { id: 'f-pool', code: 'POOL', name: 'Pool' },
];

// Local wall-clock, because that is what the grid columns are.
function at(dayOffset, hour, minute = 0) {
  return new Date(2026, 8, 5 + dayOffset, hour, minute).toISOString();
}

function booking(over = {}) {
  return {
    id: 'b1',
    facilityId: 'f-hall',
    facility: { code: 'HALL', name: 'Function Hall' },
    guestName: 'Maria Santos',
    status: 'CONFIRMED',
    startAt: at(1, 9),
    endAt: at(1, 12),
    persons: 20,
    priceCents: 500000,
    ...over,
  };
}

test('a slot lands in the column of its day, offset by its start time', () => {
  const { byFacility } = buildFacilityBars({ bookings: [booking()], facilities, days });
  const [bar] = byFacility['f-hall'];
  assert.strictEqual(bar.startCol, 1);
  // 09:00 is three eighths of the way through the day, and three hours is an eighth of it.
  assert.ok(Math.abs(bar.offset - 9 / 24) < 1e-9, `offset ${bar.offset}`);
  assert.ok(Math.abs(bar.width - 3 / 24) < 1e-9, `width ${bar.width}`);
  assert.strictEqual(bar.minutes, 180);
});

test('two slots on the same facility the same day sit in separate lanes only when they would collide', () => {
  // 09:00-12:00 then 23:00-23:30. Far enough apart that the drawn minimum
  // width of the first still ends before the second starts.
  const { byFacility, lanesByFacility } = buildFacilityBars({
    bookings: [booking(), booking({ id: 'b2', startAt: at(1, 23), endAt: at(1, 23, 30) })],
    facilities,
    days,
  });
  assert.deepStrictEqual(
    byFacility['f-hall'].map((b) => b.lane),
    [0, 0]
  );
  assert.strictEqual(lanesByFacility['f-hall'], 1);
});

test('a short slot is given a lane against its DRAWN width, not its real one', () => {
  // 09:00-09:30 then 10:00-10:30. Half an hour apart in truth, but each is
  // floored to a third of a column when drawn, so they overlap on screen.
  const { byFacility, lanesByFacility } = buildFacilityBars({
    bookings: [
      booking({ id: 'b1', startAt: at(1, 9), endAt: at(1, 9, 30) }),
      booking({ id: 'b2', startAt: at(1, 10), endAt: at(1, 10, 30) }),
    ],
    facilities,
    days,
  });
  assert.ok(MIN_SLOT_FRAC * 24 > 1, 'the floor has to be wider than the one-hour gap for this to bite');
  assert.deepStrictEqual(
    byFacility['f-hall'].map((b) => b.lane),
    [0, 1]
  );
  assert.strictEqual(lanesByFacility['f-hall'], 2);
});

test('sibling facilities keep their own lanes', () => {
  const { lanesByFacility } = buildFacilityBars({
    bookings: [booking(), booking({ id: 'b2', facilityId: 'f-pool', facility: { code: 'POOL' } })],
    facilities,
    days,
  });
  assert.strictEqual(lanesByFacility['f-hall'], 1);
  assert.strictEqual(lanesByFacility['f-pool'], 1);
});

test('a booking that runs past midnight keeps one bar, wider than a column', () => {
  const { byFacility } = buildFacilityBars({
    bookings: [booking({ startAt: at(1, 20), endAt: at(2, 2) })],
    facilities,
    days,
  });
  const [bar] = byFacility['f-hall'];
  assert.strictEqual(bar.startCol, 1);
  assert.ok(Math.abs(bar.offset - 20 / 24) < 1e-9);
  assert.ok(Math.abs(bar.width - 6 / 24) < 1e-9, `width ${bar.width}`);
  assert.strictEqual(bar.continuesAfter, false);
});

test('a booking clipped by the window says so instead of looking shorter', () => {
  const before = buildFacilityBars({
    bookings: [booking({ startAt: at(-1, 22), endAt: at(0, 3) })],
    facilities,
    days,
  });
  const [head] = before.byFacility['f-hall'];
  assert.strictEqual(head.continuesBefore, true);
  assert.strictEqual(head.startCol, 0);
  assert.strictEqual(head.offset, 0);
  assert.ok(Math.abs(head.width - 3 / 24) < 1e-9, `width ${head.width}`);

  const after = buildFacilityBars({
    bookings: [booking({ startAt: at(4, 22), endAt: at(5, 3) })],
    facilities,
    days,
  });
  const [tail] = after.byFacility['f-hall'];
  assert.strictEqual(tail.continuesAfter, true);
  assert.strictEqual(tail.startCol, 4);
  assert.ok(Math.abs(tail.width - 2 / 24) < 1e-9, `width ${tail.width}`);
});

test('a booking entirely outside the window is not drawn', () => {
  const { byFacility, unplaced } = buildFacilityBars({
    bookings: [booking({ startAt: at(40, 9), endAt: at(40, 12) })],
    facilities,
    days,
  });
  assert.deepStrictEqual(byFacility, {});
  assert.deepStrictEqual(unplaced, []);
});

test('a cancelled booking has released its space and is not drawn', () => {
  const { byFacility } = buildFacilityBars({
    bookings: [booking({ status: 'CANCELLED' })],
    facilities,
    days,
  });
  assert.deepStrictEqual(byFacility, {});
});

test('a booking whose facility has no row is surfaced, never dropped', () => {
  const { byFacility, unplaced } = buildFacilityBars({
    bookings: [booking({ facilityId: 'f-gone', facility: { code: 'GONE', name: 'Old Gym' } })],
    facilities,
    days,
  });
  assert.deepStrictEqual(byFacility, {});
  assert.strictEqual(unplaced.length, 1);
  assert.strictEqual(unplaced[0].label, 'Maria Santos');
});

test('a row list built from codes still matches its bookings', () => {
  const { byFacility } = buildFacilityBars({
    bookings: [booking({ facilityId: 'some-other-id' })],
    facilities: [{ code: 'HALL', name: 'Function Hall' }],
    days,
  });
  assert.strictEqual(byFacility['HALL'].length, 1);
});

test('a zero-length or reversed slot is refused rather than drawn backwards', () => {
  const { byFacility } = buildFacilityBars({
    bookings: [
      booking({ id: 'b1', startAt: at(1, 12), endAt: at(1, 12) }),
      booking({ id: 'b2', startAt: at(1, 12), endAt: at(1, 9) }),
      booking({ id: 'b3', startAt: 'not a date', endAt: at(1, 9) }),
    ],
    facilities,
    days,
  });
  assert.deepStrictEqual(byFacility, {});
});

test('an empty window returns empty rather than throwing', () => {
  const out = buildFacilityBars({ bookings: [booking()], facilities, days: [] });
  assert.deepStrictEqual(out, { byFacility: {}, lanesByFacility: {}, unplaced: [] });
});
