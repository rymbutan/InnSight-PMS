// Route-level tests for DELETE /api/reservations/:id — the Record Deletion
// Permissions requirement: Admin/Manager ONLY, every lower-tier role refused.
//
// Deliberately does NOT stub ../middleware/auth the way reservation.test.js
// does (that stub makes requireRole a permissive no-op, which would prove
// nothing about RBAC here) — this file uses the REAL requireRole, and
// injects req.user from a test-only header so a request can simulate any
// role.
//
//   node --test src/routes/reservationDelete.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

let reservationRow = null;
let deletedIds = [];
const releasedHolds = [];

const mockPrisma = {
  reservation: {
    findUnique: async ({ where: { id } }) =>
      reservationRow && id === reservationRow.id ? reservationRow : null,
    delete: async ({ where: { id } }) => {
      deletedIds.push(id);
      return reservationRow;
    },
  },
};

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
require.cache[require.resolve('../lib/inventoryClient')] = {
  exports: {
    NoInventoryError: class extends Error {},
    makeInventoryClient: () => ({
      releaseHold: async (groupId) => {
        releasedHolds.push(groupId);
      },
    }),
  },
};

const router = require('./reservation.routes');

function call(method, path, roles) {
  return new Promise((resolve) => {
    const app = express();
    // Stands in for verifyToken: a real deployment sets req.user from the JWT
    // before the router ever sees the request. Roles come from a header here
    // purely so this ONE test file can simulate any role on any request.
    app.use((req, _res, next) => {
      if (roles) req.user = { sub: 'u1', username: 'tester', roles };
      next();
    });
    app.use('/api', router);
    const server = app.listen(0, () => {
      http
        .request({ host: '127.0.0.1', port: server.address().port, method, path }, (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c;
          });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null });
          });
        })
        .end();
    });
  });
}

function reset(overrides = {}) {
  reservationRow = {
    id: 'r1',
    confirmationNumber: 'R-TEST',
    status: 'PENDING',
    inventoryHoldGroupId: null,
    ...overrides,
  };
  deletedIds = [];
  releasedHolds.length = 0;
}

test('ADMIN can delete a PENDING reservation', async () => {
  reset();
  const r = await call('DELETE', '/api/reservations/r1', ['ADMIN']);
  assert.equal(r.status, 204);
  assert.deepEqual(deletedIds, ['r1']);
});

test('MANAGER can delete a CONFIRMED reservation', async () => {
  reset({ status: 'CONFIRMED' });
  const r = await call('DELETE', '/api/reservations/r1', ['MANAGER']);
  assert.equal(r.status, 204);
  assert.deepEqual(deletedIds, ['r1']);
});

test('FRONT_DESK is refused — lower-tier staff cannot delete', async () => {
  reset();
  const r = await call('DELETE', '/api/reservations/r1', ['FRONT_DESK']);
  assert.equal(r.status, 403);
  assert.deepEqual(deletedIds, []);
});

test('HOUSEKEEPING_MAINTENANCE is refused', async () => {
  reset();
  const r = await call('DELETE', '/api/reservations/r1', ['HOUSEKEEPING_MAINTENANCE']);
  assert.equal(r.status, 403);
  assert.deepEqual(deletedIds, []);
});

test('AUDITOR is refused', async () => {
  reset();
  const r = await call('DELETE', '/api/reservations/r1', ['AUDITOR']);
  assert.equal(r.status, 403);
  assert.deepEqual(deletedIds, []);
});

test('an unauthenticated request (no roles at all) is refused', async () => {
  reset();
  const r = await call('DELETE', '/api/reservations/r1', null);
  assert.equal(r.status, 403);
  assert.deepEqual(deletedIds, []);
});

test('deleting an unknown reservation is a 404', async () => {
  reset();
  const r = await call('DELETE', '/api/reservations/nope', ['ADMIN']);
  assert.equal(r.status, 404);
});

for (const status of ['CHECKED_IN', 'IN_HOUSE', 'CHECKED_OUT']) {
  test(`a ${status} reservation is refused even for ADMIN — a real stay exists against it`, async () => {
    reset({ status });
    const r = await call('DELETE', '/api/reservations/r1', ['ADMIN']);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /cancel it instead/i);
    assert.deepEqual(deletedIds, []);
  });
}

for (const status of ['PENDING', 'CONFIRMED', 'CANCELLED', 'NO_SHOW']) {
  test(`a ${status} reservation CAN be deleted by an admin`, async () => {
    reset({ status });
    const r = await call('DELETE', '/api/reservations/r1', ['ADMIN']);
    assert.equal(r.status, 204);
    assert.deepEqual(deletedIds, ['r1']);
  });
}

test('deleting a reservation that still holds inventory releases the hold', async () => {
  reset({ inventoryHoldGroupId: 'g1' });
  const r = await call('DELETE', '/api/reservations/r1', ['ADMIN']);
  assert.equal(r.status, 204);
  assert.deepEqual(releasedHolds, ['g1']);
});

test('deleting a reservation with no hold releases nothing', async () => {
  reset({ inventoryHoldGroupId: null });
  await call('DELETE', '/api/reservations/r1', ['ADMIN']);
  assert.deepEqual(releasedHolds, []);
});
