// Turning bookings into calendar bars.
//
// Extracted out of pages/Calendar.jsx because this is where the reported bug
// lived and none of it was testable inside a component: a reservation that
// saved correctly, confirmed correctly, and appeared nowhere on the board.
//
// TWO SEPARATE LENGTHS, AND WHY BOTH ARE KEPT
// -------------------------------------------
//   `nights` is the true length of the stay.
//   `span`   is how many columns of the CURRENT window it occupies.
//
// They differ whenever a stay crosses an edge of the window, and conflating
// them is how a two-week booking either overflowed the grid or was drawn as
// though it were shorter than it is. The bar is drawn with `span`; anything
// telling the user about the stay uses `nights`.
//
// NOTHING IS EVER DROPPED SILENTLY
// --------------------------------
// A booking with no room cannot go on a room row — the grid is rooms x nights.
// It is returned in `unassigned` instead of being skipped, so the page can say
// so. Skipping it is exactly the bug this module was written to end.

import { localDay, startOfDay, addDays } from './date.js';

// Statuses whose booking no longer occupies anything. Matches the exclusion
// list on the Reservation_no_double_booking constraint and in the reservation
// service's lib/listQuery.js, so all three agree on what "released" means.
const RELEASED_STATUSES = ['CANCELLED', 'NO_SHOW'];

const MS_PER_DAY = 86400000;

function dayIndexOf(date) {
  return Math.round(startOfDay(date).getTime() / MS_PER_DAY);
}

/**
 * @param {object} args
 * @param {object[]} [args.reservations]
 * @param {object[]} [args.stays]        in-house stays, which supersede their reservation
 * @param {object[]} [args.rooms]
 * @param {Date[]} args.days            one local-midnight Date per column
 * @returns {{ byRoom: Record<string, object[]>, unassigned: object[] }}
 */
export function buildBars({ reservations = [], stays = [], rooms = [], days }) {
  const byRoom = {};
  const unassigned = [];
  if (!days?.length) return { byRoom, unassigned };

  // Whole days since the epoch, so column arithmetic is integer subtraction and
  // cannot drift on a fractional millisecond.
  const winStart = dayIndexOf(days[0]);
  const winEnd = dayIndexOf(addDays(days[days.length - 1], 1));

  function makeBar({ roomId, key, label, status, ci, co, balanceDue, guestId }) {
    const start = dayIndexOf(new Date(ci));
    const end = dayIndexOf(new Date(co));
    // A same-day arrival and departure is still one night on the board.
    const nights = Math.max(1, end - start);
    // Half-open: checking out on the window's first day frees that night, so
    // that booking does not belong to this window at all.
    if (end <= winStart || start >= winEnd) return null;
    const clipStart = Math.max(start, winStart);
    const clipEnd = Math.min(end, winEnd);
    return {
      key,
      label,
      status,
      guestId,
      roomId,
      startCol: clipStart - winStart,
      span: Math.max(1, clipEnd - clipStart),
      nights,
      ci,
      co,
      balanceDue,
      // True when the stay is cut off by an edge, so the bar can show that it
      // continues rather than looking like it ends there.
      continuesBefore: start < winStart,
      continuesAfter: end > winEnd,
    };
  }

  function place(bar) {
    if (!bar) return;
    (byRoom[bar.roomId] = byRoom[bar.roomId] || []).push(bar);
  }

  // In-house stays first: a stay is the live truth about a guest who has
  // arrived, and it supersedes the reservation it came from.
  for (const s of stays) {
    const bar = makeBar({
      roomId: s.assignedRoomId,
      key: `stay-${s.id}`,
      label: s.guestName || 'Guest',
      status: (s.status || 'IN_HOUSE').toLowerCase(),
      ci: s.actualCheckInAt || s.expectedCheckIn,
      co: s.expectedCheckOut,
      balanceDue: false,
      guestId: s.guestId,
    });
    if (!bar) continue;
    if (s.assignedRoomId) place(bar);
    else unassigned.push(bar);
  }

  const stayedReservationIds = new Set(stays.map((s) => s.reservationId).filter(Boolean));

  for (const r of reservations) {
    if (RELEASED_STATUSES.includes(r.status)) continue;
    if (stayedReservationIds.has(r.id)) continue;
    const bar = makeBar({
      roomId: r.assignedRoomId,
      key: `res-${r.id}`,
      label: r.guestName || 'Reserved',
      status: (r.status || 'CONFIRMED').toLowerCase(),
      ci: r.checkIn,
      co: r.checkOut,
      balanceDue: Number(r.depositCents || 0) === 0,
      guestId: r.guestId,
    });
    if (!bar) continue;
    // An empty string is not a room id — see normaliseRoomId in the reservation
    // service. Treating it as one would draw a bar on a row that does not exist.
    if (r.assignedRoomId) place(bar);
    else unassigned.push(bar);
  }

  // A room out of order is a room STATE, not a guest, and blocks the full window.
  for (const rm of rooms) {
    if (rm.status !== 'OUT_OF_ORDER') continue;
    place(
      makeBar({
        roomId: rm.id,
        key: `ooo-${rm.id}`,
        label: 'OOO',
        status: 'ooo',
        ci: localDay(days[0]),
        co: localDay(addDays(days[days.length - 1], 1)),
        balanceDue: false,
      })
    );
  }

  // Left to right within a row, so reading order matches the calendar.
  for (const bars of Object.values(byRoom)) bars.sort((a, b) => a.startCol - b.startCol);

  return { byRoom, unassigned };
}
