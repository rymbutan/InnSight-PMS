// Filter construction for GET /api/reservations.
//
// WHY A DATE WINDOW IS AN OVERLAP TEST, NOT A `checkIn` RANGE
// -----------------------------------------------------------
// A booking is a RANGE of nights, not a point in time. The calendar asks "what
// touches these fourteen nights?" — but this route used to answer a different
// question:
//
//     checkIn >= from AND checkIn <= to        // "which bookings START here"
//
// So a guest arriving on the 1st for ten nights was returned only while the
// window happened to contain the 1st. Page the calendar forward one week and
// the booking was gone: saved in the database, drawn nowhere. The longer the
// stay, the more of it was invisible — which is why this looked like "long
// reservations don't show up".
//
// For half-open night ranges [checkIn, checkOut) the correct overlap test is:
//
//     checkIn < to AND checkOut > from
//
// Both edges are deliberate, and both match how hotel nights work:
//   - a booking that checks OUT on `from` released that night → excluded
//   - a booking that checks IN on the window's last night      → included
//
// `from`/`to` accept 'YYYY-MM-DD' (the calendar) or a full ISO timestamp (the
// night audit's no-show sweep). Both are parsed by `new Date`, which reads a
// bare date as UTC midnight — the same convention checkIn/checkOut are written
// with, so the comparison never lands half a day out.

// Statuses that no longer hold a room. Kept as an exclusion list, not an
// inclusion list, so a status added to the enum later counts as "occupying" by
// default — the same direction of failure as the Reservation_no_double_booking
// constraint, which excludes exactly these three.
const RELEASED_STATUSES = ['CANCELLED', 'NO_SHOW', 'CHECKED_OUT'];

class BadWindowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadWindowError';
    this.statusCode = 400;
  }
}

// An unparseable bound used to sail through as an Invalid Date, and every
// comparison against one is false — so a typo in the query string produced an
// empty calendar rather than an error, which is indistinguishable from "no
// bookings" to the person looking at the screen.
function parseBound(value, label) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadWindowError(`${label} is not a valid date.`);
  return d;
}

/**
 * Build the Prisma `where` for the reservation list.
 * @throws {BadWindowError} on an unparseable `from`/`to`
 */
function reservationListWhere({ status, guestId, assignedRoomId, from, to, q } = {}) {
  const where = {};
  if (status) where.status = status;
  if (guestId) where.guestId = guestId;
  // Housekeeping has always sent this filter and the route silently dropped it,
  // so "which booking is in room 412?" was answered with every booking in the
  // hotel and the caller picked the first plausible-looking one.
  if (assignedRoomId) where.assignedRoomId = assignedRoomId;
  if (to) where.checkIn = { lt: parseBound(to, 'to') };
  if (from) where.checkOut = { gt: parseBound(from, 'from') };
  if (q) {
    where.OR = [
      { confirmationNumber: { contains: q, mode: 'insensitive' } },
      { guestName: { contains: q, mode: 'insensitive' } },
      { guestEmail: { contains: q, mode: 'insensitive' } },
    ];
  }
  return where;
}

/**
 * Bookings that overlap [checkIn, checkOut) and still hold a room. Used both to
 * choose a room for a new booking and to validate a move.
 */
function overlappingRoomsWhere({ roomIds, checkIn, checkOut, excludeReservationId }) {
  return {
    assignedRoomId: { in: roomIds },
    status: { notIn: RELEASED_STATUSES },
    checkIn: { lt: new Date(checkOut) },
    checkOut: { gt: new Date(checkIn) },
    ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
  };
}

module.exports = { reservationListWhere, overlappingRoomsWhere, BadWindowError, RELEASED_STATUSES };
