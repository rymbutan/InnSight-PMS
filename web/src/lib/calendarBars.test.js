import test from 'node:test';
import assert from 'node:assert';

import { buildBars } from './calendarBars.js';

// The calendar window used throughout: 5 nights from 2026-09-05.
const days = Array.from({ length: 5 }, (_, i) => new Date(2026, 8, 5 + i));

const rooms = [
  { id: 'r201', number: '201', typeCode: 'STD', status: 'CLEAN' },
  { id: 'r202', number: '202', typeCode: 'STD', status: 'CLEAN' },
];

function reservation(over = {}) {
  return {
    id: 'res1',
    guestName: 'Maria Santos',
    status: 'CONFIRMED',
    assignedRoomId: 'r201',
    checkIn: '2026-09-06',
    checkOut: '2026-09-08',
    depositCents: 5000,
    ...over,
  };
}

test('a booking is placed on its room row with the guest name as the label', () => {
  const { byRoom } = buildBars({ reservations: [reservation()], rooms, days });
  assert.deepStrictEqual(
    byRoom.r201.map((b) => ({ label: b.label, startCol: b.startCol, span: b.span })),
    [{ label: 'Maria Santos', startCol: 1, span: 2 }]
  );
});

test('the bar spans one column per night of the stay', () => {
  const { byRoom } = buildBars({
    reservations: [reservation({ checkIn: '2026-09-05', checkOut: '2026-09-09' })],
    rooms,
    days,
  });
  assert.strictEqual(byRoom.r201[0].span, 4, 'four nights → four columns');
  assert.strictEqual(byRoom.r201[0].nights, 4);
});

test('a stay that began before the window is clipped to its left edge', () => {
  const { byRoom } = buildBars({
    reservations: [reservation({ checkIn: '2026-09-01', checkOut: '2026-09-07' })],
    rooms,
    days,
  });
  assert.strictEqual(byRoom.r201[0].startCol, 0);
  assert.strictEqual(byRoom.r201[0].span, 2, 'only the 5th and 6th fall inside the window');
  assert.strictEqual(byRoom.r201[0].nights, 6, 'the true length of stay is preserved for display');
});

test('a stay running past the window is clipped to its right edge', () => {
  const { byRoom } = buildBars({
    reservations: [reservation({ checkIn: '2026-09-08', checkOut: '2026-09-30' })],
    rooms,
    days,
  });
  assert.strictEqual(byRoom.r201[0].startCol, 3);
  assert.strictEqual(byRoom.r201[0].span, 2, 'clipped at the window end, never wider than the grid');
});

test('a booking outside the window is not drawn', () => {
  const { byRoom } = buildBars({
    reservations: [reservation({ checkIn: '2026-10-01', checkOut: '2026-10-03' })],
    rooms,
    days,
  });
  assert.deepStrictEqual(byRoom, {});
});

test('a booking checking out on the first day of the window is not drawn', () => {
  const { byRoom } = buildBars({
    reservations: [reservation({ checkIn: '2026-09-02', checkOut: '2026-09-05' })],
    rooms,
    days,
  });
  assert.deepStrictEqual(byRoom, {});
});

test('cancelled and no-show bookings are not drawn', () => {
  const { byRoom } = buildBars({
    reservations: [
      reservation({ id: 'a', status: 'CANCELLED' }),
      reservation({ id: 'b', status: 'NO_SHOW' }),
    ],
    rooms,
    days,
  });
  assert.deepStrictEqual(byRoom, {});
});

test('a booking with no room assigned is reported, never silently dropped', () => {
  // This is the whole bug: the calendar used to `continue` past these, so a
  // saved reservation existed everywhere except on the board.
  const { byRoom, unassigned } = buildBars({
    reservations: [reservation({ assignedRoomId: null })],
    rooms,
    days,
  });
  assert.deepStrictEqual(byRoom, {});
  assert.deepStrictEqual(
    unassigned.map((b) => b.label),
    ['Maria Santos']
  );
});

test('an empty-string room id counts as unassigned', () => {
  const { unassigned } = buildBars({
    reservations: [reservation({ assignedRoomId: '' })],
    rooms,
    days,
  });
  assert.strictEqual(unassigned.length, 1);
});

test('a booking outside the window is not counted as unassigned', () => {
  const { unassigned } = buildBars({
    reservations: [reservation({ assignedRoomId: null, checkIn: '2026-12-01', checkOut: '2026-12-03' })],
    rooms,
    days,
  });
  assert.deepStrictEqual(unassigned, []);
});

test('an in-house stay replaces its own reservation rather than doubling it', () => {
  const { byRoom } = buildBars({
    reservations: [reservation()],
    stays: [
      {
        id: 's1',
        reservationId: 'res1',
        assignedRoomId: 'r201',
        guestName: 'Maria Santos',
        status: 'IN_HOUSE',
        actualCheckInAt: '2026-09-06',
        expectedCheckOut: '2026-09-08',
      },
    ],
    rooms,
    days,
  });
  assert.strictEqual(byRoom.r201.length, 1);
  assert.strictEqual(byRoom.r201[0].key, 'stay-s1');
  assert.strictEqual(byRoom.r201[0].status, 'in_house');
});

test('an out-of-order room is blocked across the whole window', () => {
  const { byRoom } = buildBars({
    rooms: [{ id: 'r203', number: '203', typeCode: 'STD', status: 'OUT_OF_ORDER' }],
    days,
  });
  assert.deepStrictEqual(
    byRoom.r203.map((b) => ({ startCol: b.startCol, span: b.span, status: b.status })),
    [{ startCol: 0, span: 5, status: 'ooo' }]
  );
});

test('a fully paid booking is not flagged as owing a balance', () => {
  const { byRoom } = buildBars({ reservations: [reservation({ depositCents: 5000 })], rooms, days });
  assert.strictEqual(byRoom.r201[0].balanceDue, false);
  const unpaid = buildBars({ reservations: [reservation({ depositCents: 0 })], rooms, days });
  assert.strictEqual(unpaid.byRoom.r201[0].balanceDue, true);
});

test('two separate bookings in one room are both drawn', () => {
  const { byRoom } = buildBars({
    reservations: [
      reservation({ id: 'first', checkIn: '2026-09-05', checkOut: '2026-09-07' }),
      reservation({ id: 'second', checkIn: '2026-09-07', checkOut: '2026-09-09' }),
    ],
    rooms,
    days,
  });
  assert.deepStrictEqual(
    byRoom.r201.map((b) => [b.startCol, b.span]),
    [
      [0, 2],
      [2, 2],
    ]
  );
});
