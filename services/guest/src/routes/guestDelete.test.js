// Route-level tests for DELETE /api/guests/:id.
//
// THE BUG THIS FILE EXISTS FOR
// -----------------------------
// The service-to-service calls this route makes to stay-service and
// reservation-service (to refuse deleting a guest who is checked in, or who
// holds an active reservation) used to mint a machine token with an EMPTY
// roles array, while both routes on the other side require
// requireRole(...DESK_AUDIT). `[].some(...)` is always false, so every call
// was rejected with 403 regardless of the guest's actual status, and the
// route's fail-closed handling turned that into "cannot confirm whether this
// guest is checked in right now" for EVERY delete, always — not just one
// with an actual conflict. The regression guard below asserts directly on
// the roles a fresh guest.routes.js configures its callers with, since that
// is exactly the value that silently regressed last time.
//
//   node --test src/routes/guestDelete.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// ── In-memory guest store ───────────────────────────────────────────────────

const memDb = { guest: new Map() };

const mockPrisma = {
  guest: {
    findUnique: async ({ where: { id } }) => memDb.guest.get(id) || null,
    delete: async ({ where: { id } }) => {
      const row = memDb.guest.get(id);
      memDb.guest.delete(id);
      return row;
    },
  },
  guestContact: { deleteMany: async () => ({ count: 0 }) },
  guestPreference: { deleteMany: async () => ({ count: 0 }) },
  consentRecord: { deleteMany: async () => ({ count: 0 }) },
  loyaltyAccount: { deleteMany: async () => ({ count: 0 }) },
  guestBankAccount: { deleteMany: async () => ({ count: 0 }) },
  $transaction: async (fn) => fn(mockPrisma),
};

// ── Stubs, installed before the route module loads ──────────────────────────

// Captures the config every makeServiceCaller() call was built with — this is
// what lets a test assert directly that `roles` is non-empty, which is the
// exact thing that regressed. `stayCall` is built first, `reservationCall`
// second (see guest.routes.js's require order), and each test controls what
// its `call()` returns independently via stayResponse/reservationResponse.
const capturedConfigs = [];
let stayResponse = [];
let reservationResponse = [];
let stayShouldThrow = false;
let reservationShouldThrow = false;

require.cache[require.resolve('../lib/serviceCall')] = {
  exports: {
    makeServiceCaller: (cfg) => {
      capturedConfigs.push(cfg);
      const isReservationCaller = capturedConfigs.length === 2;
      return {
        call: async () => {
          if (isReservationCaller) {
            if (reservationShouldThrow) throw new Error('reservation-service unreachable');
            return reservationResponse;
          }
          if (stayShouldThrow) throw new Error('stay-service unreachable');
          return stayResponse;
        },
      };
    },
    ServiceCallError: class extends Error {},
  },
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
    requireRole: () => (req, _res, next) => {
      req.user = { sub: 'u1', username: 'tester', roles: ['ADMIN'] };
      next();
    },
    requirePermission: () => (_req, _res, next) => next(),
  },
};

const router = require('./guest.routes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

function call(method, path) {
  return new Promise((resolve) => {
    const server = makeApp().listen(0, () => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, method, path },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null });
          });
        }
      );
      req.end();
    });
  });
}

function seedGuest(overrides = {}) {
  memDb.guest.clear();
  const guest = {
    id: 'g1',
    profileNumber: 'G-1',
    firstName: 'Ana',
    lastName: 'Cruz',
    displayName: 'Ana Cruz',
    ...overrides,
  };
  memDb.guest.set(guest.id, guest);
  stayResponse = [];
  reservationResponse = [];
  stayShouldThrow = false;
  reservationShouldThrow = false;
  return guest;
}

// ── The regression guard ─────────────────────────────────────────────────────

test('both service callers are configured with a non-empty role', () => {
  // The exact bug: `makeServiceCaller({ roles: [] })` — a caller with no
  // roles is rejected by every requireRole-guarded route on the other side,
  // regardless of what it's asking. Both must claim at least one role.
  assert.strictEqual(capturedConfigs.length, 2, 'expected exactly two service callers (stay, reservation)');
  for (const cfg of capturedConfigs) {
    assert.ok(Array.isArray(cfg.roles) && cfg.roles.length > 0, `roles must not be empty: got ${JSON.stringify(cfg.roles)}`);
  }
});

// ── The route itself ─────────────────────────────────────────────────────────

test('a guest with no stay and no active reservation is deleted', async () => {
  seedGuest();
  const res = await call('DELETE', '/api/guests/g1');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.deleted, true);
  assert.strictEqual(memDb.guest.has('g1'), false);
});

test('a guest currently checked in is refused', async () => {
  seedGuest();
  stayResponse = [{ id: 's1', guestId: 'g1', status: 'IN_HOUSE' }];
  const res = await call('DELETE', '/api/guests/g1');
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /currently checked in/i);
  assert.strictEqual(memDb.guest.has('g1'), true, 'a refused delete must not remove the guest');
});

test('a departed stay does not block the delete', async () => {
  seedGuest();
  stayResponse = [{ id: 's1', guestId: 'g1', status: 'DEPARTED' }];
  const res = await call('DELETE', '/api/guests/g1');
  assert.strictEqual(res.status, 200);
});

test('a guest with a confirmed reservation is refused', async () => {
  seedGuest();
  reservationResponse = [{ id: 'r1', guestId: 'g1', status: 'CONFIRMED', confirmationNumber: 'C-1' }];
  const res = await call('DELETE', '/api/guests/g1');
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /active reservation/i);
  assert.match(res.body.error, /C-1/);
  assert.strictEqual(memDb.guest.has('g1'), true);
});

test('a guest with only a cancelled/checked-out reservation history can be deleted', async () => {
  seedGuest();
  reservationResponse = [
    { id: 'r1', guestId: 'g1', status: 'CANCELLED' },
    { id: 'r2', guestId: 'g1', status: 'CHECKED_OUT' },
  ];
  const res = await call('DELETE', '/api/guests/g1');
  assert.strictEqual(res.status, 200);
});

test('a stay-service outage fails closed, not open', async () => {
  seedGuest();
  stayShouldThrow = true;
  const res = await call('DELETE', '/api/guests/g1');
  assert.strictEqual(res.status, 503);
  assert.strictEqual(memDb.guest.has('g1'), true);
});

test('a reservation-service outage fails closed, not open', async () => {
  seedGuest();
  reservationShouldThrow = true;
  const res = await call('DELETE', '/api/guests/g1');
  assert.strictEqual(res.status, 503);
  assert.strictEqual(memDb.guest.has('g1'), true);
});

test('an unknown guest is a 404', async () => {
  seedGuest();
  const res = await call('DELETE', '/api/guests/does-not-exist');
  assert.strictEqual(res.status, 404);
});
