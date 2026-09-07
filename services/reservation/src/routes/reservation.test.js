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
  reservationCard: new Map(),
  reservationDocument: new Map(),
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
    reservationCard: {
      create: async ({ data }) => {
        const id = data.id || 'card' + memDb.reservationCard.size;
        const row = { id, ...data, createdAt: new Date() };
        memDb.reservationCard.set(id, row);
        return row;
      },
      findMany: async ({ where, orderBy }) =>
        applyOrderBy(
          [...memDb.reservationCard.values()].filter(
            (c) => !where || c.reservationId === where.reservationId
          ),
          orderBy
        ),
      // deleteMany, not delete: a delete keyed only on {id} would remove a card
      // through ANY reservation's URL, the same cross-tenant hole ReservationNote's
      // archive route guards against by scoping its update the same way.
      deleteMany: async ({ where }) => {
        const doomed = [...memDb.reservationCard.values()].filter((c) => matchesWhere(c, where));
        for (const c of doomed) memDb.reservationCard.delete(c.id);
        return { count: doomed.length };
      },
    },
    reservationDocument: {
      create: async ({ data }) => {
        const id = data.id || 'doc' + memDb.reservationDocument.size;
        const row = { id, ...data, uploadedAt: new Date() };
        memDb.reservationDocument.set(id, row);
        return row;
      },
      findMany: async ({ where, orderBy }) =>
        applyOrderBy(
          [...memDb.reservationDocument.values()].filter(
            (d) => !where || d.reservationId === where.reservationId
          ),
          orderBy
        ),
      findFirst: async ({ where }) =>
        [...memDb.reservationDocument.values()].find((d) => matchesWhere(d, where)) || null,
      deleteMany: async ({ where }) => {
        const doomed = [...memDb.reservationDocument.values()].filter((d) => matchesWhere(d, where));
        for (const d of doomed) memDb.reservationDocument.delete(d.id);
        return { count: doomed.length };
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

// ── Stub the notifier ────────────────────────────────────────────────────────
// Recording rather than a no-op: the "Send Confirmation Email" route's whole
// job is choosing whether to call this and with what, so a test that cannot
// see the call cannot tell a working route from one that silently does nothing.
const notifierStub = {
  sent: [],
  reset() {
    this.sent = [];
  },
};
require.cache[require.resolve('../lib/notifier')] = {
  exports: {
    send: async (msg) => {
      notifierStub.sent.push(msg);
      return { ok: true };
    },
    TEMPLATES: require('../lib/notifier').TEMPLATES,
  },
};

// ── Stub object storage ──────────────────────────────────────────────────────
// Records what was actually stored, keyed the same way the real MinIO client
// is — so a test can tell "the route uploaded the right bytes" from "the route
// silently no-oped", which a bare no-op stub could not.
const storageStub = {
  objects: new Map(),
  reset() {
    this.objects.clear();
  },
};
require.cache[require.resolve('../lib/storage')] = {
  exports: {
    ensureBucket: async () => {},
    objectKeyFor: (reservationId, filename) => `reservations/${reservationId}/${Date.now()}-${filename}`,
    putDocument: async (key, buf, contentType) => {
      storageStub.objects.set(key, { buf, contentType });
    },
    getDocumentStream: async (key) => {
      if (!storageStub.objects.has(key)) throw new Error('object not found');
      const { Readable } = require('node:stream');
      return Readable.from(storageStub.objects.get(key).buf);
    },
    removeDocument: async (key) => {
      storageStub.objects.delete(key);
    },
  },
};

const router = require('./reservation.routes');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
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

// Like `call`, but keeps the response as raw bytes instead of JSON.parse-ing
// it — needed for the document-download route, which streams a file body.
function callRaw(app, method, path) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, method, path },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) });
          });
        }
      );
      req.on('error', () => {
        server.close();
        resolve({ status: 0, buf: Buffer.alloc(0) });
      });
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

// ── Service times on the stored window ──────────────────────────────────────
// Reservation.checkIn/checkOut have always been timestamps compared as a range
// by Reservation_no_double_booking, but every row stored midnight, so the times
// carried no information. They now carry the property's service times. These
// tests pin the two properties that matter: the clock goes on, and the billed
// night count does NOT move because of it.
//
// No folio service is running under test, so serviceTimes() falls back to the
// shipped 14:00/12:00 defaults — which is itself the behaviour to guarantee.
test('a new booking stores the property check-in and check-out times', async () => {
  const app = makeApp();
  inventoryStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  assert.strictEqual(created.status, 201);
  assert.strictEqual(new Date(created.body.checkIn).toISOString(), '2026-05-01T14:00:00.000Z');
  assert.strictEqual(new Date(created.body.checkOut).toISOString(), '2026-05-03T12:00:00.000Z');
});

test('stamping the times does not change the billed nights', async () => {
  const app = makeApp();
  inventoryStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  // 1 May to 3 May is two nights whatever the clock says.
  assert.strictEqual(created.body.nights, 2);
});

test('a patched checkout is stamped too, so windows stay comparable', async () => {
  const app = makeApp();
  inventoryStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const patched = await call(app, 'PATCH', `/api/reservations/${created.body.id}`, {
    checkOut: '2026-05-05',
  });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(new Date(patched.body.checkOut).toISOString(), '2026-05-05T12:00:00.000Z');
  assert.strictEqual(patched.body.nights, 4);
});

// The reason the whole change is safe: a room vacated at noon and re-let at 2pm
// on the same date is a clean handover, not a double booking.
test('back-to-back bookings in the same room do not collide', async () => {
  const app = makeApp();
  inventoryStub.reset();
  const first = await call(app, 'POST', '/api/reservations', {
    ...sample,
    assignedRoomId: 'room-1',
    checkIn: '2026-06-01',
    checkOut: '2026-06-02',
  });
  assert.strictEqual(first.status, 201);
  const second = await call(app, 'POST', '/api/reservations', {
    ...sample,
    assignedRoomId: 'room-1',
    checkIn: '2026-06-02',
    checkOut: '2026-06-03',
  });
  assert.strictEqual(second.status, 201, `same-day turnover must be allowed: ${second.body?.error || ''}`);
  assert.ok(new Date(first.body.checkOut) <= new Date(second.body.checkIn));
});

// ── POST /api/reservations/:id/send-confirmation-email ──────────────────────

test('sends the confirmation email for a confirmed reservation', async () => {
  const app = makeApp();
  notifierStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;
  await call(app, 'POST', `/api/reservations/${id}/confirm`, {});

  const r = await call(app, 'POST', `/api/reservations/${id}/send-confirmation-email`, {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(notifierStub.sent.length, 1);
  assert.strictEqual(notifierStub.sent[0].to, sample.guestEmail);
  assert.match(notifierStub.sent[0].subject, /confirmed/i);
  assert.match(notifierStub.sent[0].body, new RegExp(created.body.confirmationNumber));
});

test('refuses a reservation with no guest email on file', async () => {
  const app = makeApp();
  notifierStub.reset();
  const created = await call(app, 'POST', '/api/reservations', { ...sample, guestEmail: '' });
  const id = created.body.id;
  await call(app, 'POST', `/api/reservations/${id}/confirm`, {});

  const r = await call(app, 'POST', `/api/reservations/${id}/send-confirmation-email`, {});
  assert.strictEqual(r.status, 400);
  assert.strictEqual(notifierStub.sent.length, 0);
});

test('refuses a still-pending reservation, since it is not actually confirmed', async () => {
  const app = makeApp();
  notifierStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;

  const r = await call(app, 'POST', `/api/reservations/${id}/send-confirmation-email`, {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(notifierStub.sent.length, 0);
});

test('refuses a cancelled reservation', async () => {
  const app = makeApp();
  notifierStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;
  await call(app, 'POST', `/api/reservations/${id}/confirm`, {});
  await call(app, 'POST', `/api/reservations/${id}/cancel`, { reason: 'Guest request' });

  const r = await call(app, 'POST', `/api/reservations/${id}/send-confirmation-email`, {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(notifierStub.sent.length, 0);
});

test('a missing reservation is a 404', async () => {
  const app = makeApp();
  const r = await call(app, 'POST', '/api/reservations/nope/send-confirmation-email', {});
  assert.strictEqual(r.status, 404);
});

// ── Reservation cards (guarantee on file, never a real card number) ─────────

test('adds a card on file and lists it back', async () => {
  const app = makeApp();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;

  const add = await call(app, 'POST', `/api/reservations/${id}/cards`, {
    brand: 'VISA',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    cardholderName: 'Maria Santos',
  });
  assert.strictEqual(add.status, 201);
  assert.strictEqual(add.body.last4, '4242');
  assert.strictEqual(add.body.number, undefined, 'no field should ever carry a full card number');

  const list = await call(app, 'GET', `/api/reservations/${id}/cards`, null);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.length, 1);
});

test('rejects a last4 that is not exactly four digits', async () => {
  const app = makeApp();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;
  const r = await call(app, 'POST', `/api/reservations/${id}/cards`, {
    brand: 'VISA',
    last4: '42',
    expMonth: 12,
    expYear: 2030,
    cardholderName: 'Maria Santos',
  });
  assert.strictEqual(r.status, 400);
});

test('rejects an already-expired card', async () => {
  const app = makeApp();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;
  const r = await call(app, 'POST', `/api/reservations/${id}/cards`, {
    brand: 'VISA',
    last4: '4242',
    expMonth: 1,
    expYear: 2000,
    cardholderName: 'Maria Santos',
  });
  assert.strictEqual(r.status, 400);
});

test('removes a card on file', async () => {
  const app = makeApp();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;
  const add = await call(app, 'POST', `/api/reservations/${id}/cards`, {
    brand: 'VISA',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    cardholderName: 'Maria Santos',
  });
  const del = await call(app, 'DELETE', `/api/reservations/${id}/cards/${add.body.id}`, null);
  assert.strictEqual(del.status, 204);
  const list = await call(app, 'GET', `/api/reservations/${id}/cards`, null);
  assert.strictEqual(list.body.length, 0);
});

test('cannot remove a card through a different reservation', async () => {
  const app = makeApp();
  const r1 = await call(app, 'POST', '/api/reservations', sample);
  const r2 = await call(app, 'POST', '/api/reservations', sample);
  const add = await call(app, 'POST', `/api/reservations/${r1.body.id}/cards`, {
    brand: 'VISA',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    cardholderName: 'Maria Santos',
  });
  const del = await call(app, 'DELETE', `/api/reservations/${r2.body.id}/cards/${add.body.id}`, null);
  assert.strictEqual(del.status, 404);
});

// ── Documents (metadata in Postgres, bytes in MinIO) ─────────────────────────

test('uploads a document and lists it back', async () => {
  const app = makeApp();
  storageStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;

  const contentBase64 = Buffer.from('a scanned ID, in spirit').toString('base64');
  const up = await call(app, 'POST', `/api/reservations/${id}/documents`, {
    filename: 'guest-id.pdf',
    contentType: 'application/pdf',
    contentBase64,
  });
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.body.filename, 'guest-id.pdf');
  assert.strictEqual(up.body.sizeBytes, Buffer.from(contentBase64, 'base64').length);
  assert.strictEqual(storageStub.objects.size, 1, 'the bytes should actually be stored');

  const list = await call(app, 'GET', `/api/reservations/${id}/documents`, null);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.length, 1);
});

test('rejects an upload with no filename', async () => {
  const app = makeApp();
  storageStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const r = await call(app, 'POST', `/api/reservations/${created.body.id}/documents`, {
    contentType: 'application/pdf',
    contentBase64: Buffer.from('x').toString('base64'),
  });
  assert.strictEqual(r.status, 400);
});

test('rejects a file over the size limit', async () => {
  const app = makeApp();
  storageStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const big = Buffer.alloc(11 * 1024 * 1024, 'x').toString('base64'); // 11MB > 10MB limit
  const r = await call(app, 'POST', `/api/reservations/${created.body.id}/documents`, {
    filename: 'huge.bin',
    contentType: 'application/octet-stream',
    contentBase64: big,
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(storageStub.objects.size, 0, 'an oversized file must never reach storage');
});

test('downloads a document with the original bytes and filename', async () => {
  const app = makeApp();
  storageStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;
  const original = 'a scanned ID, in spirit';
  const up = await call(app, 'POST', `/api/reservations/${id}/documents`, {
    filename: 'guest-id.pdf',
    contentType: 'application/pdf',
    contentBase64: Buffer.from(original).toString('base64'),
  });

  const dl = await callRaw(app, 'GET', `/api/reservations/${id}/documents/${up.body.id}/download`);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.buf.toString('utf8'), original);
  assert.match(dl.headers['content-disposition'], /guest-id\.pdf/);
});

test('removes a document from both the database and storage', async () => {
  const app = makeApp();
  storageStub.reset();
  const created = await call(app, 'POST', '/api/reservations', sample);
  const id = created.body.id;
  const up = await call(app, 'POST', `/api/reservations/${id}/documents`, {
    filename: 'guest-id.pdf',
    contentType: 'application/pdf',
    contentBase64: Buffer.from('x').toString('base64'),
  });

  const del = await call(app, 'DELETE', `/api/reservations/${id}/documents/${up.body.id}`, null);
  assert.strictEqual(del.status, 204);
  assert.strictEqual(storageStub.objects.size, 0, 'storage must be cleaned up too, not just the row');

  const list = await call(app, 'GET', `/api/reservations/${id}/documents`, null);
  assert.strictEqual(list.body.length, 0);
});

test('cannot download or remove a document through a different reservation', async () => {
  const app = makeApp();
  storageStub.reset();
  const r1 = await call(app, 'POST', '/api/reservations', sample);
  const r2 = await call(app, 'POST', '/api/reservations', sample);
  const up = await call(app, 'POST', `/api/reservations/${r1.body.id}/documents`, {
    filename: 'guest-id.pdf',
    contentType: 'application/pdf',
    contentBase64: Buffer.from('x').toString('base64'),
  });

  const dl = await callRaw(app, 'GET', `/api/reservations/${r2.body.id}/documents/${up.body.id}/download`);
  assert.strictEqual(dl.status, 404);

  const del = await call(app, 'DELETE', `/api/reservations/${r2.body.id}/documents/${up.body.id}`, null);
  assert.strictEqual(del.status, 404);
});
