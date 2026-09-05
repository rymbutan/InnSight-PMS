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

function arrivalsWindow(range, now = new Date()) {
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
  };
}

module.exports = { arrivalsWindow, ARRIVAL_RANGES };
