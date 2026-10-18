// node --test src/lib/roomAssignment.test.js

const test = require('node:test');
const assert = require('node:assert');

const { pickAssignableRoom, freeRoomIds, isRoomFree, roomsBlockedByStays } = require('./roomAssignment');

// A room "occupied" tonight (or booked by an overlapping reservation with no
// dates in common with the window under test) is still a real candidate —
// this fake exists to prove the ROOM STATUS never gates these functions;
// only Reservation-table overlap does.
function fakeInventory(candidateRooms) {
  return {
    async roomCandidates() {
      return candidateRooms;
    },
  };
}

function fakePrisma(overlappingReservations) {
  return {
    reservation: {
      async findMany({ where }) {
        // Mirror the real WHERE well enough for these tests: filter by
        // assignedRoomId membership and the checkIn/checkOut overlap Prisma
        // clauses that overlappingRoomsWhere() actually produces.
        return overlappingReservations.filter((r) => {
          if (!where.assignedRoomId.in.includes(r.assignedRoomId)) return false;
          if (where.id && r.id === where.id.not) return false;
          const ciLt = where.checkIn.lt;
          const coGt = where.checkOut.gt;
          return r.checkIn < ciLt && r.checkOut > coGt;
        });
      },
    },
  };
}

test('freeRoomIds returns every candidate when nothing overlaps', async () => {
  const inventory = fakeInventory([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
  const prisma = fakePrisma([]);
  const ids = await freeRoomIds({
    inventory,
    prisma,
    roomTypeCode: 'STD',
    checkIn: '2026-12-01',
    checkOut: '2026-12-03',
  });
  assert.deepStrictEqual(ids, ['r1', 'r2', 'r3']);
});

test('freeRoomIds excludes a room another reservation holds for an overlapping window', async () => {
  const inventory = fakeInventory([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
  const prisma = fakePrisma([
    { id: 'res1', assignedRoomId: 'r2', checkIn: new Date('2026-12-02'), checkOut: new Date('2026-12-05') },
  ]);
  const ids = await freeRoomIds({
    inventory,
    prisma,
    roomTypeCode: 'STD',
    checkIn: '2026-12-01',
    checkOut: '2026-12-03',
  });
  assert.deepStrictEqual(ids, ['r1', 'r3']);
});

test('freeRoomIds does NOT exclude a room whose overlapping reservation is for different, non-overlapping dates', async () => {
  const inventory = fakeInventory([{ id: 'r1' }]);
  // Booked for a window that ends before the requested check-in starts.
  const prisma = fakePrisma([
    { id: 'res1', assignedRoomId: 'r1', checkIn: new Date('2026-11-01'), checkOut: new Date('2026-11-05') },
  ]);
  const ids = await freeRoomIds({
    inventory,
    prisma,
    roomTypeCode: 'STD',
    checkIn: '2026-12-01',
    checkOut: '2026-12-03',
  });
  assert.deepStrictEqual(ids, ['r1']);
});

test('freeRoomIds excludes ids the caller already ruled out (excludeRoomIds)', async () => {
  const inventory = fakeInventory([{ id: 'r1' }, { id: 'r2' }]);
  const prisma = fakePrisma([]);
  const ids = await freeRoomIds({
    inventory,
    prisma,
    roomTypeCode: 'STD',
    checkIn: '2026-12-01',
    checkOut: '2026-12-03',
    excludeRoomIds: ['r1'],
  });
  assert.deepStrictEqual(ids, ['r2']);
});

test('freeRoomIds excludes the reservation being moved from its own overlap check', async () => {
  const inventory = fakeInventory([{ id: 'r1' }]);
  const prisma = fakePrisma([
    { id: 'self', assignedRoomId: 'r1', checkIn: new Date('2026-12-01'), checkOut: new Date('2026-12-03') },
  ]);
  const ids = await freeRoomIds({
    inventory,
    prisma,
    roomTypeCode: 'STD',
    checkIn: '2026-12-01',
    checkOut: '2026-12-03',
    excludeReservationId: 'self',
  });
  assert.deepStrictEqual(ids, ['r1']);
});

test('freeRoomIds returns [] rather than throwing when inventory cannot be reached', async () => {
  const inventory = { async roomCandidates() { throw new Error('inventory down'); } };
  const prisma = fakePrisma([]);
  const ids = await freeRoomIds({ inventory, prisma, roomTypeCode: 'STD', checkIn: '2026-12-01', checkOut: '2026-12-03' });
  assert.deepStrictEqual(ids, []);
});

test('pickAssignableRoom returns the first free id in inventory preference order', async () => {
  const inventory = fakeInventory([{ id: 'r1' }, { id: 'r2' }]);
  const prisma = fakePrisma([
    { id: 'res1', assignedRoomId: 'r1', checkIn: new Date('2026-12-01'), checkOut: new Date('2026-12-03') },
  ]);
  const id = await pickAssignableRoom({
    inventory,
    prisma,
    roomTypeCode: 'STD',
    checkIn: '2026-12-01',
    checkOut: '2026-12-03',
  });
  assert.strictEqual(id, 'r2');
});

test('pickAssignableRoom returns null when every candidate is taken', async () => {
  const inventory = fakeInventory([{ id: 'r1' }]);
  const prisma = fakePrisma([
    { id: 'res1', assignedRoomId: 'r1', checkIn: new Date('2026-12-01'), checkOut: new Date('2026-12-03') },
  ]);
  const id = await pickAssignableRoom({
    inventory,
    prisma,
    roomTypeCode: 'STD',
    checkIn: '2026-12-01',
    checkOut: '2026-12-03',
  });
  assert.strictEqual(id, null);
});

// ── rooms a guest is standing in (walk-ins and overstays have no reservation) ──

const NOW = new Date('2026-10-18T10:00:00Z').getTime();
const walkIn = (extra) => ({ assignedRoomId: 'r1', reservationId: null, actualCheckInAt: '2026-10-12T04:45:00Z', ...extra });

test('roomsBlockedByStays blocks a room a walk-in occupies until their expected check-out', () => {
  const stay = walkIn({ expectedCheckOut: '2026-10-20T04:00:00Z' });
  assert.ok(roomsBlockedByStays([stay], ['r1'], '2026-10-19T06:00:00Z', '2026-10-21T04:00:00Z', NOW).has('r1'));
  assert.ok(!roomsBlockedByStays([stay], ['r1'], '2026-10-20T06:00:00Z', '2026-10-22T04:00:00Z', NOW).has('r1'));
});

test('roomsBlockedByStays treats an overstay as still in the room for the next 24 hours only', () => {
  const overstay = walkIn({ expectedCheckOut: '2026-10-13T04:00:00Z' });
  assert.ok(roomsBlockedByStays([overstay], ['r1'], '2026-10-18T06:00:00Z', '2026-10-22T04:00:00Z', NOW).has('r1'));
  assert.ok(!roomsBlockedByStays([overstay], ['r1'], '2026-10-25T06:00:00Z', '2026-10-28T04:00:00Z', NOW).has('r1'));
});

test('roomsBlockedByStays blocks a walk-in with no expected check-out for the next 24 hours', () => {
  const open = walkIn({ expectedCheckOut: null });
  assert.ok(roomsBlockedByStays([open], ['r1'], '2026-10-18T06:00:00Z', '2026-10-20T04:00:00Z', NOW).has('r1'));
  assert.ok(!roomsBlockedByStays([open], ['r1'], '2026-10-22T06:00:00Z', '2026-10-24T04:00:00Z', NOW).has('r1'));
});

test('roomsBlockedByStays leaves a reservation-backed stay with no expected check-out to its booking', () => {
  const booked = walkIn({ reservationId: 'res1', expectedCheckOut: null });
  assert.strictEqual(roomsBlockedByStays([booked], ['r1'], '2026-10-18T06:00:00Z', '2026-10-20T04:00:00Z', NOW).size, 0);
});

test('roomsBlockedByStays ignores rooms that were not asked about', () => {
  const stay = walkIn({ assignedRoomId: 'r9', expectedCheckOut: null });
  assert.strictEqual(roomsBlockedByStays([stay], ['r1'], '2026-10-18T06:00:00Z', '2026-10-20T04:00:00Z', NOW).size, 0);
});

test('freeRoomIds leaves out a room an in-house walk-in occupies, so auto-assign skips it', async () => {
  const inventory = fakeInventory([{ id: 'r1' }, { id: 'r2' }]);
  const stayClient = { async inHouseStays() { return [walkIn({ expectedCheckOut: null, actualCheckInAt: new Date().toISOString() })]; } };
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const args = { inventory, prisma: fakePrisma([]), roomTypeCode: 'STD', checkIn: day(0), checkOut: day(2), stayClient };
  assert.deepStrictEqual(await freeRoomIds(args), ['r2']);
  assert.strictEqual(await pickAssignableRoom(args), 'r2');
  assert.strictEqual(await isRoomFree({ ...args, roomId: 'r1' }), false, 'a manual pick of the occupied room is refused');
  assert.strictEqual(await isRoomFree({ ...args, roomId: 'r2' }), true);
});

test('freeRoomIds still assigns rooms when the stay service is unreachable', async () => {
  const inventory = fakeInventory([{ id: 'r1' }]);
  const stayClient = { async inHouseStays() { throw new Error('stay down'); } };
  const ids = await freeRoomIds({ inventory, prisma: fakePrisma([]), roomTypeCode: 'STD', checkIn: '2026-12-01', checkOut: '2026-12-03', stayClient });
  assert.deepStrictEqual(ids, ['r1']);
});
