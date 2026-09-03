// GET /api/availability/find-room — the ordered candidate list that reservation
// auto-assignment picks from.
//
// WHY `candidates` EXISTS ALONGSIDE `room`
// ----------------------------------------
// `room` answers "give me one free room", and gates on room-type availability.
// That gate is wrong for the caller that assigns a room to a booking it has
// ALREADY held capacity for: its own hold consumes the last unit, so `available`
// reads 0 and the last room of a type could never be assigned to the very
// booking that reserved it.
//
// `candidates` is therefore the plain, ordered list of physically usable rooms,
// ungated. Whether each one is free for a DATE RANGE is decided by the
// reservation service, which owns assignedRoomId — see
// services/reservation/src/lib/roomAssignment.js.
//
//   node --test src/routes/findRoom.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const state = { rooms: [], roomTypes: new Map(), holds: [] };

function makeMockPrisma() {
  return {
    room: {
      findMany: async ({ where = {}, orderBy = [] }) => {
        let rows = state.rooms.filter((r) => {
          if (where.typeCode && r.typeCode !== where.typeCode) return false;
          if (where.status?.notIn && where.status.notIn.includes(r.status)) return false;
          if (where.id?.not && r.id === where.id.not) return false;
          return true;
        });
        for (const key of [...orderBy].reverse()) {
          const [field, dir] = Object.entries(key)[0];
          rows = [...rows].sort(
            (a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === 'desc' ? -1 : 1)
          );
        }
        return rows;
      },
      findUnique: async ({ where }) => state.rooms.find((r) => r.id === where.id) || null,
    },
    roomType: { findUnique: async ({ where }) => state.roomTypes.get(where.code) || null },
    inventoryHold: { findMany: async () => state.holds },
    facilityBooking: { findFirst: async () => null },
    $transaction: async (fn) => fn(makeMockPrisma()),
  };
}

// lib/prisma.js does `new PrismaClient({ log })` at require time, so the stub
// has to be constructible — an arrow function is not.
const mockPrisma = makeMockPrisma();
require.cache[require.resolve('@prisma/client')] = {
  exports: {
    PrismaClient: function () {
      return mockPrisma;
    },
  },
};
require.cache[require.resolve('ioredis')] = {
  exports: function () {
    return { publish: () => {}, on: () => {}, disconnect: () => {} };
  },
};
require.cache[require.resolve('../middleware/auth')] = {
  exports: {
    ROLE_GROUPS: new Proxy({}, { get: () => ['ADMIN'] }),
    verifyToken: (req, _res, next) => {
      req.user = { sub: 'u1', roles: ['ADMIN'] };
      next();
    },
    requireRole: () => (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
  },
};

const router = require('./inventory.routes');
const app = express();
app.use(express.json());
app.use('/api', router);
const server = app.listen(0);
test.after(() => server.close());

function get(path) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
  });
}

function reset() {
  state.rooms = [];
  state.holds = [];
  state.roomTypes = new Map([['STD', { code: 'STD', totalInventory: 3 }]]);
}

const RANGE = 'typeCode=STD&checkIn=2026-09-05&checkOut=2026-09-07';

test('candidates are ordered by floor then room number', async () => {
  reset();
  state.rooms = [
    { id: 'r305', number: '305', typeCode: 'STD', floor: 3, status: 'CLEAN' },
    { id: 'r202', number: '202', typeCode: 'STD', floor: 2, status: 'DIRTY' },
    { id: 'r201', number: '201', typeCode: 'STD', floor: 2, status: 'CLEAN' },
  ];
  const res = await get(`/api/availability/find-room?${RANGE}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(
    res.body.candidates.map((r) => r.id),
    ['r201', 'r202', 'r305']
  );
});

test('a room occupied tonight is still a candidate for a future range', async () => {
  // Room.status describes the room RIGHT NOW. Excluding OCCUPIED would refuse
  // to assign a room to anything booked while its current guest is in it.
  reset();
  state.rooms = [{ id: 'r201', number: '201', typeCode: 'STD', floor: 2, status: 'OCCUPIED' }];
  const res = await get(`/api/availability/find-room?${RANGE}`);
  assert.deepStrictEqual(
    res.body.candidates.map((r) => r.id),
    ['r201']
  );
});

test('an out-of-order room is never a candidate', async () => {
  reset();
  state.rooms = [
    { id: 'r201', number: '201', typeCode: 'STD', floor: 2, status: 'OUT_OF_ORDER' },
    { id: 'r202', number: '202', typeCode: 'STD', floor: 2, status: 'OUT_OF_SERVICE' },
    { id: 'r203', number: '203', typeCode: 'STD', floor: 2, status: 'CLEAN' },
  ];
  const res = await get(`/api/availability/find-room?${RANGE}`);
  assert.deepStrictEqual(
    res.body.candidates.map((r) => r.id),
    ['r203']
  );
});

test('candidates are still offered when the type-level hold count is exhausted', async () => {
  // The booking being assigned is itself the reason capacity reads zero. Gating
  // the candidate list on `available` made the last room of a type unassignable
  // to the booking that had just claimed it.
  reset();
  state.roomTypes = new Map([['STD', { code: 'STD', totalInventory: 1 }]]);
  state.rooms = [{ id: 'r201', number: '201', typeCode: 'STD', floor: 2, status: 'CLEAN' }];
  state.holds = [
    { roomTypeCode: 'STD', date: new Date('2026-09-05'), quantity: 1, status: 'ACTIVE' },
    { roomTypeCode: 'STD', date: new Date('2026-09-06'), quantity: 1, status: 'ACTIVE' },
  ];
  const res = await get(`/api/availability/find-room?${RANGE}`);
  assert.strictEqual(res.body.available, 0, 'the type is fully held');
  assert.strictEqual(res.body.room, null, '`room` keeps its availability-gated meaning');
  assert.deepStrictEqual(
    res.body.candidates.map((r) => r.id),
    ['r201'],
    '`candidates` is ungated so the holder of the last unit can be given the room'
  );
});

test('a room type with no rooms yields an empty candidate list', async () => {
  reset();
  const res = await get(`/api/availability/find-room?${RANGE}`);
  assert.deepStrictEqual(res.body.candidates, []);
});
