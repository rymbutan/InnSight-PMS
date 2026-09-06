// Resolves an arrivals range ('today' | 'week' | 'month') into the date window
// the reservation service is queried with.
//
// WHY UTC DAYS, NOT LOCAL DAYS
// ---------------------------
// Reservation.checkIn is written as `new Date('YYYY-MM-DD')` — UTC midnight,
// Convention 2 in lib/date.js. The arrivals endpoint used to compare those
// values against localDayBounds(), mixing the two conventions that file
// explicitly warns about. It happens not to misfire at UTC+8 because the offset
// is positive, but it is wrong in principle and breaks outright west of
// Greenwich. Build the window in the same convention the values are stored in.
//
// WHY ROLLING WINDOWS
// -------------------
// 'week' is the next 7 days, not "until Sunday". The desk's question is "who is
// coming in the next week", and a calendar week answers that with one day of
// data on a Saturday.

const { utcDayStart, utcDayKey } = require('./date');

const ARRIVAL_RANGES = ['today', 'week', 'month'];

const SPAN_DAYS = { today: 1, week: 7, month: 30 };

// Adding whole days in MILLISECONDS rather than with setDate(), so the
// arithmetic stays in UTC. setDate() reads and writes LOCAL calendar fields,
// which on a UTC-midnight value in a UTC+8 container reads as the previous day
// and lands the result one day early.
const DAY_MS = 86400000;

// WHY OVERDUE DEPENDS ON WHETHER `range` WAS ASKED FOR
// ---------------------------------------------------
// Overdue rows have no lower bound: they are every CONFIRMED reservation from
// the beginning of time that never checked in, and they accumulate until a
// night audit sweeps them into NO_SHOW. That is exactly right for the Arrivals
// PAGE, which is a worklist and always sends a range. It is wrong for a caller
// that just asks "/api/arrivals" and puts the count in a tile labelled
// "Arrivals" next to a strictly-today "Departures" — that tile read 14 on a
// day with no arrivals at all.
//
// So the two questions are separated by whether the caller named a range. No
// range means "today", literally: the same answer that endpoint gave before
// overdue rows existed. An explicitly requested range still carries them.
//
// An empty `?range=` is not a range: it names nothing, so it is treated as no
// range at all rather than as a request for the worklist.
function arrivalsWindow(range, now = new Date()) {
  const asked = typeof range === 'string' && range.trim() !== '';
  const normalised = String(range || '').toLowerCase();
  const resolved = ARRIVAL_RANGES.includes(normalised) ? normalised : 'today';

  const start = utcDayStart(now);
  const end = new Date(start.getTime() + SPAN_DAYS[resolved] * DAY_MS);

  return {
    range: resolved,
    checkInFrom: utcDayKey(start),
    checkInTo: utcDayKey(end),
    // Anything due before today and still not arrived. Same for every range —
    // an overdue arrival is a problem the desk must see whichever view is open.
    overdueBefore: utcDayKey(start),
    includeOverdue: asked,
  };
}

module.exports = { arrivalsWindow, ARRIVAL_RANGES };
