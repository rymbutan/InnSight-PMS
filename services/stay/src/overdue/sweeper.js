const prisma = require('../lib/prisma');
const { makeServiceCaller } = require('../lib/serviceCall');
const { utcDayStart, utcDayKey } = require('../lib/date');

// ─────────────────────────────────────────────────────────────────────────────
// OVERDUE BOOKINGS — cancelled automatically, and no longer checkable.
//
// WHAT "OVERDUE" MEANS HERE
// -------------------------
// A reservation whose check-in day is strictly BEFORE today and which never
// arrived. Exactly the set the Arrivals page already flags with an Overdue
// badge (see the `overdue` field in routes/stay.routes.js) — this is that same
// boundary, now acted on instead of only displayed.
//
// A guest due TODAY is never touched, however late in the day it is. Late
// arrivals are ordinary — a delayed flight lands at 23:40 and the desk checks
// them in — and cancelling those would be the system inventing a no-show.
//
// WHY A SWEEP AND NOT THE NIGHT AUDIT
// -----------------------------------
// The night audit already does this at day close (mark_no_shows and
// auto_cancel_overdue in services/audit). The problem was the twelve hours in
// between: a booking from three days ago sat on the arrivals worklist with a
// live Check-in button on it, and pressing it started a stay against a booking
// nobody was ever going to honour. The audit is the right place for end-of-day
// reconciliation; it is the wrong place for "this cannot be checked in".
//
// Both remain. After a sweep the audit's steps find nothing left to do, which
// is the correct outcome for an idempotent step, not a broken one.
//
// WHY CANCEL RATHER THAN NO-SHOW THE RESERVATION
// ----------------------------------------------
// Financially they land in the same place: cancellationFeeCents() puts anything
// whose check-in has already passed in the 100%-forfeiture tier, which is what
// the no-show path applies too. Cancelling says the plainer thing to the desk,
// and it is what the reservation record already has fields for
// (cancellationNumber, cancellationReason, cancelledAt).
//
// The STAY row, where one exists, is still marked NO_SHOW: operationally the
// guest did not turn up, and that is a different fact from the booking being
// dead. It is written directly rather than by publishing `stay:no_show`,
// because that event makes the reservation service set the reservation to
// NO_SHOW — which would race this sweep's own cancellation for the same row.
// ─────────────────────────────────────────────────────────────────────────────

const RESERVATION_URL = process.env.RESERVATION_URL || 'http://reservation-service:3011';

// MANAGER, because POST /api/reservations/:id/cancel is requireRole(...STAFF)
// and this is the narrowest staff role that clears it. Nothing here reads a
// folio or a guest profile, so no permission beyond the reservation is claimed.
const reservationAdmin = makeServiceCaller({
  name: 'stay',
  roles: ['MANAGER'],
  permissions: ['reservation.read', 'reservation.write'],
});

// Statuses that mean the guest turned up after all. Same set the arrivals
// endpoint excludes on.
const ARRIVED = new Set(['IN_HOUSE', 'DEPARTED']);

const REASON = 'Overdue — auto-cancelled (guest did not arrive)';

// One pass. Returns a summary rather than logging it, so the caller decides
// whether a quiet sweep is worth a line in the log.
async function sweepOverdue() {
  // utcDayKey/utcDayStart, not a local day: Reservation.checkIn is stored at UTC
  // midnight (Convention 2 in lib/date.js) and lib/arrivalsWindow.js builds the
  // very same boundary. Mixing in a local day here would move the cutoff by the
  // timezone offset and cancel a booking due today.
  const todayKey = utcDayKey(utcDayStart(new Date()));

  const cancelled = [];
  const failed = [];

  for (const status of ['CONFIRMED', 'PENDING']) {
    // `checkInTo` is an EXCLUSIVE upper bound (see reservation's lib/listQuery.js),
    // so today's key means "due strictly before today".
    const url = `${RESERVATION_URL}/api/reservations?status=${status}&checkInTo=${todayKey}`;
    let list;
    try {
      list = await reservationAdmin.call(url);
    } catch (err) {
      // The reservation service being unreachable is not a reason to do
      // anything drastic — skip this pass and try again in fifteen minutes.
      console.error(`[Stay] Overdue sweep: could not list ${status} reservations: ${err.message}`);
      continue;
    }
    if (!Array.isArray(list) || list.length === 0) continue;

    // One query for every stay involved rather than one per reservation.
    const stays = await prisma.stay.findMany({
      where: { reservationId: { in: list.map((r) => r.id) } },
    });
    const stayByReservation = new Map(stays.map((s) => [s.reservationId, s]));

    for (const r of list) {
      const stay = stayByReservation.get(r.id) || null;
      // The guest arrived after all — not overdue, whatever the reservation
      // status says. The reservation service normally moves to CHECKED_IN on
      // the check-in event, but that is an event and events can be missed;
      // the local stay row is the fact this service owns.
      if (stay && ARRIVED.has(stay.status)) continue;

      try {
        if (stay && stay.status === 'PRE_ARRIVAL') {
          await prisma.stay.update({ where: { id: stay.id }, data: { status: 'NO_SHOW' } });
        }
        await reservationAdmin.call(`${RESERVATION_URL}/api/reservations/${r.id}/cancel`, {
          method: 'POST',
          // A string, not an object: serviceCall spreads `options` straight
          // into fetch(), so an object body would be sent as "[object Object]".
          body: JSON.stringify({ reason: REASON }),
        });
        cancelled.push({ id: r.id, confirmationNumber: r.confirmationNumber, guestName: r.guestName });
      } catch (err) {
        // A reservation that cannot be cancelled stays on the list and is
        // retried next pass. Logged individually: one bad row must not stop
        // the sweep clearing the rest.
        failed.push({ id: r.id, error: err.message });
      }
    }
  }

  // NO EVENT IS PUBLISHED HERE, deliberately.
  //
  // The desk does get told — POST /api/reservations/:id/cancel already
  // publishes `reservation:cancelled`, carrying the guest name, the
  // confirmation number and REASON below, which is what appears in the
  // notification. An extra `reservation:auto_cancelled` alongside it produced
  // two cards for one cancellation, and the second said nothing the first had
  // not. The reason text is what distinguishes an automatic cancellation from
  // one somebody made.

  return { cancelled, failed };
}

// Fifteen minutes. The desk cannot check an overdue booking in either way —
// POST /api/check-in refuses it outright — so this interval governs only how
// quickly the row leaves the worklist, not whether the rule holds.
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// Long enough after boot for the reservation service to be answering. A failed
// first pass is harmless (it retries), but a clean startup log is worth the wait.
const FIRST_SWEEP_DELAY_MS = 30 * 1000;

function startOverdueSweeper(intervalMs = SWEEP_INTERVAL_MS) {
  const tick = async () => {
    try {
      const { cancelled, failed } = await sweepOverdue();
      if (cancelled.length) {
        console.log(`[Stay] Overdue sweep auto-cancelled ${cancelled.length} booking(s).`);
      }
      if (failed.length) {
        console.error(`[Stay] Overdue sweep could not cancel ${failed.length}:`, failed);
      }
    } catch (err) {
      console.error('[Stay] Overdue sweep failed:', err.message);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const first = setTimeout(tick, FIRST_SWEEP_DELAY_MS);
  first.unref?.();
  return timer;
}

// Is this reservation past its check-in day and therefore not checkable? Used by
// POST /api/check-in, which is the boundary that actually holds — the sweep only
// decides how quickly the row disappears.
function isOverdue(checkIn, now = new Date()) {
  if (!checkIn) return false;
  return utcDayKey(utcDayStart(new Date(checkIn))) < utcDayKey(utcDayStart(now));
}

module.exports = { sweepOverdue, startOverdueSweeper, isOverdue, REASON };
