// Unit tests for the shared date helpers.
//
// These run with TZ forced to Asia/Manila (UTC+8), because the bugs they guard
// against are invisible in UTC — which is why they shipped. Every assertion here
// corresponds to a real defect found in the audit:
//   - guest-visible folio lines dated one day early
//   - night-audit EOD totals pulled for the previous business day
//   - ?from=YYYY-MM-DD excluding that very business day
//
//   node --test src/lib/date.test.js

process.env.TZ = 'Asia/Manila';

const test = require('node:test');
const assert = require('node:assert');

const {
  localDay,
  startOfLocalDay,
  parseLocalDay,
  endOfLocalDay,
  localDayBounds,
  utcDayStart,
  utcDayFromString,
  utcDayKey,
  eachNight,
  addDays,
  nightsBetween,
} = require('./date');

// Guard: if the runtime ignored the TZ assignment these tests prove nothing.
test('test environment is running in Asia/Manila (UTC+8)', () => {
  const offsetMinutes = -new Date('2026-07-29T00:00:00Z').getTimezoneOffset();
  assert.strictEqual(offsetMinutes, 480, 'expected UTC+8; date bug tests are meaningless otherwise');
});

// ── The core regression ──────────────────────────────────────────────────────

test('localDay does NOT shift a local-midnight date into the previous day', () => {
  // This is the exact bug: audit.routes.js built businessDate at LOCAL midnight
  // and then formatted it with toISOString().slice(0, 10).
  const businessDate = new Date(2026, 6, 29); // 2026-07-29 00:00 +08:00

  assert.strictEqual(
    businessDate.toISOString().slice(0, 10),
    '2026-07-28',
    'sanity check: the old approach really does produce the wrong day'
  );
  assert.strictEqual(localDay(businessDate), '2026-07-29');
});

test('localDay is stable across the whole local day, including the UTC boundary', () => {
  // 08:00 local is exactly 00:00 UTC — the crossover where the old code flipped.
  for (const hour of [0, 1, 7, 8, 9, 12, 23]) {
    const d = new Date(2026, 6, 29, hour, 30);
    assert.strictEqual(localDay(d), '2026-07-29', `failed at ${hour}:30 local`);
  }
});

test('localDay handles month, year and leap-day boundaries', () => {
  assert.strictEqual(localDay(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
  assert.strictEqual(localDay(new Date(2025, 11, 31, 23, 59)), '2025-12-31');
  assert.strictEqual(localDay(new Date(2024, 1, 29, 4, 0)), '2024-02-29');
});

// ── parseLocalDay ────────────────────────────────────────────────────────────

test('parseLocalDay yields local midnight, not UTC midnight', () => {
  const d = parseLocalDay('2026-07-29');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 6);
  assert.strictEqual(d.getDate(), 29);
  assert.strictEqual(d.getHours(), 0);
  // new Date('2026-07-29') would be 08:00 local — the range-filter bug.
  assert.notStrictEqual(d.getTime(), new Date('2026-07-29').getTime());
});

test('parseLocalDay round-trips through localDay', () => {
  for (const s of ['2026-01-01', '2026-02-28', '2026-07-29', '2026-12-31']) {
    assert.strictEqual(localDay(parseLocalDay(s)), s);
  }
});

test('parseLocalDay rejects garbage rather than producing an Invalid Date', () => {
  assert.throws(() => parseLocalDay('not-a-date'), TypeError);
  assert.throws(() => parseLocalDay(''), TypeError);
});

test('parseLocalDay accepts a Date and normalises it to local midnight', () => {
  const d = parseLocalDay(new Date(2026, 6, 29, 17, 45));
  assert.strictEqual(d.getHours(), 0);
  assert.strictEqual(localDay(d), '2026-07-29');
});

// ── Day bounds (the ?from= range-filter bug) ─────────────────────────────────

test('a business day falls inside its own localDayBounds', () => {
  // The audit `?from=2026-07-29` query used new Date(from) (UTC midnight) as a
  // lower bound against local-midnight rows, excluding that day entirely.
  const businessDate = startOfLocalDay(new Date(2026, 6, 29, 14, 0));
  const { start, end } = localDayBounds(parseLocalDay('2026-07-29'));

  assert.ok(businessDate >= start, 'business day must not fall below its own lower bound');
  assert.ok(businessDate < end, 'business day must fall below the exclusive upper bound');

  const brokenLowerBound = new Date('2026-07-29');
  assert.ok(
    businessDate < brokenLowerBound,
    'sanity check: the old UTC-midnight bound really did exclude the day'
  );
});

test('localDayBounds is a half-open range exactly one day wide', () => {
  const { start, end } = localDayBounds(new Date(2026, 6, 29, 9, 0));
  assert.strictEqual(localDay(start), '2026-07-29');
  assert.strictEqual(end.getTime() - start.getTime(), 86400000);
  assert.strictEqual(endOfLocalDay(start).getTime(), end.getTime());
});

test('startOfLocalDay does not mutate its argument', () => {
  const original = new Date(2026, 6, 29, 15, 30);
  const snapshot = original.getTime();
  startOfLocalDay(original);
  assert.strictEqual(original.getTime(), snapshot);
});

// ── UTC date-only keys (inventory holds) ────────────────────────────────────

test('utcDayStart produces midnight UTC from local calendar fields', () => {
  const d = utcDayStart(new Date(2026, 6, 29, 23, 59)); // late evening in Manila
  assert.strictEqual(d.toISOString(), '2026-07-29T00:00:00.000Z');
});

test('utcDayStart agrees with the WRITE path for every string form', () => {
  // Holds are written with utcDayFromString via eachNight; availability reads
  // normalise with utcDayStart. If the two disagree, a read queries a different
  // night than the writer stored and availability silently misreports.
  for (const s of ['2026-07-29', '2026-07-29T00:00:00.000Z', '2026-07-29T16:30:00.000Z']) {
    assert.strictEqual(
      utcDayStart(s).toISOString(),
      utcDayFromString(s).toISOString(),
      `read/write night key diverged for ${s}`
    );
  }
});

test('utcDayFromString avoids a local-timezone round trip', () => {
  assert.strictEqual(utcDayFromString('2026-07-29').toISOString(), '2026-07-29T00:00:00.000Z');
  assert.strictEqual(utcDayKey(utcDayFromString('2026-07-29')), '2026-07-29');
});

test('utcDayStart is idempotent, so re-normalising a stored key is safe', () => {
  const once = utcDayFromString('2026-07-29');
  assert.strictEqual(utcDayStart(once).toISOString(), once.toISOString());
});

// ── eachNight: the hold-per-night expansion ─────────────────────────────────

test('eachNight excludes the checkout day', () => {
  // Arrive the 3rd, leave the 5th → occupies the nights of the 3rd and 4th.
  const nights = eachNight('2026-07-03', '2026-07-05');
  assert.deepStrictEqual(nights.map(utcDayKey), ['2026-07-03', '2026-07-04']);
});

test('eachNight returns one night for a single-night stay', () => {
  assert.deepStrictEqual(eachNight('2026-07-03', '2026-07-04').map(utcDayKey), ['2026-07-03']);
});

test('eachNight returns empty for a zero-length or inverted range', () => {
  assert.deepStrictEqual(eachNight('2026-07-03', '2026-07-03'), []);
  assert.deepStrictEqual(eachNight('2026-07-05', '2026-07-03'), []);
});

test('eachNight crosses a month boundary without skipping or repeating', () => {
  const keys = eachNight('2026-07-30', '2026-08-02').map(utcDayKey);
  assert.deepStrictEqual(keys, ['2026-07-30', '2026-07-31', '2026-08-01']);
});

test('eachNight produces every night at exactly midnight UTC', () => {
  for (const n of eachNight('2026-07-03', '2026-07-08')) {
    assert.strictEqual(n.getUTCHours(), 0);
    assert.strictEqual(n.getUTCMinutes(), 0);
    assert.strictEqual(n.getUTCMilliseconds(), 0);
  }
});

test('eachNight produces distinct keys, so a unique index cannot be violated', () => {
  const keys = eachNight('2026-07-01', '2026-08-01').map(utcDayKey);
  assert.strictEqual(keys.length, 31);
  assert.strictEqual(new Set(keys).size, 31);
});

test('eachNight accepts Date objects as well as strings', () => {
  const fromDates = eachNight(new Date(2026, 6, 3, 14, 0), new Date(2026, 6, 5, 11, 0));
  assert.deepStrictEqual(fromDates.map(utcDayKey), ['2026-07-03', '2026-07-04']);
});

test('eachNight REJECTS a pathological range instead of truncating it', () => {
  // Truncating would return a booking whose tail nights were never capacity
  // checked — an oversell that looks like a success.
  assert.throws(() => eachNight('2026-01-01', '2099-01-01'), RangeError);
  assert.strictEqual(eachNight('2026-01-01', '2027-01-01').length, 365);
});

// ── nightsBetween ───────────────────────────────────────────────────────────

test('nightsBetween counts nights, not calendar days', () => {
  assert.strictEqual(nightsBetween('2026-07-03', '2026-07-05'), 2);
  assert.strictEqual(nightsBetween('2026-07-03', '2026-07-04'), 1);
  assert.strictEqual(nightsBetween('2026-07-01', '2026-08-01'), 31);
});

test('nightsBetween never returns 0 — a same-day stay is one night', () => {
  assert.strictEqual(nightsBetween('2026-07-03', '2026-07-03'), 1);
});

test('nightsBetween ignores clock time, so a late arrival is not short-changed', () => {
  // 23:00 on the 3rd → 09:00 on the 4th is 10 hours, but it is one NIGHT.
  const late = new Date(2026, 6, 3, 23, 0);
  const early = new Date(2026, 6, 4, 9, 0);
  assert.strictEqual(nightsBetween(late, early), 1);
});

test('nightsBetween agrees with eachNight().length for real ranges', () => {
  for (const [a, b] of [
    ['2026-07-03', '2026-07-05'],
    ['2026-07-30', '2026-08-02'],
    ['2026-02-27', '2026-03-02'],
    ['2026-12-30', '2027-01-02'],
  ]) {
    assert.strictEqual(
      nightsBetween(a, b),
      eachNight(a, b).length,
      `nights disagreed for ${a} → ${b}; pricing and holds would diverge`
    );
  }
});

// ── addDays ─────────────────────────────────────────────────────────────────

test('addDays crosses month and year boundaries', () => {
  assert.strictEqual(localDay(addDays(parseLocalDay('2026-07-31'), 1)), '2026-08-01');
  assert.strictEqual(localDay(addDays(parseLocalDay('2026-12-31'), 1)), '2027-01-01');
  assert.strictEqual(localDay(addDays(parseLocalDay('2026-03-01'), -1)), '2026-02-28');
});

test('addDays does not mutate its argument', () => {
  const d = parseLocalDay('2026-07-29');
  const snapshot = d.getTime();
  addDays(d, 5);
  assert.strictEqual(d.getTime(), snapshot);
});

// ── Invalid input is rejected loudly ───────────────────────────────────────

test('helpers throw on invalid dates instead of emitting "Invalid Date" strings', () => {
  assert.throws(() => localDay(new Date('nope')), TypeError);
  assert.throws(() => startOfLocalDay('nope'), TypeError);
  assert.throws(() => utcDayStart('nope'), TypeError);
  assert.throws(() => utcDayFromString('07/29/2026'), TypeError);
});
