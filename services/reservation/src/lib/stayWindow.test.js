const test = require('node:test');
const assert = require('node:assert');

const { stampWindow, DEFAULT_SERVICE_TIMES } = require('./stayWindow');

const iso = (d) => d.toISOString();

test('the property check-in and check-out times land on the stored timestamps', () => {
  const w = stampWindow({
    checkIn: '2026-08-30',
    checkOut: '2026-09-02',
    checkInTime: '14:00',
    checkOutTime: '12:00',
  });
  assert.strictEqual(iso(w.checkIn), '2026-08-30T14:00:00.000Z');
  assert.strictEqual(iso(w.checkOut), '2026-09-02T12:00:00.000Z');
});

test('the calendar dates are never moved', () => {
  const w = stampWindow({ checkIn: '2026-08-30', checkOut: '2026-08-31' });
  assert.strictEqual(iso(w.checkIn).slice(0, 10), '2026-08-30');
  assert.strictEqual(iso(w.checkOut).slice(0, 10), '2026-08-31');
});

// The point of the whole change: a room vacated at noon and re-let at 2pm on the
// same date must NOT read as an overlap, while a booking that starts before the
// previous guest has gone MUST.
test('back-to-back stays in one room do not overlap', () => {
  const a = stampWindow({ checkIn: '2026-08-30', checkOut: '2026-08-31' });
  const b = stampWindow({ checkIn: '2026-08-31', checkOut: '2026-09-01' });
  assert.ok(a.checkOut <= b.checkIn, 'departure must not run past the next arrival');
});

test('an arrival before the departing guest has gone does overlap', () => {
  const a = stampWindow({ checkIn: '2026-08-30', checkOut: '2026-08-31' });
  // Someone hand-booked a 10:00 arrival on the changeover day.
  const b = stampWindow({
    checkIn: '2026-08-31',
    checkOut: '2026-09-01',
    checkInTime: '10:00',
    checkOutTime: '09:00',
  });
  assert.ok(b.checkIn < a.checkOut, 'this is the conflict the constraint should catch');
});

test('an existing timestamp is re-stamped, not preserved', () => {
  // Rows written before this change carry midnight. Passing one back through
  // must produce the property window, not keep 00:00.
  const w = stampWindow({
    checkIn: new Date('2026-08-30T00:00:00.000Z'),
    checkOut: new Date('2026-09-02T00:00:00.000Z'),
  });
  assert.strictEqual(iso(w.checkIn), '2026-08-30T14:00:00.000Z');
  assert.strictEqual(iso(w.checkOut), '2026-09-02T12:00:00.000Z');
});

test('missing or malformed times fall back to the shipped defaults', () => {
  assert.deepStrictEqual(DEFAULT_SERVICE_TIMES, { checkInTime: '14:00', checkOutTime: '12:00' });
  for (const bad of [undefined, null, '', 'noon', '25:00', '14', '14:60']) {
    const w = stampWindow({
      checkIn: '2026-08-30',
      checkOut: '2026-08-31',
      checkInTime: bad,
      checkOutTime: bad,
    });
    assert.strictEqual(iso(w.checkIn), '2026-08-30T14:00:00.000Z', `bad time ${bad}`);
    assert.strictEqual(iso(w.checkOut), '2026-08-31T12:00:00.000Z', `bad time ${bad}`);
  }
});

test('an unparseable date is returned untouched rather than becoming Invalid Date', () => {
  // The routes validate dates themselves and return 400; this must not turn a
  // bad input into a silently wrong timestamp before they get the chance.
  const w = stampWindow({ checkIn: 'not-a-date', checkOut: '2026-08-31' });
  assert.strictEqual(w.checkIn, 'not-a-date');
  assert.strictEqual(iso(w.checkOut), '2026-08-31T12:00:00.000Z');
});
