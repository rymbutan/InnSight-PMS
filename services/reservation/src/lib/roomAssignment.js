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

// A stay with no known departure (a walk-in that never gave one, or a guest who
// has overstayed their expected check-out) is assumed to still be in the room
// for this long. Long enough to keep today's and tomorrow's arrivals out of a
// room somebody is standing in; short enough that one forgotten check-out does
// not hide the room from bookings weeks away.
const OPEN_ENDED_STAY_MS = 24 * 3600000;

/**
 * Which of `roomIds` is physically occupied by an in-house STAY during
 * [checkIn, checkOut).
 *
 * Room.status cannot answer this (it is deliberately ignored — see the header)
 * and the Reservation table cannot either: a walk-in has no reservation row, so
 * nothing there records that the room is taken. The Stay does.
 *
 * A stay backed by a reservation and carrying no expected check-out is skipped:
 * its booking already holds the room for exactly the nights it is paid for, and
 * counting it again here would block the room for the next arrival on the day
 * the guest is due to leave.
 *
 * @param {object[]} stays   IN_HOUSE stays (assignedRoomId, actualCheckInAt, expectedCheckOut, reservationId)
 * @param {string[]} roomIds rooms under consideration
 * @param {string|Date} checkIn
 * @param {string|Date} checkOut
 * @param {number} [now]
 * @returns {Set<string>} room ids that are occupied over the window
 */
function roomsBlockedByStays(stays, roomIds, checkIn, checkOut, now = Date.now()) {
  const ci = new Date(checkIn).getTime();
  const co = new Date(checkOut).getTime();
  const wanted = new Set(roomIds);
  const blocked = new Set();
  for (const s of stays || []) {
    if (!s || !wanted.has(s.assignedRoomId)) continue;
    const expected = s.expectedCheckOut ? new Date(s.expectedCheckOut).getTime() : null;
    if (expected === null && s.reservationId) continue;
    const start = s.actualCheckInAt ? new Date(s.actualCheckInAt).getTime() : 0;
    const end = expected !== null && expected > now ? expected : now + OPEN_ENDED_STAY_MS;
    if (start < co && end > ci) blocked.add(s.assignedRoomId);
  }
  return blocked;
}

// How many times a create may re-pick a room after losing the exclusion
// constraint race to a concurrent booking. Two other bookings taking our first
// two choices in the same instant is already implausible; a third means
// something is wrong that retrying will not fix.
const MAX_ASSIGN_ATTEMPTS = 3;

/**
 * Every room of `roomTypeCode` that nothing else holds over
 * [checkIn, checkOut) — the full free set, in inventory's preference order
 * (lowest floor, then lowest number).
 *
 * This is the same two-step check pickAssignableRoom uses (inventory's
 * physically-usable candidates, minus whichever of them a Reservation already
 * holds for an overlapping window) — pulled out so a caller that needs the
 * WHOLE free list (a room picker a human chooses from, not just "give me
 * one") reads the identical answer auto-assignment would have picked from,
 * rather than a second, easily-drifting implementation of "is this room
 * free". See NewReservation.jsx's per-pick room dropdown, which used to list
 * every room of the type with no date-overlap check at all — excluding only
 * OUT_OF_ORDER — so a room already booked by someone else for the exact
 * dates being entered, or one a guest is physically standing in right now,
 * showed up as a normal, selectable choice.
 *
 * @param {object} args
 * @param {object} args.inventory              inventory client (needs roomCandidates)
 * @param {object} args.prisma
 * @param {string} args.roomTypeCode
 * @param {string|Date} args.checkIn
 * @param {string|Date} args.checkOut
 * @param {string} [args.excludeReservationId] ignore this booking's own row (moves)
 * @param {string[]} [args.excludeRoomIds]     rooms to leave out regardless
 * @param {object} [args.stayClient]           stay client (needs inHouseStays); when given,
 *   rooms a guest is physically occupying over the window are left out too. A
 *   stay-service outage is logged and skipped — the booking path must not be
 *   refused for it, and check-in re-verifies the room against the Stay table.
 * @returns {Promise<string[]>} room ids, inventory's preference order — empty
 *   (not thrown) if inventory could not be reached, so a caller populating a
 *   picker shows "none available" rather than crashing the page.
 */
async function freeRoomIds({
  inventory,
  prisma,
  roomTypeCode,
  checkIn,
  checkOut,
  excludeReservationId,
  excludeRoomIds = [],
  stayClient,
}) {
  let candidates;
  try {
    candidates = await inventory.roomCandidates({ roomTypeCode, checkIn, checkOut });
  } catch (err) {
    console.error(
      `[Reservation] Could not list rooms of type ${roomTypeCode}: ${err.message}.`
    );
    return [];
  }

  const skip = new Set(excludeRoomIds);
  const ids = (candidates || []).map((r) => r?.id).filter((id) => id && !skip.has(id));
  if (!ids.length) return [];

  const taken = await prisma.reservation.findMany({
    where: overlappingRoomsWhere({ roomIds: ids, checkIn, checkOut, excludeReservationId }),
    select: { assignedRoomId: true },
  });
  const busy = new Set(taken.map((r) => r.assignedRoomId));

  // Rooms a guest is standing in right now. The overlap query above only sees
  // reservations, so a walk-in — or an overstay — was invisible to it, and the
  // room was handed to a booking whose check-in then failed.
  if (stayClient) {
    try {
      const stays = await stayClient.inHouseStays();
      for (const id of roomsBlockedByStays(stays, ids, checkIn, checkOut)) busy.add(id);
    } catch (err) {
      console.error(`[Reservation] Could not check in-house stays for room assignment: ${err.message}`);
    }
  }
  return ids.filter((id) => !busy.has(id));
}

/**
 * The first room of `roomTypeCode` that nothing else holds over
 * [checkIn, checkOut), or null if there is none. Auto-assignment's own entry
 * point — see freeRoomIds above for the check this picks from.
 *
 * @param {object} args  same shape as freeRoomIds
 * @returns {Promise<string|null>} room id
 */
async function pickAssignableRoom(args) {
  // `ids` order is inventory's preference order, so the first entry is the
  // room a human would have picked.
  const ids = await freeRoomIds(args);
  return ids[0] || null;
}

/**
 * Is `roomId` actually free for [checkIn, checkOut)? Auto-assignment already
 * only ever proposes a room from this same free set — but a STAFF-CHOSEN room
 * (the wizard's per-pick dropdown, or a PATCH that reassigns one) went straight
 * into the database with no server-side check at all beyond the exclusion
 * constraint, which only rejects a room already held by another RESERVATION.
 * It has no idea a walk-in (no reservation row at all) is sitting in that room
 * right now — inventory's OCCUPIED status is what carries that fact, and
 * `freeRoomIds` already reads it. Reusing it here, rather than trusting the
 * client, is what makes an explicit pick and an auto-assign agree on what
 * "free" means.
 *
 * @param {object} args  same shape as freeRoomIds, plus
 * @param {string} args.roomId  the room being requested
 * @returns {Promise<boolean>}
 */
async function isRoomFree(args) {
  const ids = await freeRoomIds(args);
  return ids.includes(args.roomId);
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

module.exports = {
  pickAssignableRoom,
  freeRoomIds,
  isRoomFree,
  normaliseRoomId,
  roomsBlockedByStays,
  MAX_ASSIGN_ATTEMPTS,
};
