// Tests for the inventory hold gatekeeper — the capacity check that closes the
// double-booking race.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT
// -------------------------------------------
// Postgres is not available in a unit-test run, so the mock below MODELS the row
// lock that `SELECT ... FOR UPDATE` provides. That means these tests verify MY
// code — the per-night capacity arithmetic, the hard block, the group lifecycle,
// the 409 payload — GIVEN a working lock.
//
// They do NOT prove Postgres locks correctly (it does) and they do NOT prove the
// route actually asks for the lock. That second gap matters, so:
//
//   - `holds.concurrency.test.js` runs the real route against a real Postgres and
//     is the authoritative proof. It self-skips when DATABASE_URL is unset.
//   - the "regression detector" test at the bottom of this file re-runs the same
//     stampede with a NON-serialising mock and asserts that it DOES oversell.
//     That is what gives these tests teeth: if someone deletes the FOR UPDATE,
//     the mock stops being an accurate model and the concurrency test fails.
//
//   node --test src/routes/holds.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// ── A mock Prisma that models a row lock ─────────────────────────────────────

function makeMockPrisma({ serializeTransactions = true, readLatencyMs = 1, barrierSize = 0 } = {}) {
  const holds = [];
  const roomTypes = new Map();
  // Models the queue that concurrent transactions form on the RoomType row lock.
  let lockChain = Promise.resolve();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A barrier makes the unlocked race DETERMINISTIC instead of timing-dependent.
  // Every reader parks after issuing its count until `barrierSize` readers have
  // arrived, then all are released at once — precisely the interleaving a missing
  // row lock permits. A flaky control test would be worse than none, because it
  // would erode trust in the concurrency assertions it exists to validate.
  let waiting = [];
  async function barrier() {
    if (!barrierSize) return;
    waiting.push(true);
    if (waiting.length >= barrierSize) {
      const release = pending;
      pending = [];
      waiting = [];
      release.forEach((r) => r());
      return;
    }
    await new Promise((resolve) => {
      pending.push(resolve);
      // Safety valve: never hang the suite if fewer readers arrive than expected.
      setTimeout(resolve, 500);
    });
  }
  let pending = [];

  function client(_tx) {
    return {
      // The route locks the room type first. In the mock the lock itself is
      // provided by $transaction; this just returns the row.
      $queryRaw: async (strings, ...values) => {
        const code = values[0];
        const rt = roomTypes.get(code);
        return rt ? [{ code: rt.code, totalInventory: rt.totalInventory }] : [];
      },
      inventoryHold: {
        groupBy: async ({ where }) => {
          // Simulated DB round-trip latency. Without a lock this is the window
          // in which a competing request reads the same stale count.
          await sleep(readLatencyMs);
          const now = new Date();
          const compute = () => {
            const wanted = new Set((where.date?.in || []).map((d) => d.getTime()));
            const matched = holds.filter(
              (h) =>
                h.roomTypeCode === where.roomTypeCode &&
                where.status.in.includes(h.status) &&
                wanted.has(h.date.getTime()) &&
                h.expiresAt > now
            );
            const byDate = new Map();
            for (const h of matched) {
              byDate.set(h.date.getTime(), (byDate.get(h.date.getTime()) || 0) + h.quantity);
            }
            return [...byDate.entries()].map(([t, sum]) => ({ date: new Date(t), _sum: { quantity: sum } }));
          };
          const result = compute();
          // Park here so every competing reader has already taken its (stale)
          // count before any of them is allowed to write.
          await barrier();
          return result;
        },
        createMany: async ({ data }) => {
          for (const row of data) holds.push({ id: `h${holds.length}`, createdAt: new Date(), ...row });
          return { count: data.length };
        },
        findMany: async ({ where, orderBy }) => {
          let rows = holds.filter((h) => (where.groupId ? h.groupId === where.groupId : true));
          if (orderBy?.date === 'asc') rows = [...rows].sort((a, b) => a.date - b.date);
          return rows.map((r) => ({ ...r }));
        },
        updateMany: async ({ where, data }) => {
          let n = 0;
          for (const h of holds) {
            if (where.groupId && h.groupId !== where.groupId) continue;
            if (where.status && h.status !== where.status) continue;
            Object.assign(h, data);
            n += 1;
          }
          return { count: n };
        },
        count: async ({ where }) =>
          holds.filter((h) => h.reservationId === where.reservationId && where.status.in.includes(h.status))
            .length,
      },
      roomType: {
        findUnique: async ({ where }) => roomTypes.get(where.code) || null,
      },
      room: { findMany: async () => [], findUnique: async () => null },
      facilityBooking: { findFirst: async () => null },
      $transaction: async (fn) => {
        if (!serializeTransactions) return fn(client(true));
        // Serialise: every transaction waits for the previous one, exactly as
        // concurrent writers queue on a FOR UPDATE row lock.
        const run = lockChain.then(() => fn(client(true)));
        // Keep the chain alive even when a transaction rejects (a 409 rollback).
        lockChain = run.then(
          () => {},
          () => {}
        );
        return run;
      },
    };
  }

  const c = client(false);
  c.__state = { holds, roomTypes };
  return c;
}

// ── Wire the mock in before the route module is loaded ───────────────────────

let mockPrisma = makeMockPrisma();
const published = [];

// The route module does `const prisma = new PrismaClient()` ONCE at require time,
// so handing it a raw instance would freeze the first mock in place and every
// later reset() would be invisible to the code under test. This proxy resolves
// against whatever mockPrisma currently points at, on each property access.
const prismaProxy = new Proxy(
  {},
  {
    get: (_t, prop) => mockPrisma[prop],
    has: (_t, prop) => prop in mockPrisma,
  }
);

require.cache[require.resolve('@prisma/client')] = {
  exports: {
    PrismaClient: function () {
      return prismaProxy;
    },
  },
};
require.cache[require.resolve('ioredis')] = {
  exports: function () {
    return { publish: (ch, msg) => published.push({ ch, msg }), on: () => {}, disconnect: () => {} };
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

const router = require('./inventory.routes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

// One server per test file, so a stampede of parallel requests shares a socket
// pool instead of racing to bind ports.
function withServer(fn) {
  return async () => {
    const server = makeApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    try {
      await fn((method, path, body) => call(port, method, path, body));
    } finally {
      server.close();
    }
  };
}

function call(port, method, path, body) {
  return new Promise((resolve) => {
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
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

function reset({ totalInventory = 1, serializeTransactions = true, barrierSize = 0 } = {}) {
  mockPrisma = makeMockPrisma({ serializeTransactions, barrierSize });
  mockPrisma.__state.roomTypes.set('STD', {
    code: 'STD',
    name: 'Standard',
    baseRate: 250000,
    totalInventory,
  });
  published.length = 0;
  return mockPrisma;
}

const RANGE = { roomTypeCode: 'STD', checkIn: '2026-05-01', checkOut: '2026-05-03' };

// ── Basic behaviour ─────────────────────────────────────────────────────────

test(
  'a hold covering N nights creates one row per night, sharing a groupId',
  withServer(async (req) => {
    reset({ totalInventory: 5 });
    const res = await req('POST', '/api/holds', RANGE);

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.body.nights, ['2026-05-01', '2026-05-02'], 'checkout day must be excluded');
    assert.strictEqual(res.body.holds.length, 2);
    assert.strictEqual(new Set(res.body.holds.map((h) => h.groupId)).size, 1);
    assert.ok(res.body.groupId);
  })
);

test(
  'an unattached hold has a null reservationId and a short TTL',
  withServer(async (req) => {
    reset({ totalInventory: 5 });
    const res = await req('POST', '/api/holds', RANGE);

    assert.strictEqual(res.body.reservationId, null);
    const ttlMs = new Date(res.body.expiresAt) - Date.now();
    assert.ok(ttlMs > 0 && ttlMs <= 121_000, `expected a ~120s TTL, got ${ttlMs}ms`);
  })
);

test(
  'expiresAt must not corrupt the last night it was derived from',
  withServer(async (req) => {
    // Regression guard: expiresAt was originally computed by mutating
    // nights[nights.length - 1] in place, which shifted the final night's date
    // forward by a day — silently holding the wrong night.
    reset({ totalInventory: 5 });
    const res = await req('POST', '/api/holds', {
      roomTypeCode: 'STD',
      checkIn: '2026-05-01',
      checkOut: '2026-05-03',
      reservationId: 'res-1',
    });

    assert.deepStrictEqual(res.body.nights, ['2026-05-01', '2026-05-02']);
    const stored = mockPrisma.__state.holds.map((h) => h.date.toISOString().slice(0, 10)).sort();
    assert.deepStrictEqual(stored, ['2026-05-01', '2026-05-02'], 'stored night keys were mutated');
    assert.strictEqual(new Date(res.body.expiresAt).toISOString().slice(0, 10), '2026-05-03');
  })
);

test(
  'every stored night is midnight UTC',
  withServer(async (req) => {
    reset({ totalInventory: 5 });
    await req('POST', '/api/holds', RANGE);
    for (const h of mockPrisma.__state.holds) {
      assert.strictEqual(h.date.getUTCHours(), 0);
      assert.strictEqual(h.date.getUTCMinutes(), 0);
    }
  })
);

// ── Input validation ────────────────────────────────────────────────────────

test(
  'a hold request without a room type is rejected',
  withServer(async (req) => {
    reset();
    assert.strictEqual(
      (await req('POST', '/api/holds', { checkIn: '2026-05-01', checkOut: '2026-05-03' })).status,
      400
    );
  })
);

test(
  'a hold request without any dates is rejected',
  withServer(async (req) => {
    reset();
    assert.strictEqual((await req('POST', '/api/holds', { roomTypeCode: 'STD' })).status, 400);
  })
);

test(
  'an inverted or zero-length date range is rejected',
  withServer(async (req) => {
    reset({ totalInventory: 5 });
    assert.strictEqual(
      (
        await req('POST', '/api/holds', {
          roomTypeCode: 'STD',
          checkIn: '2026-05-05',
          checkOut: '2026-05-01',
        })
      ).status,
      400
    );
    assert.strictEqual(
      (
        await req('POST', '/api/holds', {
          roomTypeCode: 'STD',
          checkIn: '2026-05-01',
          checkOut: '2026-05-01',
        })
      ).status,
      400
    );
  })
);

test(
  'an unknown room type is rejected, not silently held',
  withServer(async (req) => {
    reset();
    const res = await req('POST', '/api/holds', { ...RANGE, roomTypeCode: 'NOPE' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /room type/i);
  })
);

// ── Capacity: the hard block ────────────────────────────────────────────────

test(
  'holds are refused once the room type is full',
  withServer(async (req) => {
    reset({ totalInventory: 2 });
    assert.strictEqual((await req('POST', '/api/holds', RANGE)).status, 201);
    assert.strictEqual((await req('POST', '/api/holds', RANGE)).status, 201);

    const third = await req('POST', '/api/holds', RANGE);
    assert.strictEqual(third.status, 409, 'third booking of a 2-room type must be refused');
    assert.strictEqual(third.body.totalInventory, 2);
    assert.strictEqual(third.body.alreadyHeld, 2);
    assert.strictEqual(third.body.firstFullNight, '2026-05-01');
  })
);

test(
  'a booking is refused when ANY single night in its range is full',
  withServer(async (req) => {
    // The middle night is the only one at capacity. A booking spanning it occupies
    // a room on every night, so the whole booking must fail — summing across
    // nights instead of taking the peak was how the old code oversold.
    reset({ totalInventory: 1 });
    assert.strictEqual(
      (
        await req('POST', '/api/holds', {
          roomTypeCode: 'STD',
          checkIn: '2026-05-02',
          checkOut: '2026-05-03',
        })
      ).status,
      201
    );

    const spanning = await req('POST', '/api/holds', {
      roomTypeCode: 'STD',
      checkIn: '2026-05-01',
      checkOut: '2026-05-04',
    });
    assert.strictEqual(spanning.status, 409);
    assert.strictEqual(spanning.body.firstFullNight, '2026-05-02');
  })
);

test(
  'a refused hold writes nothing — the transaction rolls back cleanly',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    await req('POST', '/api/holds', RANGE);
    const afterFirst = mockPrisma.__state.holds.length;

    await req('POST', '/api/holds', RANGE); // 409
    assert.strictEqual(
      mockPrisma.__state.holds.length,
      afterFirst,
      'a rejected hold must leave no rows behind'
    );
  })
);

test(
  'capacity frees up again once a hold is released',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    const first = await req('POST', '/api/holds', RANGE);
    assert.strictEqual((await req('POST', '/api/holds', RANGE)).status, 409);

    assert.strictEqual((await req('DELETE', `/api/holds/${first.body.groupId}`, null)).status, 200);
    assert.strictEqual(
      (await req('POST', '/api/holds', RANGE)).status,
      201,
      'released capacity must be reusable'
    );
  })
);

test(
  'non-overlapping dates do not consume each other capacity',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    assert.strictEqual(
      (
        await req('POST', '/api/holds', {
          roomTypeCode: 'STD',
          checkIn: '2026-05-01',
          checkOut: '2026-05-03',
        })
      ).status,
      201
    );
    // Checks in the day the first checks out — no shared night.
    assert.strictEqual(
      (
        await req('POST', '/api/holds', {
          roomTypeCode: 'STD',
          checkIn: '2026-05-03',
          checkOut: '2026-05-05',
        })
      ).status,
      201
    );
  })
);

test(
  'a quantity larger than remaining inventory is refused as one unit',
  withServer(async (req) => {
    reset({ totalInventory: 3 });
    const res = await req('POST', '/api/holds', { ...RANGE, quantity: 4 });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.requested, 4);
  })
);

// ── THE RACE ────────────────────────────────────────────────────────────────

test(
  '20 simultaneous bookings for the LAST room → exactly 1 succeeds',
  withServer(async (req) => {
    reset({ totalInventory: 1 });

    const results = await Promise.all(Array.from({ length: 20 }, () => req('POST', '/api/holds', RANGE)));

    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);

    assert.strictEqual(created.length, 1, `expected exactly 1 winner, got ${created.length}`);
    assert.strictEqual(refused.length, 19, `expected 19 refusals, got ${refused.length}`);
    assert.strictEqual(
      results.filter((r) => r.status >= 500).length,
      0,
      'a losing booking must get a clean 409, never a 500'
    );

    // And the ledger must agree with the HTTP responses.
    const live = mockPrisma.__state.holds.filter((h) => h.status === 'ACTIVE');
    assert.strictEqual(live.length, 2, 'exactly one 2-night hold should exist (2 rows)');
    assert.strictEqual(new Set(live.map((h) => h.groupId)).size, 1);
  })
);

test(
  '30 simultaneous bookings against 7 rooms → exactly 7 succeed',
  withServer(async (req) => {
    reset({ totalInventory: 7 });

    const results = await Promise.all(Array.from({ length: 30 }, () => req('POST', '/api/holds', RANGE)));

    assert.strictEqual(results.filter((r) => r.status === 201).length, 7);
    assert.strictEqual(results.filter((r) => r.status === 409).length, 23);

    // Per-night occupancy must never exceed inventory.
    const perNight = new Map();
    for (const h of mockPrisma.__state.holds.filter((x) => x.status === 'ACTIVE')) {
      const k = h.date.toISOString();
      perNight.set(k, (perNight.get(k) || 0) + h.quantity);
    }
    for (const [night, count] of perNight) {
      assert.ok(count <= 7, `oversold ${night}: ${count} rooms held against 7 available`);
    }
  })
);

test(
  'REGRESSION DETECTOR: without the row lock the same stampede oversells',
  withServer(async (req) => {
    // This test asserts the BROKEN behaviour on purpose. It is the control that
    // makes the two tests above meaningful: it demonstrates the stampede genuinely
    // exercises the count-then-write window, so a winner count of 1 above is the
    // lock working rather than the test being too slow to race.
    //
    // If this ever starts failing (i.e. the unlocked mock stops overselling), the
    // harness has lost its ability to detect a missing FOR UPDATE and the tests
    // above are no longer trustworthy.
    reset({ totalInventory: 1, serializeTransactions: false, barrierSize: 20 });

    const results = await Promise.all(Array.from({ length: 20 }, () => req('POST', '/api/holds', RANGE)));
    const created = results.filter((r) => r.status === 201).length;

    assert.strictEqual(
      created,
      20,
      `expected all 20 unlocked bookings to oversell a 1-room type, got ${created} — ` +
        'the harness can no longer demonstrate a missing FOR UPDATE, so the ' +
        'concurrency assertions above are not trustworthy'
    );
  })
);

// ── Group lifecycle: attach / release / commit ───────────────────────────────

test(
  'attaching a hold binds the reservation and extends expiry to checkout',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    const { body: hold } = await req('POST', '/api/holds', RANGE);

    const res = await req('POST', `/api/holds/${hold.groupId}/attach`, { reservationId: 'res-42' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.reservationId, 'res-42');
    assert.strictEqual(new Date(res.body.expiresAt).toISOString().slice(0, 10), '2026-05-03');

    for (const h of mockPrisma.__state.holds) {
      assert.strictEqual(h.reservationId, 'res-42');
    }
  })
);

test(
  'attach requires a reservationId',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    const { body: hold } = await req('POST', '/api/holds', RANGE);
    assert.strictEqual((await req('POST', `/api/holds/${hold.groupId}/attach`, {})).status, 400);
  })
);

test(
  'attaching an unknown group is a 404, not a silent success',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    assert.strictEqual(
      (await req('POST', '/api/holds/no-such-group/attach', { reservationId: 'r1' })).status,
      404
    );
  })
);

test(
  'a released hold cannot be attached afterwards',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    const { body: hold } = await req('POST', '/api/holds', RANGE);
    await req('DELETE', `/api/holds/${hold.groupId}`, null);

    const res = await req('POST', `/api/holds/${hold.groupId}/attach`, { reservationId: 'res-1' });
    assert.strictEqual(
      res.status,
      409,
      'attaching a released hold would resurrect capacity someone else may hold'
    );
  })
);

test(
  'committing then releasing is refused — a sold room must not return to sale',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    const { body: hold } = await req('POST', '/api/holds', RANGE);

    assert.strictEqual((await req('POST', `/api/holds/${hold.groupId}/commit`, {})).status, 200);
    assert.strictEqual((await req('DELETE', `/api/holds/${hold.groupId}`, null)).status, 409);
  })
);

test(
  'releasing the same group twice is refused the second time',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    const { body: hold } = await req('POST', '/api/holds', RANGE);
    assert.strictEqual((await req('DELETE', `/api/holds/${hold.groupId}`, null)).status, 200);
    assert.strictEqual((await req('DELETE', `/api/holds/${hold.groupId}`, null)).status, 409);
  })
);

test(
  'a committed hold still counts against availability',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    const { body: hold } = await req('POST', '/api/holds', RANGE);
    await req('POST', `/api/holds/${hold.groupId}/commit`, {});

    assert.strictEqual((await req('POST', '/api/holds', RANGE)).status, 409);
  })
);

// ── Events ──────────────────────────────────────────────────────────────────

test(
  'a successful hold publishes inventory:held',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    await req('POST', '/api/holds', RANGE);
    assert.ok(published.some((p) => p.ch === 'inventory:held'));
  })
);

test(
  'a refused hold publishes nothing',
  withServer(async (req) => {
    reset({ totalInventory: 1 });
    await req('POST', '/api/holds', RANGE);
    published.length = 0;

    await req('POST', '/api/holds', RANGE); // 409
    assert.strictEqual(published.length, 0, 'a failed hold must not emit an event');
  })
);
