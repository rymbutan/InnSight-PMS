// Turning a room-TYPE booking into a room-ROW booking.
//
// WHY THIS EXISTS
// ---------------
// The calendar is a grid of rooms x nights, so a bar can only be drawn on a
// physical room's row. A reservation with no assignedRoomId has no row and is
// therefore drawn nowhere at all.
//
// The booking wizard offered "Auto-assign" as its DEFAULT room choice, and
// nothing anywhere in the system implemented it — the option was a label with
// no code behind it. Every booking taken the ordinary way was saved, confirmed,
// invoiced, and invisible on the board.
//
// DIVISION OF OWNERSHIP
// ---------------------
// Inventory owns rooms and room-type capacity. This service owns which booking
// holds which room, because assignedRoomId lives in this database and inventory
// cannot see it. So:
//
//   inventory  →  the ordered list of physically usable rooms of the type
//   here       →  "is any of them already promised for these nights?"
//
// Candidates arrive ordered the way front-desk staff pick rooms: lowest floor
// first, then lowest room number.
//
// WHY A ROOM IS ONLY EXCLUDED FOR OUT_OF_ORDER / OUT_OF_SERVICE
// -------------------------------------------------------------
// Room.status is a statement about the room RIGHT NOW. A room that is OCCUPIED
// or DIRTY tonight is a perfectly good room for a booking three weeks out, and
// filtering on it would refuse to assign most of next month. Whether a room is
// free for a DATE RANGE is a question about reservations, and that is the
// overlap query below.
//
// BEST-EFFORT BY DESIGN
// ---------------------
// Capacity has already been granted by the inventory hold before this runs. A
// booking must therefore never be refused because room selection came up empty:
// the guest is booked either way and the front desk assigns a room later. This
// returns null in that case, and the caller logs it.

const { overlappingRoomsWhere } = require('./listQuery');

// How many times a create may re-pick a room after losing the exclusion
// constraint race to a concurrent booking. Two other bookings taking our first
// two choices in the same instant is already implausible; a third means
// something is wrong that retrying will not fix.
const MAX_ASSIGN_ATTEMPTS = 3;

/**
 * The first room of `roomTypeCode` that nothing else holds over
 * [checkIn, checkOut), or null if there is none.
 *
 * @param {object} args
 * @param {object} args.inventory              inventory client (needs roomCandidates)
 * @param {object} args.prisma
 * @param {string} args.roomTypeCode
 * @param {string|Date} args.checkIn
 * @param {string|Date} args.checkOut
 * @param {string} [args.excludeReservationId] ignore this booking's own row (moves)
 * @param {string[]} [args.excludeRoomIds]     rooms already tried and lost
 * @returns {Promise<string|null>} room id
 */
async function pickAssignableRoom({
  inventory,
  prisma,
  roomTypeCode,
  checkIn,
  checkOut,
  excludeReservationId,
  excludeRoomIds = [],
}) {
  let candidates;
  try {
    candidates = await inventory.roomCandidates({ roomTypeCode, checkIn, checkOut });
  } catch (err) {
    // Inventory being unreachable must not fail a booking whose capacity is
    // already held. Leave the room unassigned and say so loudly.
    console.error(
      `[Reservation] Could not list rooms of type ${roomTypeCode} for auto-assignment: ${err.message}. ` +
        'The booking will be taken with no room assigned.'
    );
    return null;
  }

  const skip = new Set(excludeRoomIds);
  const ids = (candidates || []).map((r) => r?.id).filter((id) => id && !skip.has(id));
  if (!ids.length) return null;

  const taken = await prisma.reservation.findMany({
    where: overlappingRoomsWhere({ roomIds: ids, checkIn, checkOut, excludeReservationId }),
    select: { assignedRoomId: true },
  });
  const busy = new Set(taken.map((r) => r.assignedRoomId));
  // `ids` order is inventory's preference order, so `find` picks the room a
  // human would have picked.
  return ids.find((id) => !busy.has(id)) || null;
}

/**
 * Normalise a client-supplied room id.
 *
 * '' is not the same as "no room": it is NOT NULL as far as the
 * Reservation_no_double_booking exclusion constraint is concerned, so every
 * unassigned booking collided on the phantom room '' and the second one taken
 * for overlapping dates was refused with "that room is already booked".
 *
 * The wizard sends '' whenever a user opens the room dropdown and returns it to
 * the default, so this was reachable from the ordinary booking flow.
 */
function normaliseRoomId(value) {
  if (typeof value !== 'string') return value == null ? null : value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

module.exports = { pickAssignableRoom, normaliseRoomId, MAX_ASSIGN_ATTEMPTS };
