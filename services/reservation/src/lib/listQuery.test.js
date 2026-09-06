const test = require('node:test');
const assert = require('node:assert');

const { reservationListWhere, BadWindowError } = require('./listQuery');

// ─────────────────────────────────────────────────────────────────────────────
// `from`/`to` are an OVERLAP window: "which bookings touch these nights?".
// `checkInFrom`/`checkInTo` ask a DIFFERENT question: "which bookings START in
// this window?" — what an arrivals list needs. They are separate params because
// the audit's no-show sweep and the calendar both depend on the overlap
// semantics of from/to, and reinterpreting those would break them.
// ─────────────────────────────────────────────────────────────────────────────

test('checkInFrom sets an inclusive lower bound on checkIn', () => {
  const where = reservationListWhere({ checkInFrom: '2026-09-05' });
  assert.deepEqual(where.checkIn, { gte: new Date('2026-09-05T00:00:00.000Z') });
  assert.equal(where.checkOut, undefined, 'an arrival window must not constrain checkOut');
});

test('checkInTo sets an exclusive upper bound on checkIn', () => {
  const where = reservationListWhere({ checkInTo: '2026-09-06' });
  assert.deepEqual(where.checkIn, { lt: new Date('2026-09-06T00:00:00.000Z') });
});

test('checkInFrom and checkInTo combine into one bounded range', () => {
  const where = reservationListWhere({ checkInFrom: '2026-09-05', checkInTo: '2026-09-12' });
  assert.deepEqual(where.checkIn, {
    gte: new Date('2026-09-05T00:00:00.000Z'),
    lt: new Date('2026-09-12T00:00:00.000Z'),
  });
});

// The bug this guards: `to` used to ASSIGN where.checkIn outright. Adding a
// second writer to the same key without merging silently drops one bound, and
// the caller gets a wider result set than it asked for with no error.
test('the overlap `to` and an arrival window MERGE rather than overwrite', () => {
  const where = reservationListWhere({ from: '2026-09-01', to: '2026-09-30', checkInFrom: '2026-09-05' });
  assert.equal(
    where.checkIn.gte.toISOString(),
    '2026-09-05T00:00:00.000Z',
    'checkInFrom must survive alongside to'
  );
  assert.equal(
    where.checkIn.lt.toISOString(),
    '2026-09-30T00:00:00.000Z',
    'to must survive alongside checkInFrom'
  );
  assert.deepEqual(where.checkOut, { gt: new Date('2026-09-01T00:00:00.000Z') });
});

test('when both cap checkIn, the TIGHTER upper bound wins', () => {
  const where = reservationListWhere({ to: '2026-09-30', checkInTo: '2026-09-08' });
  assert.equal(where.checkIn.lt.toISOString(), '2026-09-08T00:00:00.000Z');

  const other = reservationListWhere({ to: '2026-09-08', checkInTo: '2026-09-30' });
  assert.equal(other.checkIn.lt.toISOString(), '2026-09-08T00:00:00.000Z');
});

test('no date params leaves checkIn unconstrained', () => {
  const where = reservationListWhere({ status: 'CONFIRMED' });
  assert.equal(where.checkIn, undefined);
  assert.equal(where.status, 'CONFIRMED');
});

test('an unparseable arrival bound throws BadWindowError, not a silent empty list', () => {
  assert.throws(() => reservationListWhere({ checkInFrom: 'not-a-date' }), BadWindowError);
  assert.throws(() => reservationListWhere({ checkInTo: 'not-a-date' }), BadWindowError);
});

// ── The existing overlap behaviour must be untouched ────────────────────────

test('from/to still build the overlap test', () => {
  const where = reservationListWhere({ from: '2026-09-05', to: '2026-09-08' });
  assert.deepEqual(where.checkIn, { lt: new Date('2026-09-08T00:00:00.000Z') });
  assert.deepEqual(where.checkOut, { gt: new Date('2026-09-05T00:00:00.000Z') });
});

test('the audit no-show sweep form (to with no from) still works', () => {
  const where = reservationListWhere({ status: 'CONFIRMED', to: '2026-09-05T00:00:00.000Z' });
  assert.deepEqual(where.checkIn, { lt: new Date('2026-09-05T00:00:00.000Z') });
  assert.equal(where.checkOut, undefined);
});
