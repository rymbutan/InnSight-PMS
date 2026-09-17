// The seam test: what the middleware publishes must be exactly what the
// ActivityLog table can store.
//
// The publisher (lib/activityLog.js) and the consumer (redis.subscriber.js) live
// in different services and talk over Redis, so nothing type-checks between them.
// Rename a field on one side and the other silently writes a row of nulls — the
// log keeps "working" while quietly recording nothing useful. These tests run a
// real buildEntry() output through toRow() and assert the result matches the
// columns in prisma/schema.prisma.
//
//   node --test src/subscribers/activity.subscriber.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// toRow's module pulls in prisma and ioredis at require time; stub both, exactly
// as routes/authz.test.js does.
require.cache[require.resolve('../lib/prisma')] = { exports: new Proxy({}, { get: () => () => {} }) };
try {
  require.cache[require.resolve('ioredis')] = {
    exports: function Redis() {
      return { on: () => {}, subscribe: () => {}, disconnect: () => {} };
    },
  };
} catch {
  /* not installed in this service */
}

const { toRow } = require('./redis.subscriber');
const { buildEntry } = require('../lib/activityLog');

// The non-relational columns of model ActivityLog in prisma/schema.prisma, minus
// `id` (defaulted by the database). If a column is added there and not here, the
// last test in this file fails and points at the gap.
const COLUMNS = [
  'at',
  'service',
  'actorId',
  'actorName',
  'actorRoles',
  'action',
  'summary',
  'method',
  'path',
  'targetType',
  'targetId',
  'status',
  'requestId',
  'ip',
];

function published(overrides = {}) {
  return {
    ...buildEntry({
      service: 'reservation',
      method: 'PATCH',
      originalUrl: '/api/reservations/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b/cancel',
      statusCode: 200,
      user: { sub: 'u-1', username: 'mramos', roles: ['FRONT_DESK'] },
      requestId: 'req-9',
      ip: '10.0.0.4',
    }),
    ...overrides,
  };
}

test('a published record maps onto the table columns exactly', () => {
  const row = toRow(published());
  assert.deepEqual(Object.keys(row).sort(), [...COLUMNS].sort());
});

test('the values survive the trip intact', () => {
  const row = toRow(published());
  assert.equal(row.service, 'reservation');
  assert.equal(row.actorId, 'u-1');
  assert.equal(row.actorName, 'mramos');
  assert.deepEqual(row.actorRoles, ['FRONT_DESK']);
  assert.equal(row.action, 'reservations.cancel');
  assert.equal(row.method, 'PATCH');
  assert.equal(row.path, '/api/reservations/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b/cancel');
  assert.equal(row.targetId, '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b');
  assert.equal(row.status, 200);
  assert.equal(row.requestId, 'req-9');
  assert.equal(row.ip, '10.0.0.4');
  assert.ok(row.at instanceof Date, '`at` must be a Date — Prisma rejects an ISO string for DateTime');
});

test('a malformed event yields a storable row rather than throwing', () => {
  // The event crosses a process boundary, so it is untrusted input. A bad one
  // must cost one row, not the subscriber.
  const row = toRow({});
  assert.equal(row.service, 'unknown');
  assert.equal(row.actorName, 'unknown');
  assert.deepEqual(row.actorRoles, []);
  assert.equal(row.status, 0);
  assert.ok(row.at instanceof Date);
  assert.deepEqual(Object.keys(row).sort(), [...COLUMNS].sort());
});

test('a non-array actorRoles cannot poison the String[] column', () => {
  assert.deepEqual(toRow(published({ actorRoles: 'ADMIN' })).actorRoles, []);
  assert.deepEqual(toRow(published({ actorRoles: null })).actorRoles, []);
});

test('an unparseable timestamp falls back to now instead of storing Invalid Date', () => {
  const row = toRow(published({ at: 'not-a-date' }));
  assert.ok(row.at instanceof Date);
  assert.ok(!Number.isNaN(row.at.getTime()), '`at` must never be an Invalid Date');
});

test('oversized text is clamped so one long URL cannot bloat the table', () => {
  const row = toRow(published({ path: `/api/${'x'.repeat(5000)}`, summary: 'y'.repeat(5000) }));
  assert.ok(row.path.length <= 512, `path was ${row.path.length}`);
  assert.ok(row.summary.length <= 1024, `summary was ${row.summary.length}`);
});

test('the column list here matches the prisma schema', () => {
  // Guards the guard: if ActivityLog gains a column and COLUMNS is not updated,
  // the first test above would keep passing while the new column silently never
  // gets written. Read the schema and compare.
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
  const block = schema.match(/model ActivityLog \{([\s\S]*?)\n\}/);
  assert.ok(block, 'model ActivityLog not found in schema.prisma');

  const fields = block[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
    .map((l) => l.split(/\s+/)[0]);

  assert.deepEqual(
    fields.filter((f) => f !== 'id').sort(),
    [...COLUMNS].sort(),
    'schema.prisma and COLUMNS disagree — a column would go unwritten'
  );
});
