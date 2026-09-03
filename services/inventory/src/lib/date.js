// Local-timezone date helpers for the backend services.
//
// WHY THIS FILE EXISTS
// --------------------
// `new Date(...).toISOString().slice(0, 10)` is the single most common date bug
// in this codebase. toISOString() converts to UTC first, so in Asia/Manila
// (UTC+8) a Date built from LOCAL calendar fields — e.g.
// `new Date(y, m, d)` = 2026-07-29T00:00+08:00 = 2026-07-28T16:00Z — formats as
// the PREVIOUS day. That produced wrong dates on guest-visible folio lines and
// made the night audit pull arrivals/departures/revenue for the wrong business
// day.
//
// The frontend already solved this in web/src/lib/date.js. This is the backend
// counterpart, kept deliberately parallel to it.
//
// TWO DISTINCT CONVENTIONS, DELIBERATELY SEPARATE
// -----------------------------------------------
// 1. BUSINESS DAY (audit businessDate, arrivals/departures "today"):
//    a local calendar day in the property's timezone. Use startOfLocalDay() to
//    build it and localDay() to format it. NEVER toISOString() it.
//
// 2. DATE-ONLY KEYS (InventoryHold.date — "the night of the 5th"):
//    stored at UTC midnight so the value is timezone-stable and comparable
//    across services regardless of container TZ. Use utcDayStart() / eachNight().
//
// Mixing these two is what put the reservation and audit services 8 hours out of
// phase. Pick the one that matches the concept and stay in it.

// ── Convention 1: local business days ────────────────────────────────────────

// 'YYYY-MM-DD' for the given date in LOCAL time. Safe replacement for
// `d.toISOString().slice(0, 10)` anywhere a human-facing or business-day key is
// wanted.
function localDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) throw new TypeError('localDay: invalid date');
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Date at LOCAL midnight for the day containing `d`. This is the canonical
// businessDate value.
function startOfLocalDay(d) {
  const x = d instanceof Date ? new Date(d.getTime()) : new Date(d);
  if (Number.isNaN(x.getTime())) throw new TypeError('startOfLocalDay: invalid date');
  x.setHours(0, 0, 0, 0);
  return x;
}

// Parse a 'YYYY-MM-DD' string to LOCAL midnight. `new Date('2026-07-29')` parses
// as UTC midnight, which is 08:00 local — off by a day at the boundary. This
// parses the calendar fields explicitly instead.
function parseLocalDay(s) {
  if (s instanceof Date) return startOfLocalDay(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) throw new TypeError(`parseLocalDay: expected YYYY-MM-DD, got ${s}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

// End of the local day (exclusive upper bound for a `lt` range filter).
function endOfLocalDay(d) {
  const start = startOfLocalDay(d);
  start.setDate(start.getDate() + 1);
  return start;
}

// Half-open [start, end) bounds for the local day containing `d`. Use with
// Prisma as `{ gte: start, lt: end }`.
function localDayBounds(d) {
  const start = startOfLocalDay(d ?? new Date());
  return { start, end: endOfLocalDay(start) };
}

// ── Convention 2: timezone-stable date-only keys ─────────────────────────────

// Midnight UTC for the calendar day of `d`, read from its LOCAL fields. Used for
// date-only columns (InventoryHold.date) so "the night of the 5th" is one exact
// instant no matter what TZ the writing container ran in.
function utcDayStart(d) {
  // A 'YYYY-MM-DD' string must NOT go through local calendar fields: parsing it
  // yields UTC midnight, and reading .getFullYear() etc. off that in a UTC+8
  // container gives the LOCAL day, which is the previous date for any input
  // carrying a time component. Writers use utcDayFromString, so a reader that
  // took the local-field path would query a different night than was written.
  if (typeof d === 'string') return utcDayFromString(d);
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) throw new TypeError('utcDayStart: invalid date');
  return new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()));
}

// Same, but from a 'YYYY-MM-DD' string, with no local-timezone round trip.
function utcDayFromString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) throw new TypeError(`utcDayFromString: expected YYYY-MM-DD, got ${s}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// 'YYYY-MM-DD' for a UTC-midnight date-only value. Correct to use toISOString()
// here — the value IS a UTC instant by construction.
function utcDayKey(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) throw new TypeError('utcDayKey: invalid date');
  return x.toISOString().slice(0, 10);
}

// The nights a stay occupies, as UTC-midnight Dates: [checkIn, checkOut).
// Checkout day is excluded — a guest arriving the 3rd and leaving the 5th
// occupies the nights of the 3rd and 4th.
//
// Iterates with UTC setters so it cannot drift across a DST boundary (the
// Philippines has no DST, but this code should not silently break if the
// property timezone ever changes).
function eachNight(checkIn, checkOut) {
  const start = checkIn instanceof Date ? utcDayStart(checkIn) : utcDayFromString(checkIn);
  const end = checkOut instanceof Date ? utcDayStart(checkOut) : utcDayFromString(checkOut);
  // Reject a pathological range rather than truncating it. Silently returning
  // the first 400 nights would produce a booking whose tail nights were never
  // capacity-checked — an oversell that looks like a success.
  const MAX_NIGHTS = 400;
  if ((end.getTime() - start.getTime()) / 86400000 > MAX_NIGHTS) {
    throw new RangeError(`eachNight: range exceeds ${MAX_NIGHTS} nights`);
  }
  const out = [];
  const cur = new Date(start.getTime());
  while (cur < end) {
    out.push(new Date(cur.getTime()));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// ── Shared arithmetic ───────────────────────────────────────────────────────

function addDays(d, n) {
  const x = d instanceof Date ? new Date(d.getTime()) : new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Nights between two dates; always at least 1 (a same-day stay is one night).
// Computed from UTC day starts so a same-calendar-day pair can never round to 0
// because of a clock-time difference.
function nightsBetween(checkIn, checkOut) {
  const a = checkIn instanceof Date ? utcDayStart(checkIn) : utcDayFromString(checkIn);
  const b = checkOut instanceof Date ? utcDayStart(checkOut) : utcDayFromString(checkOut);
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));
}

module.exports = {
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
};
