// Integration tests for reservation routes — runs the routes against an
// Express app instance with mocked Prisma + Redis so we don't need a DB.
// Uses Node's built-in test runner (already configured in package.json).
//
//   npm test --prefix services/reservation

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// Reservation rows carry BigInt money columns, and JSON.stringify throws on
// BigInt. src/index.js installs this shim in production; the route tests mount
// the router directly without index.js, so they need it too.
//
// Without it every 201 response became a 500 — which is exactly what had
// happened: services/reservation/package.json declared no "test" script, so CI's
// `npm test --if-present` silently skipped this file and the rot went unnoticed.
if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function () {
    return this.toString();
  };
}

// ── Mock Prisma + Redis BEFORE requiring the route file ──────────
const memDb = {
  reservation: new Map(),
  reservationNote: new Map(),
  reservationActivity: new Map(),
  appSetting: new Map(),
};

// Evaluate a Prisma-shaped `where` against a plain row.
//
// The mock used to IGNORE `where` entirely, so every filter on the list route
// was untested — which is precisely how the calendar's date-window filter
// stayed wrong while 48 tests reported green. A mock that silently drops the
// thing under test is worse than no mock.
function matchesWhere(row, where) {
  if (!where) return true;
  for (const [field, cond] of Object.entries(where)) {
    if (field === 'OR') {
      if (!cond.some((c) => matchesWhere(row, c))) return false;
      continue;
    }
    const v = row[field];
    if (cond === null || typeof cond !== 'object') {
      if (v !== cond) return false;
      continue;
    }
    for (const [op, arg] of Object.entries(cond)) {
      if (arg === undefined) continue;
      switch (op) {
        case 'equals':
          if (v !== arg) return false;
          break;
        case 'not':
          if (v === arg) return false;
          break;
        case 'gt':
          if (!(v > arg)) return false;
          break;
        case 'gte':
          if (!(v >= arg)) return false;
          break;
        case 'lt':
          if (!(v < arg)) return false;
          break;
        case 'lte':
          if (!(v <= arg)) return false;
          break;
        case 'in':
          if (!arg.includes(v)) return false;
          break;
        case 'notIn':
          if (arg.includes(v)) return false;
          break;
        case 'contains':
          if (
            !String(v ?? '')
              .toLowerCase()
              .includes(String(arg).toLowerCase())
          )
            return false;
          break;
        case 'mode':
          break; // case-insensitivity is already how `contains` is implemented here
        default:
          throw new Error(`matchesWhere: unsupported operator "${op}"`);
      }
    }
  }
  return true;
}

function makeMockPrisma() {
  function applyOrderBy(arr, ob) {
    if (!ob) return arr;
    const [k, dir] = Object.entries(ob)[0];
    return [...arr].sort((a, b) => {
      const av = a[k];
      const bv = b[k];
      return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === 'desc' ? -1 : 1);
    });
  }
  return {
    reservation: {
      // Applies the schema's column defaults. The mock previously did not, so a
      // freshly created reservation had status === undefined and could never be
      // confirmed — the confirm route requires PENDING.
      create: async ({ data }) => {
        const id = data.id || 'r' + memDb.reservation.size;
        const row = {
          id,
          status: 'PENDING',
          adults: 1,
          children: 0,
          source: 'DIRECT',
          createdAt: new Date(),
          ...data,
        };
        memDb.reservation.set(id, row);
        return row;
      },
      findUnique: async ({ where: { id }, include }) => {
        const row = memDb.reservation.get(id);
        if (!row) return null;
        if (include?.notes) {
          const notes = [...memDb.reservationNote.values()].filter((n) => n.reservationId === id);
          return { ...row, notes: applyOrderBy(notes, include.notes.orderBy) };
        }
        return row;
      },
      findMany: async ({ where, orderBy, take = 200 } = {}) =>
        applyOrderBy(
          [...memDb.reservation.values()].filter((row) => matchesWhere(row, where)),
          orderBy
        ).slice(0, take),
      update: async ({ where: { id }, data }) => {
        const row = { ...memDb.reservation.get(id), ...data };
        memDb.reservation.set(id, row);
        return row;
      },
    },
    reservationNote: {
      create: async ({ data }) => {
        const id = data.id || 'n' + memDb.reservationNote.size;
        const row = { id, ...data, createdAt: new Date() };
        memDb.reservationNote.set(id, row);
        return row;
      },
      findMany: async ({ where, orderBy }) =>
        applyOrderBy(
          [...memDb.reservationNote.values()].filter(
            (n) => !where || n.reservationId === where.reservationId
          ),
          orderBy
        ),
      update: async ({ where: { id }, data }) => {
        const row = { ...memDb.reservationNote.get(id), ...data };
        memDb.reservationNote.set(id, row);
        return row;
      },
    },
    reservationActivity: {
      create: async ({ data }) => {
        const id = 'a' + memDb.reservationActivity.size;
        const row = { id, ...data, createdAt: new Date() };
        memDb.reservationActivity.set(id, row);
        return row;
      },
      findMany: async ({ where, orderBy, take = 200 } = {}) =>
        applyOrderBy(
          [...memDb.reservationActivity.values()].filter(
            (a) => !where || a.reservationId === where.reservationId
          ),
          orderBy
        ).slice(0, take),
    },
    appSetting: {
      // POST /reservations always reads this to compute add-on totals; no
      // test in this file seeds it, so findUnique legitimately misses and the
      // route falls back to its own default (10%) — same as an empty prod DB
      // before the settings migration's seed row exists.
      findUnique: async ({ where: { key } }) => memDb.appSetting.get(key) || null,
      upsert: async ({ where: { key }, create, update }) => {
        const existing = memDb.appSetting.get(key);
        const row = existing ? { ...existing, ...update } : { ...create };
        memDb.appSetting.set(key, row);
        return row;
      },
    },
  };
}

// Override constructor returns
const Module = require('module');
const _resolve = Module._resolve;
require.cache[require.resolve.paths('@prisma/client')[0] + '/@prisma/client'] = {}; // best-effort
process.env.REDIS_URL = 'redis://does-not-matter:0';

// Stub the @prisma/client and ioredis modules in require cache
const prismaStub = {
  PrismaClient: function () {
    return makeMockPrisma();
  },
};
const redisStub = function () {
  return { publish: () => {}, on: () => {}, disconnect: () => {} };
};
require.cache[require.resolve('@prisma/client')] = { exports: prismaStub };
try {
  require.cache[require.resolve('ioredis')] = { exports: redisStub };
} catch {
  /* ioredis not present in test env */
}

// Stub the auth middleware so requireRole is permissive in tests
require.cache[require.resolve('../middleware/auth')] = {
  exports: {
    // Route declarations reference ROLE_GROUPS (see middleware/auth.js), so the
    // stub has to provide it or every guarded route throws at require time.
    ROLE_GROUPS: new Proxy({}, { get: () => ['ADMIN'] }),
    verifyToken: (req, _res, next) => {
      req.user = { sub: 'u1', username: 'tester', roles: ['ADMIN'] };
      next();
    },
    requireRole: () => (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    JWT_SECRET: 'test',
  },
};

// ── Stub the inventory client ────────────────────────────────────────────────
// Reservation creation now claims capacity from the inventory service BEFORE it
// inserts anything, so without this stub every test here would attempt a real
// HTTP call to inventory-service and fail.
//
// `inventoryStub.capacity` lets a test simulate a sold-out room type and assert
// the reservation is refused; `inventoryStub.calls` records the two-phase
// sequence so tests can verify a failed insert releases its hold.
const inventoryStub = {
  capacity: Infinity,
  held: 0,
  calls: [],
  // Ordered physical rooms inventory would offer for a type, lowest floor and
  // number first — what auto-assignment picks from.
  rooms: [],
  // Monotonic across the whole file. Deriving group ids from calls.length would
  // reissue 'g1' whenever a test clears calls[], making a re-hold look like it
  // had reused the original hold.
  seq: 0,
  reset() {
    this.capacity = Infinity;
    this.held = 0;
    this.calls = [];
    this.rooms = [];
  },
};

class StubNoInventoryError extends Error {
  constructor(detail = {}) {
    super('No inventory available for the requested dates.');
    this.name = 'NoInventoryError';
    this.statusCode = 409;
    this.detail = detail;
  }
}

require.cache[require.resolve('../lib/inventoryClient')] = {
  exports: {
    NoInventoryError: StubNoInventoryError,
    makeInventoryClient: () => ({
      acquireHold: async (args) => {
        inventoryStub.calls.push({ op: 'acquire', args });
        if (inventoryStub.held >= inventoryStub.capacity) {
          throw new StubNoInventoryError({ totalInventory: inventoryStub.capacity });
        }
        inventoryStub.held += 1;
        inventoryStub.seq += 1;
        return { groupId: `g${inventoryStub.seq}`, roomTypeCode: args.roomTypeCode };
      },
      attachHold: async (groupId, reservationId) => {
        inventoryStub.calls.push({ op: 'attach', groupId, reservationId });
        return { groupId, reservationId };
      },
      releaseHold: async (groupId) => {
        inventoryStub.calls.push({ op: 'release', groupId });
        inventoryStub.held = Math.max(0, inventoryStub.held - 1);
        return true;
      },
      commitHold: async (groupId) => ({ groupId }),
      getRoom: async (roomId) => inventoryStub.rooms.find((r) => r.id === roomId) || null,
      roomCandidates: async (args) => {
        inventoryStub.calls.push({ op: 'candidates', args });
        return inventoryStub.rooms.filter((r) => r.typeCode === args.roomTypeCode);
      },
    }),
  },
};

const router = require('./reservation.routes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

function call(app, method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            'Content-Type': 'application/json',
            ...(data && { 'Content-Length': Buffer.byteLength(data) }),
            ...headers,
          },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null });
          });
        }
      );
      req.on('error', () => {
        server.close();
        resolve({ status: 0 });
      });
      if (data) req.write(data);
      req.end();
    });
  });
}

const sample = {
  guestName: 'Maria Santos',
  guestEmail: 'maria@example.com',
  roomTypeCode: 'STD',
  checkIn: '2026-05-01',
  checkOut: '2026-05-03',
  adults: 2,
};

test('POST /api/reservations creates and returns a reservation with confirmationNumber', async () => {
  const app = makeApp();
  const res = await call(app, 'POST', '/api/reservations', sample);
  assert.strictEqual(res.status, 201);
  assert.ok(res.body.confirmationNumber.startsWith('R-'));
  assert.strictEqual(res.body.guestName, 'Maria Santos');
  assert.strictEqual(res.body.nights, 2);
});

test('POST /api/reservations rejects missing required fields', async () => {
  const app = makeApp();
  const res = await call(app, 'POST', '/api/reservations', { guestName: '' });
  assert.strictEqual(res.status, 400);
});

test('GET /api/reservations/:id returns 404 for unknown', async () => {
  const app = makeApp();
  const res = await call(app, 'GET', '/api/reservations/nope', null);
  assert.strictEqual(res.status, 404);
});

test('Confirm → Cancel flow produces a cancellationNumber and activity entries', async () => {
  const app = makeApp();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;
  const confirm = await call(app, 'POST', `/api/reservations/${id}/confirm`, {});
  assert.strictEqual(confirm.body.status, 'CONFIRMED');
  const cancel = await call(app, 'POST', `/api/reservations/${id}/cancel`, {
    reason: 'Guest request',
    cancellationFeeCents: 50000,
    note: 'No-fault cancel',
  });
  assert.strictEqual(cancel.body.status, 'CANCELLED');
  assert.ok(cancel.body.cancellationNumber.startsWith('C-'));
  const activity = await call(app, 'GET', `/api/reservations/${id}/activity`, null);
  assert.ok(Array.isArray(activity.body));
  assert.ok(activity.body.length >= 3, `expected ≥3 activity entries, got ${activity.body.length}`);
});

test('PATCH /api/reservations/:id updates dates and recomputes nights', async () => {
  const app = makeApp();
  inventoryStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;
  const patched = await call(app, 'PATCH', `/api/reservations/${id}`, { checkOut: '2026-05-05' });
  assert.strictEqual(patched.body.nights, 4);
});

// The reservation header shows Origin and Rate Plan(s), and Quick Edit offers
// both for editing. They are columns on the model but were missing from this
// route's whitelist, so the modal would have saved nothing and reported success.
test('PATCH /api/reservations/:id persists origin', async () => {
  const app = makeApp();
  inventoryStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const patched = await call(app, 'PATCH', `/api/reservations/${created.body.id}`, {
    origin: 'Booking.com',
  });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.body.origin, 'Booking.com');
});

test('PATCH /api/reservations/:id persists ratePlan', async () => {
  const app = makeApp();
  inventoryStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const patched = await call(app, 'PATCH', `/api/reservations/${created.body.id}`, {
    ratePlan: 'Corporate Rate',
  });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.body.ratePlan, 'Corporate Rate');
});

// ── Two-phase capacity claim ────────────────────────────────────────────────
// This route previously inserted a reservation with NO availability check at
// all. These tests pin the new contract: capacity is claimed BEFORE the insert,
// bound to the row after it, and handed back if anything fails.

test('creating a reservation claims capacity BEFORE inserting, then attaches the hold', async () => {
  const app = makeApp();
  inventoryStub.reset();

  const res = await call(app, 'POST', '/api/reservations', sample);
  assert.strictEqual(res.status, 201);

  // Asserted as an ORDERING, not as the exact call list: room auto-assignment
  // legitimately queries inventory between the two, and pinning the whole
  // sequence made this test fail for a change it was never about.
  const ops = inventoryStub.calls.map((c) => c.op);
  assert.ok(ops.includes('acquire'), 'capacity must be claimed');
  assert.ok(ops.includes('attach'), 'the hold must be bound to the new row');
  assert.ok(ops.indexOf('acquire') < ops.indexOf('attach'), 'expected acquire → attach, in that order');

  const acquire = inventoryStub.calls.find((c) => c.op === 'acquire');
  assert.strictEqual(acquire.args.roomTypeCode, 'STD');
  assert.strictEqual(acquire.args.checkIn, '2026-05-01');
  assert.strictEqual(acquire.args.checkOut, '2026-05-03');

  const attach = inventoryStub.calls.find((c) => c.op === 'attach');
  assert.strictEqual(attach.reservationId, res.body.id);
  assert.strictEqual(res.body.inventoryHoldGroupId, attach.groupId);
});

test('a sold-out room type is refused with 409 and NOTHING is written', async () => {
  const app = makeApp();
  inventoryStub.reset();
  inventoryStub.capacity = 1;

  const first = await call(app, 'POST', '/api/reservations', sample);
  assert.strictEqual(first.status, 201);

  const before = memDb.reservation.size;
  const second = await call(app, 'POST', '/api/reservations', sample);

  assert.strictEqual(second.status, 409, 'a booking with no capacity must be refused, not created');
  assert.strictEqual(memDb.reservation.size, before, 'a refused booking must not insert a reservation row');
});

test('an invalid date range is rejected before any capacity is claimed', async () => {
  const app = makeApp();
  inventoryStub.reset();

  const res = await call(app, 'POST', '/api/reservations', {
    ...sample,
    checkIn: '2026-05-05',
    checkOut: '2026-05-01',
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(
    inventoryStub.calls.length,
    0,
    'must not touch inventory for an obviously invalid request'
  );
});

test('changing dates re-holds the new range and releases the old one', async () => {
  const app = makeApp();
  inventoryStub.reset();

  const created = await call(app, 'POST', '/api/reservations', sample);
  const originalGroup = created.body.inventoryHoldGroupId;
  inventoryStub.calls = [];

  const patched = await call(app, 'PATCH', `/api/reservations/${created.body.id}`, {
    checkOut: '2026-05-06',
  });
  assert.strictEqual(patched.status, 200);

  const ops = inventoryStub.calls.map((c) => c.op);
  assert.deepStrictEqual(ops, ['acquire', 'attach', 'release'], 'expected claim-new → attach → release-old');
  assert.strictEqual(
    inventoryStub.calls.find((c) => c.op === 'release').groupId,
    originalGroup,
    'the ORIGINAL hold must be the one released'
  );
  assert.notStrictEqual(patched.body.inventoryHoldGroupId, originalGroup);
  assert.strictEqual(patched.body.nights, 5);
});

test('a date change with no availability leaves the booking untouched', async () => {
  const app = makeApp();
  inventoryStub.reset();
  inventoryStub.capacity = 1;

  const created = await call(app, 'POST', '/api/reservations', sample);
  const originalGroup = created.body.inventoryHoldGroupId;

  // The original booking still holds the only unit, so re-holding must fail.
  const patched = await call(app, 'PATCH', `/api/reservations/${created.body.id}`, {
    checkOut: '2026-05-06',
  });
  assert.strictEqual(patched.status, 409);

  const after = await call(app, 'GET', `/api/reservations/${created.body.id}`, null);
  assert.strictEqual(after.body.nights, 2, 'dates must be unchanged after a failed re-hold');
  assert.strictEqual(after.body.inventoryHoldGroupId, originalGroup, 'the original hold must be retained');
});

test('a non-date edit does not disturb the inventory hold', async () => {
  const app = makeApp();
  inventoryStub.reset();

  const created = await call(app, 'POST', '/api/reservations', sample);
  inventoryStub.calls = [];

  const patched = await call(app, 'PATCH', `/api/reservations/${created.body.id}`, {
    guestPhone: '+63 917 000 0000',
  });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(inventoryStub.calls.length, 0, 'editing a phone number must not re-hold inventory');
});

// ─────────────────────────────────────────────────────────────────────────────
// The calendar bug: a saved reservation that never showed up on the board.
//
// Two independent causes, each proven by the tests below:
//   1. GET /api/reservations?from&to filtered on checkIn ALONE, so any stay
//      that began before the window vanished from it — the longer the stay,
//      the more likely it was invisible.
//   2. Nothing ever set assignedRoomId, while the calendar is a rooms x nights
//      grid and can only draw a bar on a room row.
// ─────────────────────────────────────────────────────────────────────────────

function resetDb() {
  memDb.reservation.clear();
  memDb.reservationNote.clear();
  memDb.reservationActivity.clear();
  memDb.appSetting.clear();
  inventoryStub.reset();
}

// Insert straight into the store: these tests are about the READ path, and
// going through POST would drag capacity and assignment into the setup.
function seedReservation(row) {
  const id = row.id || `seed-${memDb.reservation.size}`;
  memDb.reservation.set(id, {
    id,
    confirmationNumber: `R-${id}`,
    status: 'CONFIRMED',
    guestName: 'Guest',
    roomTypeCode: 'STD',
    assignedRoomId: 'room-1',
    nights: 1,
    adults: 1,
    children: 0,
    totalEstimateCents: 0n,
    depositCents: 0n,
    ...row,
    checkIn: new Date(row.checkIn),
    checkOut: new Date(row.checkOut),
  });
  return id;
}

test('a stay that began before the window still appears in the window', async () => {
  resetDb();
  seedReservation({ id: 'long', guestName: 'Maria Santos', checkIn: '2026-09-01', checkOut: '2026-09-10' });
  const res = await call(makeApp(), 'GET', '/api/reservations?from=2026-09-05&to=2026-09-08', null);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(
    res.body.map((r) => r.id),
    ['long'],
    'a 9-night stay overlapping the window must be returned; filtering on checkIn alone drops it'
  );
});

test('a stay that runs past the end of the window still appears in it', async () => {
  resetDb();
  seedReservation({ id: 'tail', checkIn: '2026-09-07', checkOut: '2026-09-20' });
  const res = await call(makeApp(), 'GET', '/api/reservations?from=2026-09-05&to=2026-09-08', null);
  assert.deepStrictEqual(
    res.body.map((r) => r.id),
    ['tail']
  );
});

test('a stay entirely before the window is excluded', async () => {
  resetDb();
  seedReservation({ id: 'past', checkIn: '2026-08-01', checkOut: '2026-08-03' });
  const res = await call(makeApp(), 'GET', '/api/reservations?from=2026-09-05&to=2026-09-08', null);
  assert.deepStrictEqual(res.body, []);
});

test('a stay entirely after the window is excluded', async () => {
  resetDb();
  seedReservation({ id: 'future', checkIn: '2026-10-01', checkOut: '2026-10-03' });
  const res = await call(makeApp(), 'GET', '/api/reservations?from=2026-09-05&to=2026-09-08', null);
  assert.deepStrictEqual(res.body, []);
});

test("a stay checking out on the window's first day does not occupy it", async () => {
  // Hotel nights are half-open: departing on the 5th means the 5th is free.
  resetDb();
  seedReservation({ id: 'departs', checkIn: '2026-09-02', checkOut: '2026-09-05' });
  const res = await call(makeApp(), 'GET', '/api/reservations?from=2026-09-05&to=2026-09-08', null);
  assert.deepStrictEqual(res.body, []);
});

test("a stay checking in on the window's last day is included", async () => {
  resetDb();
  seedReservation({ id: 'arrives', checkIn: '2026-09-07', checkOut: '2026-09-09' });
  const res = await call(makeApp(), 'GET', '/api/reservations?from=2026-09-05&to=2026-09-08', null);
  assert.deepStrictEqual(
    res.body.map((r) => r.id),
    ['arrives']
  );
});

test("the night audit's open-ended `to` query still finds overdue arrivals", async () => {
  // services/audit calls this with `to` and no `from` to sweep for no-shows.
  // Changing what from/to mean must not break that caller.
  resetDb();
  seedReservation({ id: 'overdue', checkIn: '2026-09-01', checkOut: '2026-09-02' });
  seedReservation({ id: 'later', checkIn: '2026-09-20', checkOut: '2026-09-21' });
  const res = await call(
    makeApp(),
    'GET',
    `/api/reservations?status=CONFIRMED&to=${new Date('2026-09-03').toISOString()}`,
    null
  );
  assert.deepStrictEqual(
    res.body.map((r) => r.id),
    ['overdue']
  );
});

test('assignedRoomId narrows the list to that physical room', async () => {
  // web/src/pages/Housekeeping.jsx has always sent this filter; the route
  // ignored it and returned every reservation in the hotel, so "Inspect" could
  // open with a booking belonging to a different room.
  resetDb();
  seedReservation({
    id: 'in-201',
    assignedRoomId: 'room-201',
    checkIn: '2026-09-05',
    checkOut: '2026-09-06',
  });
  seedReservation({
    id: 'in-202',
    assignedRoomId: 'room-202',
    checkIn: '2026-09-05',
    checkOut: '2026-09-06',
  });
  const res = await call(makeApp(), 'GET', '/api/reservations?assignedRoomId=room-202', null);
  assert.deepStrictEqual(
    res.body.map((r) => r.id),
    ['in-202']
  );
});

test('a new reservation is given a physical room so the calendar can draw it', async () => {
  resetDb();
  inventoryStub.rooms = [{ id: 'room-201', number: '201', typeCode: 'STD', floor: 2 }];
  const res = await call(makeApp(), 'POST', '/api/reservations', sample);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.assignedRoomId, 'room-201');
});

test('an explicitly chosen room is never overridden by auto-assignment', async () => {
  resetDb();
  inventoryStub.rooms = [
    { id: 'room-201', number: '201', typeCode: 'STD', floor: 2 },
    { id: 'room-305', number: '305', typeCode: 'STD', floor: 3 },
  ];
  const res = await call(makeApp(), 'POST', '/api/reservations', {
    ...sample,
    assignedRoomId: 'room-305',
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.assignedRoomId, 'room-305');
});

test('auto-assignment skips a room already promised for overlapping nights', async () => {
  resetDb();
  inventoryStub.rooms = [
    { id: 'room-201', number: '201', typeCode: 'STD', floor: 2 },
    { id: 'room-202', number: '202', typeCode: 'STD', floor: 2 },
  ];
  seedReservation({
    id: 'sitting',
    assignedRoomId: 'room-201',
    checkIn: '2026-05-02',
    checkOut: '2026-05-04',
  });
  // sample runs 2026-05-01 → 2026-05-03, which overlaps the night of the 2nd.
  const res = await call(makeApp(), 'POST', '/api/reservations', sample);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.assignedRoomId, 'room-202');
});

test('a cancelled booking does not keep its room out of auto-assignment', async () => {
  resetDb();
  inventoryStub.rooms = [{ id: 'room-201', number: '201', typeCode: 'STD', floor: 2 }];
  seedReservation({
    id: 'dead',
    status: 'CANCELLED',
    assignedRoomId: 'room-201',
    checkIn: '2026-05-01',
    checkOut: '2026-05-03',
  });
  const res = await call(makeApp(), 'POST', '/api/reservations', sample);
  assert.strictEqual(res.body.assignedRoomId, 'room-201');
});

test('a booking still succeeds when no physical room can be assigned', async () => {
  // Capacity said yes, so refusing the guest would be wrong. The booking is
  // taken with no room and the front desk assigns one later.
  resetDb();
  inventoryStub.rooms = [];
  const res = await call(makeApp(), 'POST', '/api/reservations', sample);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.assignedRoomId, null);
});

test('an empty-string room id is stored as null, not as a phantom room', async () => {
  // '' is NOT NULL as far as the Reservation_no_double_booking exclusion
  // constraint is concerned, so two unassigned bookings on overlapping dates
  // collided on the phantom room '' and the second was refused with
  // "that room is already booked".
  resetDb();
  inventoryStub.rooms = [];
  const res = await call(makeApp(), 'POST', '/api/reservations', { ...sample, assignedRoomId: '' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.assignedRoomId, null);
});

test('PATCH clearing the room stores null, not an empty string', async () => {
  resetDb();
  inventoryStub.rooms = [{ id: 'room-201', number: '201', typeCode: 'STD', floor: 2 }];
  const created = await call(makeApp(), 'POST', '/api/reservations', sample);
  const res = await call(makeApp(), 'PATCH', `/api/reservations/${created.body.id}`, {
    assignedRoomId: '',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.assignedRoomId, null);
});
