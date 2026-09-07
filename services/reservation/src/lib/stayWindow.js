// Turning a booking's two DATES into the two TIMESTAMPS the room is actually held for.
//
// Reservation.checkIn/checkOut have always been timestamps, and the exclusion
// constraint that prevents double-booking compares them as a range:
//
//   EXCLUDE USING gist ("assignedRoomId" WITH =, tsrange("checkIn","checkOut",'[)') WITH &&)
//
// But every row stored midnight for both ends, so the model was really
// night-based and the times on it carried no information. That worked — with
// both ends at 00:00 a back-to-back pair does not overlap — while making two
// things impossible: showing a guest when their room is actually ready, and
// catching a booking that starts before the previous guest has left.
//
// So the property's service times get stamped on. The dates are untouched, and
// nights are still counted from calendar dates by lib/date.js (nightsBetween and
// eachNight both normalise to a day start), so nothing about billing or the
// per-night inventory holds changes. What changes is that the range now means
// what it says.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// The near-universal hotel shape: out in the morning, in in the afternoon, with
// the gap between belonging to housekeeping. Matches HOTEL_DEFAULTS in the folio
// service's lib/settings.js — the configured values live there.
const DEFAULT_SERVICE_TIMES = { checkInTime: '14:00', checkOutTime: '12:00' };

function partsOf(hhmm, fallback) {
  const m = HHMM.exec(String(hhmm ?? ''));
  if (m) return { h: Number(m[1]), min: Number(m[2]) };
  return partsOf(fallback, '00:00');
}

// Replace the clock on a date without touching its calendar day. UTC throughout,
// because that is how every other date helper in this service reads a row.
function atTime(value, hhmm, fallback) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return value; // let the route's own validation report it
  const { h, min } = partsOf(hhmm, fallback);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min, 0, 0)
  );
}

/**
 * @param   {object} args
 * @param   {Date|string} args.checkIn        date or timestamp; only the DATE is used
 * @param   {Date|string} args.checkOut
 * @param   {string} [args.checkInTime]       'HH:MM'; defaults to 14:00
 * @param   {string} [args.checkOutTime]      'HH:MM'; defaults to 12:00
 * @returns {{checkIn: Date|any, checkOut: Date|any}}
 */
function stampWindow({ checkIn, checkOut, checkInTime, checkOutTime } = {}) {
  return {
    checkIn: atTime(checkIn, checkInTime, DEFAULT_SERVICE_TIMES.checkInTime),
    checkOut: atTime(checkOut, checkOutTime, DEFAULT_SERVICE_TIMES.checkOutTime),
  };
}

module.exports = { stampWindow, DEFAULT_SERVICE_TIMES };
