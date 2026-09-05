// Tests for GET /api/arrivals.
//
// THE BUG THIS FILE EXISTS FOR
// ----------------------------
// /api/arrivals used to read Stay rows with status PRE_ARRIVAL. Those rows are
// created ONLY by a reservation:confirmed Redis message
// (subscribers/redis.subscriber.js). A reservation confirmed while this service
// was down, or seeded directly, got no Stay row and was PERMANENTLY invisible to
// the front desk -- with no reconciliation anywhere. The first test below fails
// against the old implementation and is the regression gate.
//
//   node --test src/routes/arrivals.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// ── In-memory stay store ────────────────────────────────────────────────────

const memDb = { stay: new Map() };
let seq = 0;

function matches(row, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v && row[k] === v.not) return false;
      if ('in' in v && !v.in.includes(row[k])) return false;
      if ('notIn' in v && v.notIn.includes(row[k])) return false;
      if ('gte' in v && !(row[k] >= v.gte)) return false;
      if ('lt' in v && !(row[k] < v.lt)) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

const mockPrisma = {
  stay: {
    create: async ({ data }) => {
      const id = `s${(seq += 1)}`;
      const row = { id, status: 'PRE_ARRIVAL', ...data };
      memDb.stay.set(id, row);
      return row;
    },
    findMany: async ({ where } = {}) => [...memDb.stay.values()].filter((r) => matches(r, where || {})),
    findFirst: async ({ where }) => [...memDb.stay.values()].find((r) => matches(r, where)) || null,
    findUnique: async ({ where: { id } }) => memDb.stay.get(id) || null,
    update: async ({ where: { id }, data }) => {
      const row = { ...memDb.stay.get(id), ...data };
      memDb.stay.set(id, row);
      return row;
    },
    updateMany: async () => ({ count: 0 }),
    count: async ({ where } = {}) => [...memDb.stay.values()].filter((r) => matches(r, where || {})).length,
  },
  checkInTask: {
    create: async ({ data }) => data,
    findFirst: async () => null,
    findMany: async () => [],
    update: async ({ data }) => data,
  },
  $transaction: async (fn) => fn(mockPrisma),
};

// ── Stubs, installed before the route module loads ──────────────────────────

// stay.routes.js requires pdfkit at module scope for the registration card.
// Intercepted at the loader because require.resolve() throws when the module is
// genuinely absent from the test environment.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pdfkit') {
    return function PDFDocumentStub() {
      return {
        pipe() {}, fontSize() { return this; }, text() { return this; },
        moveDown() { return this; }, end() {},
      };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

require.cache[require.resolve('@prisma/client')] = {
  exports: { PrismaClient: function () { return mockPrisma; } },
};
require.cache[require.resolve('ioredis')] = {
  exports: function () { return { publish: () => {}, on: () => {}, disconnect: () => {} }; },
};
require.cache[require.resolve('../middleware/auth')] = {
  exports: {
    ROLE_GROUPS: new Proxy({}, { get: () => ['ADMIN'] }),
    verifyToken: (req, _res, next) => { req.user = { sub: 'u1', roles: ['ADMIN'] }; next(); },
    requireRole: () => (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
  },
};
require.cache[require.resolve('../lib/inventoryClient')] = {
  exports: {
    NoInventoryError: class extends Error {},
    makeInventoryClient: () => ({
      getRoom: async () => null, acquireHold: async () => ({ groupId: 'g1' }),
      attachHold: async () => ({}), releaseHold: async () => true, commitHold: async () => ({}),
    }),
  },
};

// The reservation service's answers, and whether it is reachable at all.
let reservations = [];
let reservationReachable = true;
let lastReservationQuery = null;

require.cache[require.resolve('../lib/serviceCall')] = {
  exports: {
    ServiceCallError: class extends Error {},
    makeServiceCaller: () => ({
      call: async (url) => {
        if (!reservationReachable) throw new Error('ECONNREFUSED');
        lastReservationQuery = new URL(url, 'http://x').searchParams;
        const from = lastReservationQuery.get('checkInFrom');
        const to = lastReservationQuery.get('checkInTo');
        return reservations.filter((r) => {
          const day = r.checkIn.slice(0, 10);
          // The route may ask for the overdue slice (no lower bound) or the
          // in-range slice; honour whichever bounds were sent.
          if (from && day < from) return false;
          if (to && day >= to) return false;
          return true;
        });
      },
    }),
  },
};

const router = require('./stay.routes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        { host: '127.0.0.1', port, method, path,
          headers: { 'Content-Type': 'application/json', ...(data && { 'Content-Length': Buffer.byteLength(data) }) } },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
        }
      );
      if (data) req.write(data);
      req.end();
    });
  });
}

// Today, as the UTC day key the route builds its window from.
const TODAY = new Date().toISOString().slice(0, 10);
function dayOffset(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

function reset() {
  memDb.stay.clear();
  seq = 0;
  reservations = [];
  reservationReachable = true;
  lastReservationQuery = null;
}

// ── The regression gate ─────────────────────────────────────────────────────

test('a CONFIRMED reservation with NO Stay row still appears in arrivals', async () => {
  reset();
  reservations = [{
    id: 'r1', status: 'CONFIRMED', guestId: 'g1', guestName: 'Jana Felismino',
    confirmationNumber: 'CN-1001', checkIn: `${TODAY}T00:00:00.000Z`,
    checkOut: `${dayOffset(3)}T00:00:00.000Z`, adults: 2, children: 1, roomTypeCode: 'DLX',
  }];
  // Deliberately NO stay row -- this is a reservation whose reservation:confirmed
  // event was never delivered.
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.equal(res.status, 200);
  assert.equal(res.body.arrivals.length, 1, 'a confirmed reservation must be visible without a Stay row');
  assert.equal(res.body.arrivals[0].reservationId, 'r1');
  assert.equal(res.body.arrivals[0].guestName, 'Jana Felismino');
  assert.equal(res.body.arrivals[0].confirmationNumber, 'CN-1001');
  assert.equal(res.body.arrivals[0].stayId, null, 'no stay row exists yet');
  assert.ok(res.body.arrivals[0].id, 'every row needs a stable key for React');
});

test('a reservation whose stay is already IN_HOUSE does not appear', async () => {
  reset();
  reservations = [{
    id: 'r1', status: 'CONFIRMED', guestId: 'g1', guestName: 'Jana Felismino',
    confirmationNumber: 'CN-1001', checkIn: `${TODAY}T00:00:00.000Z`,
    checkOut: `${dayOffset(3)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'DLX',
  }];
  // The Stay row is authoritative for "have they arrived". Reservation.status is
  // set by a Redis subscriber and is just as lossy as the projection this route
  // stopped reading -- so an in-house guest must be excluded by the JOIN, not by
  // trusting the reservation to have been updated.
  await mockPrisma.stay.create({ data: { reservationId: 'r1', status: 'IN_HOUSE', guestName: 'Jana Felismino' } });
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.deepEqual(res.body.arrivals, []);
});

test('a DEPARTED or NO_SHOW stay does not reappear as an arrival', async () => {
  for (const status of ['DEPARTED', 'NO_SHOW']) {
    reset();
    reservations = [{
      id: 'r1', status: 'CONFIRMED', guestId: 'g1', guestName: 'X', confirmationNumber: 'CN-1',
      checkIn: `${TODAY}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`,
      adults: 1, children: 0, roomTypeCode: 'STD',
    }];
    await mockPrisma.stay.create({ data: { reservationId: 'r1', status, guestName: 'X' } });
    const res = await call(makeApp(), 'GET', '/api/arrivals', null);
    assert.deepEqual(res.body.arrivals, [], `${status} must not appear`);
  }
});

test('an existing PRE_ARRIVAL stay is joined, and supplies stayId', async () => {
  reset();
  reservations = [{
    id: 'r1', status: 'CONFIRMED', guestId: 'g1', guestName: 'Jana', confirmationNumber: 'CN-1',
    checkIn: `${TODAY}T00:00:00.000Z`, checkOut: `${dayOffset(2)}T00:00:00.000Z`,
    adults: 1, children: 0, roomTypeCode: 'STD',
  }];
  const stay = await mockPrisma.stay.create({ data: { reservationId: 'r1', status: 'PRE_ARRIVAL', guestName: 'Jana' } });
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.equal(res.body.arrivals.length, 1);
  assert.equal(res.body.arrivals[0].stayId, stay.id);
  assert.equal(res.body.arrivals[0].id, stay.id);
});

// ── Ranges ──────────────────────────────────────────────────────────────────

test('range=today excludes an arrival due next week; range=week includes it', async () => {
  reset();
  reservations = [{
    id: 'r2', status: 'CONFIRMED', guestId: 'g2', guestName: 'Later Guest', confirmationNumber: 'CN-2',
    checkIn: `${dayOffset(4)}T00:00:00.000Z`, checkOut: `${dayOffset(6)}T00:00:00.000Z`,
    adults: 1, children: 0, roomTypeCode: 'STD',
  }];
  const today = await call(makeApp(), 'GET', '/api/arrivals?range=today', null);
  assert.deepEqual(today.body.arrivals, []);
  assert.equal(today.body.range, 'today');

  const week = await call(makeApp(), 'GET', '/api/arrivals?range=week', null);
  assert.equal(week.body.arrivals.length, 1);
  assert.equal(week.body.range, 'week');
});

test('range=month includes an arrival three weeks out', async () => {
  reset();
  reservations = [{
    id: 'r3', status: 'CONFIRMED', guestId: 'g3', guestName: 'Far Guest', confirmationNumber: 'CN-3',
    checkIn: `${dayOffset(21)}T00:00:00.000Z`, checkOut: `${dayOffset(23)}T00:00:00.000Z`,
    adults: 1, children: 0, roomTypeCode: 'STD',
  }];
  const res = await call(makeApp(), 'GET', '/api/arrivals?range=month', null);
  assert.equal(res.body.arrivals.length, 1);
});

// ── Overdue ─────────────────────────────────────────────────────────────────

test('an overdue arrival appears in ALL THREE ranges, flagged overdue', async () => {
  for (const range of ['today', 'week', 'month']) {
    reset();
    reservations = [{
      id: 'r4', status: 'CONFIRMED', guestId: 'g4', guestName: 'Yesterday Guest', confirmationNumber: 'CN-4',
      checkIn: `${dayOffset(-1)}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`,
      adults: 1, children: 0, roomTypeCode: 'STD',
    }];
    const res = await call(makeApp(), 'GET', `/api/arrivals?range=${range}`, null);
    assert.equal(res.body.arrivals.length, 1, `overdue must show in range=${range}`);
    assert.equal(res.body.arrivals[0].overdue, true);
  }
});

test('overdue rows sort before in-range rows', async () => {
  reset();
  reservations = [
    { id: 'today1', status: 'CONFIRMED', guestId: 'g5', guestName: 'Today Guest', confirmationNumber: 'CN-5',
      checkIn: `${TODAY}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
    { id: 'late1', status: 'CONFIRMED', guestId: 'g6', guestName: 'Overdue Guest', confirmationNumber: 'CN-6',
      checkIn: `${dayOffset(-2)}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
  ];
  const res = await call(makeApp(), 'GET', '/api/arrivals?range=today', null);
  assert.equal(res.body.arrivals.length, 2);
  assert.equal(res.body.arrivals[0].reservationId, 'late1', 'the overdue guest is the one needing action');
  assert.equal(res.body.arrivals[1].reservationId, 'today1');
});

// ── ?date= — the night audit's and reports service's form ───────────────────

test('?date= returns exactly that day, with NO overdue rows', async () => {
  reset();
  reservations = [
    { id: 'onday', status: 'CONFIRMED', guestId: 'g7', guestName: 'On The Day', confirmationNumber: 'CN-7',
      checkIn: `${TODAY}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
    { id: 'earlier', status: 'CONFIRMED', guestId: 'g8', guestName: 'Days Ago', confirmationNumber: 'CN-8',
      checkIn: `${dayOffset(-3)}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
  ];
  const res = await call(makeApp(), 'GET', `/api/arrivals?date=${TODAY}`, null);
  assert.equal(res.status, 200);
  assert.equal(res.body.arrivals.length, 1, 'the audit asks a bounded question -- other days must not leak in');
  assert.equal(res.body.arrivals[0].reservationId, 'onday');
  assert.equal(res.body.range, null, 'range is null when date was used');
});

test('?date= for a past day returns that day, not today', async () => {
  reset();
  const past = dayOffset(-3);
  reservations = [
    { id: 'past1', status: 'CONFIRMED', guestId: 'g9', guestName: 'Past Guest', confirmationNumber: 'CN-9',
      checkIn: `${past}T00:00:00.000Z`, checkOut: `${dayOffset(-1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
  ];
  const res = await call(makeApp(), 'GET', `/api/arrivals?date=${past}`, null);
  assert.equal(res.body.arrivals.length, 1);
  assert.equal(res.body.arrivals[0].overdue, false, 'nothing is overdue relative to its own day');
});

test('date wins over range when both are sent', async () => {
  reset();
  reservations = [
    { id: 'far', status: 'CONFIRMED', guestId: 'g10', guestName: 'Far', confirmationNumber: 'CN-10',
      checkIn: `${dayOffset(20)}T00:00:00.000Z`, checkOut: `${dayOffset(21)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
  ];
  const res = await call(makeApp(), 'GET', `/api/arrivals?date=${TODAY}&range=month`, null);
  assert.deepEqual(res.body.arrivals, [], 'the date window, not the month window');
});

// ── Degraded mode ───────────────────────────────────────────────────────────

test('an unreachable reservation service degrades to local stays, not a 500', async () => {
  reset();
  reservationReachable = false;
  await mockPrisma.stay.create({
    data: { reservationId: 'r9', status: 'PRE_ARRIVAL', guestName: 'Local Only',
      expectedCheckIn: new Date(`${TODAY}T02:00:00.000Z`), expectedCheckOut: new Date(`${dayOffset(2)}T02:00:00.000Z`) },
  });
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.equal(res.status, 200, 'the desk needs a list, even a partial one');
  assert.equal(res.body.degraded, true, 'a short list must never silently claim to be complete');
  assert.equal(res.body.arrivals.length, 1);
  assert.equal(res.body.arrivals[0].guestName, 'Local Only');
});

test('a healthy response is not marked degraded', async () => {
  reset();
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.equal(res.body.degraded, false);
  assert.deepEqual(res.body.arrivals, []);
});

test('the reservation service is asked only for CONFIRMED reservations', async () => {
  reset();
  await call(makeApp(), 'GET', '/api/arrivals?range=week', null);
  assert.equal(lastReservationQuery.get('status'), 'CONFIRMED');
  assert.ok(lastReservationQuery.get('checkInTo'), 'an arrival window must be sent');
});
