// Tests for server-side room-assignment validation.
//
// Before Phase 1, POST /api/walk-in was a bare prisma.stay.create() that trusted
// whatever assignedRoomId the browser sent. WalkIn.jsx computed availability
// client-side from a list it had fetched earlier, so two clerks working from
// lists fetched seconds apart were shown the same "free" room and both succeeded.
// POST /api/check-in had the same hole: it validated the STAY's status but never
// checked whether the ROOM was already occupied by a different stay.
//
//   node --test src/routes/roomAssignment.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// ── In-memory stay store ────────────────────────────────────────────────────

const memDb = { stay: new Map(), checkInTask: new Map() };
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
      const row = { id, status: 'PRE_ARRIVAL', keyCardsIssued: 0, depositAmount: 0, ...data };
      memDb.stay.set(id, row);
      return row;
    },
    update: async ({ where: { id }, data }) => {
      const row = { ...memDb.stay.get(id), ...data };
      memDb.stay.set(id, row);
      return row;
    },
    findUnique: async ({ where: { id } }) => memDb.stay.get(id) || null,
    findFirst: async ({ where }) => [...memDb.stay.values()].find((r) => matches(r, where)) || null,
    findMany: async ({ where } = {}) => [...memDb.stay.values()].filter((r) => matches(r, where || {})),
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

// stay.routes.js requires pdfkit at module scope for the registration-card PDF.
// None of these tests touch that route, and pdfkit is a heavyweight native-ish
// dependency, so it is intercepted at the loader rather than installed.
// require.cache cannot be used here: require.resolve() throws when the module is
// genuinely absent from the test environment.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pdfkit') {
    return function PDFDocumentStub() {
      return {
        pipe() {},
        fontSize() {
          return this;
        },
        text() {
          return this;
        },
        moveDown() {
          return this;
        },
        end() {},
      };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// The room catalogue the stubbed inventory service will answer from.
const rooms = new Map();
let inventoryReachable = true;

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
    // Route declarations reference ROLE_GROUPS (see middleware/auth.js), so the
    // stub has to provide it or every guarded route throws at require time.
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
require.cache[require.resolve('../lib/inventoryClient')] = {
  exports: {
    NoInventoryError: class extends Error {},
    makeInventoryClient: () => ({
      getRoom: async (id) => {
        if (!inventoryReachable) throw new Error('ECONNREFUSED');
        return rooms.get(id) || null;
      },
      listRooms: async () => {
        if (!inventoryReachable) throw new Error('ECONNREFUSED');
        return [...rooms.values()];
      },
      acquireHold: async () => ({ groupId: 'g1' }),
      attachHold: async () => ({}),
      releaseHold: async () => true,
      commitHold: async () => ({}),
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
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            'Content-Type': 'application/json',
            ...(data && { 'Content-Length': Buffer.byteLength(data) }),
          },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c;
          });
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

function reset() {
  memDb.stay.clear();
  rooms.clear();
  inventoryReachable = true;
  rooms.set('room-101', { id: 'room-101', number: '101', floor: 1, status: 'CLEAN', typeCode: 'STD' });
  rooms.set('room-102', { id: 'room-102', number: '102', floor: 1, status: 'CLEAN_INSPECTED', typeCode: 'STD' });
  rooms.set('room-dirty', { id: 'room-dirty', number: '103', floor: 1, status: 'DIRTY', typeCode: 'STD' });
  rooms.set('room-ooo', { id: 'room-ooo', number: '104', floor: 1, status: 'OUT_OF_ORDER', typeCode: 'STD' });
  rooms.set('room-oos', { id: 'room-oos', number: '105', floor: 1, status: 'OUT_OF_SERVICE', typeCode: 'STD' });
}

// ── Walk-in ─────────────────────────────────────────────────────────────────

test('a walk-in into a clean, empty room succeeds', async () => {
  reset();
  const res = await call(makeApp(), 'POST', '/api/walk-in', {
    guestName: 'Ana Cruz',
    assignedRoomId: 'room-101',
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.status, 'IN_HOUSE');
});

test('a walk-in into an ALREADY OCCUPIED room is refused', async () => {
  reset();
  const app = makeApp();
  assert.strictEqual(
    (await call(app, 'POST', '/api/walk-in', { guestName: 'Ana Cruz', assignedRoomId: 'room-101' })).status,
    201
  );

  const second = await call(app, 'POST', '/api/walk-in', {
    guestName: 'Ben Reyes',
    assignedRoomId: 'room-101',
  });
  assert.strictEqual(second.status, 409, 'the core bug: two guests could be walked into one room');
  assert.match(second.body.error, /already occupied/i);
  assert.strictEqual(memDb.stay.size, 1, 'the refused walk-in must not create a stay');
});

test('a walk-in into a DIRTY room is refused', async () => {
  reset();
  const res = await call(makeApp(), 'POST', '/api/walk-in', {
    guestName: 'Ana Cruz',
    assignedRoomId: 'room-dirty',
  });
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /dirty/i);
});

test('a walk-in into an out-of-order or out-of-service room is refused', async () => {
  reset();
  const app = makeApp();
  assert.strictEqual(
    (await call(app, 'POST', '/api/walk-in', { guestName: 'A', assignedRoomId: 'room-ooo' })).status,
    409
  );
  assert.strictEqual(
    (await call(app, 'POST', '/api/walk-in', { guestName: 'B', assignedRoomId: 'room-oos' })).status,
    409
  );
});

test('a walk-in into a room that does not exist is refused', async () => {
  reset();
  const res = await call(makeApp(), 'POST', '/api/walk-in', {
    guestName: 'Ana Cruz',
    assignedRoomId: 'room-does-not-exist',
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /does not exist/i);
});

test('a walk-in with no room chosen auto-assigns the first clean room', async () => {
  reset();
  const res = await call(makeApp(), 'POST', '/api/walk-in', { guestName: 'Ana Cruz' });
  assert.strictEqual(res.status, 201);
  // Lowest floor, then lowest number — same order the picker's own dropdown
  // lists, so what got assigned is the room a human would have picked first.
  assert.strictEqual(res.body.assignedRoomId, 'room-101');
});

test('auto-assign skips a room another walk-in already occupies', async () => {
  reset();
  const app = makeApp();
  assert.strictEqual(
    (await call(app, 'POST', '/api/walk-in', { guestName: 'Ana Cruz', assignedRoomId: 'room-101' })).status,
    201
  );
  const second = await call(app, 'POST', '/api/walk-in', { guestName: 'Ben Reyes' });
  assert.strictEqual(second.status, 201);
  assert.strictEqual(second.body.assignedRoomId, 'room-102');
});

test('auto-assign is refused when nothing is clean and vacant', async () => {
  reset();
  rooms.delete('room-101');
  rooms.delete('room-102');
  const res = await call(makeApp(), 'POST', '/api/walk-in', { guestName: 'Ana Cruz' });
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /no clean, vacant rooms/i);
});

test('a walk-in with no guest name is refused', async () => {
  reset();
  assert.strictEqual(
    (await call(makeApp(), 'POST', '/api/walk-in', { assignedRoomId: 'room-101' })).status,
    400
  );
});

test('a room freed by checkout can be reused', async () => {
  reset();
  const app = makeApp();
  const first = await call(app, 'POST', '/api/walk-in', {
    guestName: 'Ana Cruz',
    assignedRoomId: 'room-101',
  });

  memDb.stay.get(first.body.id).status = 'DEPARTED';

  const second = await call(app, 'POST', '/api/walk-in', {
    guestName: 'Ben Reyes',
    assignedRoomId: 'room-101',
  });
  assert.strictEqual(second.status, 201, 'a departed stay must not block the room forever');
});

test('when inventory is unreachable the walk-in FAILS CLOSED', async () => {
  reset();
  inventoryReachable = false;

  const res = await call(makeApp(), 'POST', '/api/walk-in', {
    guestName: 'Ana Cruz',
    assignedRoomId: 'room-101',
  });
  assert.strictEqual(res.status, 502, 'an unverifiable room must not be sold');
  assert.strictEqual(memDb.stay.size, 0);
});

// ── Check-in ────────────────────────────────────────────────────────────────

test('check-in into an occupied room is refused', async () => {
  reset();
  const app = makeApp();
  await call(app, 'POST', '/api/walk-in', { guestName: 'Ana Cruz', assignedRoomId: 'room-101' });

  const res = await call(app, 'POST', '/api/check-in', {
    reservationId: 'res-1',
    guestName: 'Ben Reyes',
    assignedRoomId: 'room-101',
  });
  assert.strictEqual(res.status, 409, 'check-in never checked whether the room was already occupied');
});

test('check-in into a dirty room is refused', async () => {
  reset();
  const res = await call(makeApp(), 'POST', '/api/check-in', {
    reservationId: 'res-1',
    guestName: 'Ana Cruz',
    assignedRoomId: 'room-dirty',
  });
  assert.strictEqual(res.status, 409);
});

test('check-in into a clean room succeeds', async () => {
  reset();
  const res = await call(makeApp(), 'POST', '/api/check-in', {
    reservationId: 'res-1',
    guestName: 'Ana Cruz',
    assignedRoomId: 'room-102',
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.status, 'IN_HOUSE');
});

test('re-checking-in the same reservation does not clash with itself', async () => {
  // The stay being updated must be excluded from the occupancy check, otherwise
  // it would collide with its own row.
  reset();
  const app = makeApp();
  const created = await call(app, 'POST', '/api/check-in', {
    reservationId: 'res-1',
    guestName: 'Ana Cruz',
    assignedRoomId: 'room-101',
  });
  assert.strictEqual(created.status, 201);

  const again = await call(app, 'POST', '/api/check-in', {
    reservationId: 'res-1',
    guestName: 'Ana Cruz',
    assignedRoomId: 'room-101',
  });
  assert.strictEqual(again.status, 409);
  assert.match(again.body.error, /already checked in/i, 'should fail on stay status, not room occupancy');
});

// ── Room change ─────────────────────────────────────────────────────────────

test('moving a guest into an occupied room is refused', async () => {
  reset();
  const app = makeApp();
  const a = await call(app, 'POST', '/api/walk-in', { guestName: 'Ana Cruz', assignedRoomId: 'room-101' });
  await call(app, 'POST', '/api/walk-in', { guestName: 'Ben Reyes', assignedRoomId: 'room-102' });

  const res = await call(app, 'POST', `/api/stays/${a.body.id}/room-change`, { newRoomId: 'room-102' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(
    memDb.stay.get(a.body.id).assignedRoomId,
    'room-101',
    'a refused move must not change the room'
  );
});

test('moving a guest into a clean empty room succeeds', async () => {
  reset();
  const app = makeApp();
  const a = await call(app, 'POST', '/api/walk-in', { guestName: 'Ana Cruz', assignedRoomId: 'room-101' });

  const res = await call(app, 'POST', `/api/stays/${a.body.id}/room-change`, { newRoomId: 'room-102' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.assignedRoomId, 'room-102');
});

test('moving a guest into their own current room is allowed (no self-clash)', async () => {
  reset();
  const app = makeApp();
  const a = await call(app, 'POST', '/api/walk-in', { guestName: 'Ana Cruz', assignedRoomId: 'room-101' });

  const res = await call(app, 'POST', `/api/stays/${a.body.id}/room-change`, { newRoomId: 'room-101' });
  assert.strictEqual(res.status, 200, 'a stay must not be treated as its own blocker');
});

test('a stay that is not in-house cannot be moved', async () => {
  reset();
  const app = makeApp();
  const a = await call(app, 'POST', '/api/walk-in', { guestName: 'Ana Cruz', assignedRoomId: 'room-101' });
  memDb.stay.get(a.body.id).status = 'DEPARTED';

  const res = await call(app, 'POST', `/api/stays/${a.body.id}/room-change`, { newRoomId: 'room-102' });
  assert.strictEqual(res.status, 409);
});

test('moving an unknown stay is a 404', async () => {
  reset();
  const res = await call(makeApp(), 'POST', '/api/stays/nope/room-change', { newRoomId: 'room-102' });
  assert.strictEqual(res.status, 404);
});
