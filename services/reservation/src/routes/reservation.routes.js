const express = require('express');
const crypto = require('crypto');
const Redis = require('ioredis');
const { requireRole, JWT_SECRET, ROLE_GROUPS } = require('../middleware/auth');
const { cancellationFeeCents, paymentProcessingFeeCents } = require('../lib/policies');
const { remainingDepositRefundCents } = require('../lib/depositRefund');
const { missingDepositField } = require('../lib/missingDepositField');
const { computeAddOns } = require('../lib/addOns');
const { makeInventoryClient, NoInventoryError, INVENTORY_URL } = require('../lib/inventoryClient');
const { nightsBetween: nightsBetweenDates, utcDayKey } = require('../lib/date');
const { reservationListWhere, BadWindowError } = require('../lib/listQuery');
const {
  pickAssignableRoom,
  freeRoomIds,
  isRoomFree,
  normaliseRoomId,
  MAX_ASSIGN_ATTEMPTS,
} = require('../lib/roomAssignment');
const { makeFolioClient } = require('../lib/folioClient');
const { makeStayClient } = require('../lib/stayClient');
const { stampWindow, DEFAULT_SERVICE_TIMES } = require('../lib/stayWindow');
const { send: sendMail, TEMPLATES } = require('../lib/notifier');
const storage = require('../lib/storage');

// Uploaded as base64 JSON rather than multipart: this is a capstone build, and
// a JSON body is trivially testable with the same request helper every other
// route in this file uses, at the cost of the usual ~33% base64 overhead.
// 10MB decoded is generous for a guest ID or a signed registration card.
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// Inventory owns capacity. Every write path in this file that creates or moves a
// booking must claim capacity through this client before committing.
const inventory = makeInventoryClient({ name: 'reservation', secret: JWT_SECRET });

// The property's check-in/check-out clock times, which get stamped onto every
// booking's stored window so the no-double-booking range means what it says.
// See lib/stayWindow.js.
const folio = makeFolioClient({ name: 'reservation' });

// A Stay lives in a different database, so "is this guest already checked
// in?" isn't a question this service's own tables can answer — see
// guestBookingConflict below.
const stayClient = makeStayClient({ name: 'reservation' });

// Cached for a minute. These change about once in the life of a property, and a
// booking must not wait on a settings round trip — nor make one per attempt in
// the room-assignment retry loop. A failure serves the shipped defaults rather
// than refusing the booking: the wrong clock time on a held room is recoverable,
// a front desk that cannot take a booking is not.
let serviceTimesCache = { at: 0, value: DEFAULT_SERVICE_TIMES };
const SERVICE_TIMES_TTL_MS = 60_000;
async function serviceTimes() {
  if (Date.now() - serviceTimesCache.at < SERVICE_TIMES_TTL_MS) return serviceTimesCache.value;
  try {
    const t = await folio.getHotelTimes();
    const value = {
      checkInTime: t?.checkInTime || DEFAULT_SERVICE_TIMES.checkInTime,
      checkOutTime: t?.checkOutTime || DEFAULT_SERVICE_TIMES.checkOutTime,
    };
    serviceTimesCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    console.warn('[Reservation] Could not read service times, using defaults:', err.message);
    // Cache the fallback too, so a folio outage does not add a failed round trip
    // to every booking taken during it.
    serviceTimesCache = { at: Date.now(), value: DEFAULT_SERVICE_TIMES };
    return DEFAULT_SERVICE_TIMES;
  }
}

// Server-side deposit processing fee: 0 unless the method rides a gateway
// (CARD/BANK_TRANSFER), same rule as Folio's own POST /folios/:id/payments.
// Never trust a client-sent fee — this is the only place depositFeeCents is
// computed, whether the booking is created here or completed later via PATCH.
// Validate a promo code against inventory and return {code, percentOff}, or
// `false` for a code that definitively is not valid, or `null` when the lookup
// itself could not be completed.
//
// Those three outcomes are deliberately distinct. A staff booking must NOT
// silently fall back to full price on a code the agent has already quoted to the
// guest — that is a wrong number on a folio, discovered at checkout. So a
// definitively-bad code is rejected and the agent retypes it. A lookup that
// fails for infrastructure reasons is different: refusing the whole booking
// because one service is briefly unreachable is worse than booking at rack rate,
// which is exactly the trade-off the public path already makes.
async function validatePromo(code) {
  try {
    const r = await fetch(`${INVENTORY_URL}/api/public/promo/${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const p = await r.json();
    return p && p.valid ? { code: p.code, percentOff: p.percentOff } : false;
  } catch {
    return null;
  }
}

// A guest should not end up double-booked: already holding an overlapping
// active reservation, or already standing in a room somewhere right now.
// Returns a human-readable reason to refuse the booking, or null to allow it.
//
// The in-house check fails OPEN on a stay-service outage — refusing every
// booking in the hotel because a read to another service timed out is a worse
// failure than occasionally missing this one guard, which day-to-day desk
// process (and the room-level occupancy check in isRoomFree) still backs up.
async function guestBookingConflict({ guestId, checkIn, checkOut }) {
  if (!guestId) return null;

  const overlapping = await prisma.reservation.findFirst({
    where: {
      guestId,
      status: { in: ['CONFIRMED', 'PENDING'] },
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
    },
  });
  if (overlapping) {
    return (
      `This guest already has an overlapping reservation ` +
      `(${overlapping.confirmationNumber || overlapping.id.slice(0, 8)}).`
    );
  }

  let inHouse;
  try {
    inHouse = await stayClient.inHouseStaysForGuest(guestId);
  } catch (err) {
    console.error('[Reservation] Could not check in-house status for guest:', err.message);
    return null;
  }
  const conflict = (inHouse || []).some((s) => {
    const start = new Date(s.actualCheckInAt || s.expectedCheckIn || 0);
    const end = s.expectedCheckOut ? new Date(s.expectedCheckOut) : null;
    return start < checkOut && (!end || end > checkIn);
  });
  return conflict ? 'This guest is currently checked in and occupying a room for these dates.' : null;
}

async function depositFeeCentsFor(paymentType, depositCents) {
  if (paymentType !== 'CARD' && paymentType !== 'BANK_TRANSFER') return 0n;
  const feePercent = await folio.getPaymentFeePercent().catch(() => 0);
  return paymentProcessingFeeCents({ amountCents: BigInt(depositCents || 0), feePercent });
}

const STAFF = ['ADMIN', 'MANAGER', 'FRONT_DESK'];

// Mandatory Downpayment Constraint: a booking may not be created, nor moved to
// CONFIRMED, without a recorded downpayment against one of these methods.
// Mirrors web/src/lib/paymentMethods.js's PAYMENT_METHODS codes — the same
// list the front desk's payment dropdowns already offer, so nothing here can
// be rejected that the UI could not have submitted in the first place.
const VALID_DEPOSIT_PAYMENT_TYPES = ['CASH', 'CARD', 'E_WALLET', 'BANK_TRANSFER'];

// Upper bound on one page of the reservation list. A 14-night calendar window
// for a large property, plus the night audit's no-show sweep, both fit inside
// this comfortably; anything that reaches it is logged rather than quietly cut.
const LIST_LIMIT = 500;

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('error', (e) => console.error('[Reservation] redis error:', e.message));

// Non-sequential, non-enumerable identifiers (48 bits of entropy) so a
// confirmation number can't be guessed to reach the public lookup endpoint.
function nextConfirmationNumber() {
  return `R-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}
function nextCancellationNumber() {
  return `C-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

/**
 * Translate a database integrity violation into a meaningful HTTP response.
 *
 * The Reservation table carries an EXCLUDE USING gist constraint preventing two
 * live reservations from holding the same physical room over overlapping dates
 * (see migrations/20260729000100_no_double_booking). Postgres raises SQLSTATE
 * 23P01 for that, which Prisma surfaces as a raw/unknown request error — so
 * without this mapping a perfectly ordinary "that room is taken" collision was
 * reported to the front desk as an opaque 500.
 *
 * @returns {{status:number, error:string}|null} null if it isn't a constraint error
 */
function mapDbConstraintError(err) {
  const text = `${err?.message || ''} ${err?.meta?.message || ''} ${err?.meta?.code || ''}`;
  if (
    text.includes('23P01') ||
    text.includes('Reservation_no_double_booking') ||
    text.includes('exclusion constraint')
  ) {
    return {
      status: 409,
      error: 'That room is already booked for overlapping dates. Choose another room or adjust the dates.',
    };
  }
  if (
    text.includes('23514') ||
    text.includes('check constraint') ||
    text.includes('Reservation_sane_counts') ||
    text.includes('Reservation_checkout_after_checkin')
  ) {
    return { status: 400, error: 'The booking details are not valid (check dates, occupancy and amounts).' };
  }
  if (err?.code === 'P2002') {
    return { status: 409, error: 'That booking conflicts with an existing record.' };
  }
  return null;
}

// Did this error come from the physical-room exclusion constraint specifically?
// Auto-assignment retries on that and only that: it means a concurrent booking
// took the room we picked, which a different room solves.
function isRoomClashError(err) {
  const text = `${err?.message || ''} ${err?.meta?.message || ''} ${err?.meta?.code || ''}`;
  return (
    text.includes('23P01') ||
    text.includes('Reservation_no_double_booking') ||
    text.includes('exclusion constraint')
  );
}

async function logActivity(reservationId, user, action, summary, payload) {
  try {
    await prisma.reservationActivity.create({
      data: {
        reservationId,
        userId: user?.sub,
        userName: user?.username || user?.displayName,
        action,
        summary,
        payload: payload || undefined,
      },
    });
  } catch (e) {
    /* non-fatal */
  }
}

// GET /api/reservations/available-rooms?roomTypeCode=&checkIn=&checkOut=&excludeReservationId=
//
// The rooms of a type actually free for a date range — not "every room of
// this type that isn't OUT_OF_ORDER", which is what the New Reservation
// wizard's per-pick room dropdown used to list (web/src/pages/NewReservation.jsx).
// That list had NO date-overlap check at all, so a room already booked by
// someone else for the exact dates being entered showed up as a normal,
// selectable choice right next to "Auto-assign" — and picking one is exactly
// what caused guests to be booked into a room that was actually taken.
//
// Reuses freeRoomIds — the identical check auto-assignment itself picks
// from — so a human choosing from this list and the system choosing for
// them can never disagree about which rooms are free.
router.get('/reservations/available-rooms', requireRole(...STAFF), async (req, res) => {
  try {
    const { roomTypeCode, checkIn, checkOut, excludeReservationId } = req.query;
    if (!roomTypeCode || !checkIn || !checkOut) {
      return res.status(400).json({ error: 'roomTypeCode, checkIn, checkOut required.' });
    }
    const ci = new Date(checkIn);
    const co = new Date(checkOut);
    if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime()) || co <= ci) {
      return res.status(400).json({ error: 'checkOut must be after checkIn.' });
    }
    const ids = await freeRoomIds({
      inventory,
      prisma,
      roomTypeCode,
      checkIn: ci,
      checkOut: co,
      excludeReservationId: excludeReservationId || undefined,
    });
    res.json({ roomIds: ids });
  } catch (err) {
    console.error('[Reservation] Available rooms error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/reservations
router.post('/reservations', requireRole(...STAFF), async (req, res) => {
  try {
    const {
      guestId,
      guestName,
      guestEmail,
      guestPhone,
      roomTypeCode,
      ratePlanId,
      assignedRoomId,
      checkIn,
      checkOut,
      adults,
      children,
      source,
      totalEstimateCents,
      depositCents,
      specialRequests,
      promoCode,
      expectedArrivalTime,
      paymentType,
      ratePlan,
      origin,
      addOns: rawAddOns,
      isNonRefundable,
      // Per-method deposit detail, same request-body shape Folio's own
      // payment endpoint accepts (see missingDepositField.js).
      cardMasked,
      cardholderName,
      bankName,
      transferNetwork,
      senderName,
      gatewayRef,
      reference,
      transferredAt,
    } = req.body;

    if (!guestName || !roomTypeCode || !checkIn || !checkOut) {
      return res.status(400).json({ error: 'guestName, roomTypeCode, checkIn, checkOut required.' });
    }

    // Mandatory Downpayment Constraint: no booking is created without proof of
    // a required downpayment already settled. `depositCents` and `paymentType`
    // are both staff-entered at the same step (NewReservation.jsx's Step 5), so
    // this is a payload shape check, not a payment integration — the actual
    // charge is taken by the front desk before they submit.
    if (!(Number(depositCents) > 0) || !VALID_DEPOSIT_PAYMENT_TYPES.includes(paymentType)) {
      return res.status(400).json({
        error:
          'A downpayment is required to create a booking: depositCents must be greater than 0 and ' +
          `paymentType must be one of ${VALID_DEPOSIT_PAYMENT_TYPES.join(', ')}.`,
      });
    }

    // Same per-method requirements Folio holds a folio payment to (card needs
    // a masked number + cardholder, a bank transfer needs the bank/network/
    // sender/reference) — checked here so an incomplete deposit record can
    // never leave the wizard in the first place.
    const missingDeposit = missingDepositField(paymentType, req.body);
    if (missingDeposit) return res.status(400).json({ error: missingDeposit });

    const rawCi = new Date(checkIn);
    const rawCo = new Date(checkOut);
    if (Number.isNaN(rawCi.getTime()) || Number.isNaN(rawCo.getTime())) {
      return res.status(400).json({ error: 'checkIn and checkOut must be valid dates.' });
    }
    if (rawCo <= rawCi) {
      return res.status(400).json({ error: 'checkOut must be after checkIn.' });
    }
    // Nights come from the calendar dates, BEFORE the clock times go on, so what
    // the guest is billed for cannot move when the property changes its
    // check-out time.
    const nights = nightsBetweenDates(checkIn, checkOut);

    // Stamp the property's service times. Everything downstream — the capacity
    // hold, the room-assignment overlap query and the stored row — then works
    // from the same window, which is what makes "the previous guest has not left
    // yet" a detectable conflict.
    const { checkIn: ci, checkOut: co } = stampWindow({
      checkIn: rawCi,
      checkOut: rawCo,
      ...(await serviceTimes()),
    });

    // '' means "no room chosen", not "the room whose id is the empty string".
    // See normaliseRoomId — storing '' defeated the double-booking constraint's
    // IS NOT NULL guard and made unassigned bookings collide with each other.
    const requestedRoomId = normaliseRoomId(assignedRoomId);

    // A room the STAFF picked (as opposed to auto-assign, which only ever
    // proposes from this same free set) used to go straight into the
    // reservation with no server-side check at all — the exclusion constraint
    // below only catches a room another RESERVATION already holds, and has no
    // idea a walk-in with no reservation row is standing in it right now. This
    // is the actual bug behind "auto-assign still hands out an occupied room":
    // it wasn't auto-assign, it was the explicit-pick path skipping validation
    // entirely, most reachable through the wizard's per-pick dropdown while its
    // own availability fetch was still in flight.
    if (requestedRoomId && !(await isRoomFree({ inventory, prisma, roomTypeCode, checkIn: ci, checkOut: co, roomId: requestedRoomId }))) {
      return res.status(409).json({ error: 'That room is no longer available for the selected dates.' });
    }

    // A guest shouldn't come away from this with two overlapping bookings, or
    // a new reservation stacked on top of a stay they're already checked into.
    const guestConflict = await guestBookingConflict({ guestId, checkIn: ci, checkOut: co });
    if (guestConflict) return res.status(409).json({ error: guestConflict });

    // Authoritative pricing — never trust a client-supplied fee/total. The fee
    // percentage is read fresh here and frozen onto each add-on so a later
    // change to it never rewrites an already-booked guest's total.
    const feeSetting = await prisma.appSetting.findUnique({ where: { key: 'addon_fee_percent' } });
    const enrichedAddOns = computeAddOns(rawAddOns, Number(feeSetting?.value ?? 10));

    // ── PHASE 1: claim capacity ──────────────────────────────────────────────
    // This route previously inserted the reservation with NO availability check
    // of any kind, so two staff members could book the same room for the same
    // nights with 100% success. Capacity is now claimed transactionally in the
    // inventory service (SELECT ... FOR UPDATE on the room type) BEFORE anything
    // is written here. A full room type fails the request at this line.
    let hold;
    try {
      hold = await inventory.acquireHold({ roomTypeCode, checkIn, checkOut, quantity: 1 });
    } catch (err) {
      if (err instanceof NoInventoryError) {
        return res.status(409).json({
          error: 'No rooms of that type are available for the selected dates.',
          ...err.detail,
        });
      }
      if (err.statusCode === 400) return res.status(400).json({ error: err.message });
      // Inventory unreachable — refuse the booking rather than create one whose
      // capacity was never checked. Failing closed is the whole point.
      console.error('[Reservation] Could not reach inventory to hold capacity:', err.message);
      return res.status(502).json({ error: 'Could not verify room availability. Please try again.' });
    }

    // ── PHASE 2: choose a room, persist, then bind the hold to the new row ───
    //
    // The room is chosen INSIDE the retry loop rather than before it. A
    // concurrent booking can take our pick between the overlap check and the
    // insert, and the exclusion constraint is what tells us so — at which point
    // the answer is a different room, not a failed booking. A room chosen
    // EXPLICITLY by staff is never retried: "that room is taken" is the correct
    // thing to tell them.
    //
    // The processing fee is never client-supplied — computed once here, ahead
    // of the room-assignment retry loop, since it depends only on the deposit
    // amount/method, not on which room ends up assigned.
    const depositFeeCents = await depositFeeCentsFor(paymentType, depositCents);

    // ── Promo code ───────────────────────────────────────────────────────────
    // The discount is computed HERE and never taken from the request. The client
    // sends a code, not a price: a percentage applied in the browser is a
    // discount anyone with devtools can set to 100, and this endpoint already
    // trusts `totalEstimateCents` from the client, so the one thing it must not
    // also accept is the client's own arithmetic about it.
    //
    // Until now this path had no discount engine at all — the code was written
    // into Special Requests as a note and the guest was charged full price,
    // which is why a promo "worked" on the public site and did nothing at the
    // desk.
    let effectiveTotalCents = Number(totalEstimateCents || 0);
    let appliedPromo = null;
    if (promoCode) {
      const promo = await validatePromo(promoCode);
      if (promo === false) {
        return res.status(400).json({ error: `Promo code ${String(promoCode).toUpperCase()} is not valid.` });
      }
      if (promo) {
        effectiveTotalCents = Math.round(effectiveTotalCents * (1 - promo.percentOff / 100));
        appliedPromo = `${promo.code} (-${promo.percentOff}%)`;
      }
    }
    // Keep whatever the guest actually asked for: appending rather than
    // replacing, because overwriting Special Requests with the promo note is a
    // bug this codebase has already had once on the public path.
    const specialRequestsWithPromo =
      [specialRequests, appliedPromo ? `Promo applied: ${appliedPromo}` : null]
        .filter(Boolean)
        .join(' · ') || null;

    let reservation;
    try {
      const roomsTried = [];
      for (let attempt = 0; ; attempt += 1) {
        const roomId =
          requestedRoomId ??
          (await pickAssignableRoom({
            inventory,
            prisma,
            roomTypeCode,
            checkIn: ci,
            checkOut: co,
            excludeRoomIds: roomsTried,
          }));
        try {
          reservation = await prisma.reservation.create({
            data: {
              confirmationNumber: nextConfirmationNumber(),
              guestId,
              guestName,
              guestEmail,
              guestPhone,
              roomTypeCode,
              ratePlanId,
              assignedRoomId: roomId,
              checkIn: ci,
              checkOut: co,
              nights,
              adults: adults || 1,
              children: children || 0,
              source: source || 'DIRECT',
              totalEstimateCents: BigInt(effectiveTotalCents),
              depositCents: BigInt(depositCents || 0),
              specialRequests: specialRequestsWithPromo,
              addOns: enrichedAddOns,
              expectedArrivalTime,
              paymentType,
              // Only the sub-fields relevant to the chosen method are ever
              // persisted — same discipline as Folio's own payment route.
              depositCardMasked: paymentType === 'CARD' ? cardMasked : undefined,
              depositCardholderName: paymentType === 'CARD' ? cardholderName : undefined,
              depositBankName: paymentType === 'BANK_TRANSFER' ? bankName : undefined,
              depositTransferNetwork: paymentType === 'BANK_TRANSFER' ? transferNetwork : undefined,
              depositSenderName: paymentType === 'BANK_TRANSFER' ? senderName : undefined,
              depositGatewayRef:
                paymentType === 'BANK_TRANSFER' || paymentType === 'CARD'
                  ? gatewayRef || reference || undefined
                  : undefined,
              depositTransferredAt:
                paymentType === 'BANK_TRANSFER' ? new Date(transferredAt || Date.now()) : undefined,
              depositFeeCents,
              isNonRefundable: Boolean(isNonRefundable),
              ratePlan,
              origin,
              createdBy: req.user?.sub,
              inventoryHoldGroupId: hold.groupId,
            },
          });
          break;
        } catch (err) {
          const canRetry =
            !requestedRoomId && roomId && isRoomClashError(err) && attempt + 1 < MAX_ASSIGN_ATTEMPTS;
          if (!canRetry) throw err;
          console.warn(
            `[Reservation] Room ${roomId} was taken between selection and insert; picking another.`
          );
          roomsTried.push(roomId);
        }
      }
      // A booking with no room is invisible on the calendar, which is the exact
      // failure this route was fixed for. It is still the right outcome when
      // capacity says yes and no room is free — but it must never be silent.
      if (!reservation.assignedRoomId) {
        console.warn(
          `[Reservation] ${reservation.confirmationNumber} was taken with NO room assigned ` +
            `(type ${roomTypeCode}, ${utcDayKey(ci)} → ${utcDayKey(co)}). ` +
            'The front desk must assign one before it appears on a room row.'
        );
      }
      await inventory.attachHold(hold.groupId, reservation.id);
    } catch (err) {
      // Compensating action, in this order:
      //   1. delete the reservation row if it was already committed. Without
      //      this, a failed attach leaves a booking that NOTHING holds capacity
      //      for — invisible to availability, and duplicated when the client
      //      retries. The row was never returned to the caller, so deleting it
      //      is safe.
      //   2. hand the capacity back rather than waiting out the TTL.
      if (reservation?.id) {
        await prisma.reservation
          .delete({ where: { id: reservation.id } })
          .catch((e) =>
            console.error(
              `[Reservation] CRITICAL: could not roll back reservation ${reservation.id} after a failed hold attach: ${e.message}`
            )
          );
      }
      await inventory.releaseHold(hold.groupId);
      // A room clash is a 409 with a sentence the front desk can act on. It was
      // reported as 503 "please try again" because this catch returned before
      // the outer handler's mapDbConstraintError could ever see the error —
      // making the one message written for this case unreachable.
      const mapped = mapDbConstraintError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.error });
      console.error('[Reservation] Could not complete booking insert:', err.message);
      return res.status(503).json({ error: 'Could not complete the booking. Please try again.' });
    }

    await logActivity(
      reservation.id,
      req.user,
      'create',
      `Reservation created (${reservation.confirmationNumber})`
    );

    redis.publish(
      'reservation:created',
      JSON.stringify({
        reservationId: reservation.id,
        confirmationNumber: reservation.confirmationNumber,
        guestId,
        roomTypeCode,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        nights,
        inventoryHoldGroupId: hold.groupId,
      })
    );

    res.status(201).json(reservation);
  } catch (err) {
    const mapped = mapDbConstraintError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    console.error('[Reservation] Create error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reservations
//
// `from`/`to` describe a window of NIGHTS and select every booking that
// overlaps it — see lib/listQuery.js for why a checkIn-only range was the wrong
// question and made long stays vanish from the calendar.
//
// HOUSEKEEPING_MAINTENANCE, on top of the usual DESK_AUDIT set, so the 14-day
// outlook on that role's own dashboard (HousekeepingDashboard.jsx) can show
// real occupancy instead of every future night reading as fully available.
// navSections.json's "housekeeping" catalogue entry already listed
// /api/reservations among this role's allowed prefixes — this guard just
// catches up to that; it was documented but never actually enforced. Scoped
// to this one LIST route on purpose: /reservations/:id and its cards/
// documents/notes/activity siblings stay DESK_AUDIT-only, since those carry
// more than an occupancy count needs.
router.get(
  '/reservations',
  requireRole(...ROLE_GROUPS.DESK_AUDIT, 'HOUSEKEEPING_MAINTENANCE'),
  async (req, res) => {
    try {
      let where;
      try {
        where = reservationListWhere(req.query);
      } catch (err) {
        if (err instanceof BadWindowError) return res.status(400).json({ error: err.message });
        throw err;
      }
      const list = await prisma.reservation.findMany({
        where,
        orderBy: { checkIn: 'asc' },
        take: LIST_LIMIT,
      });
      // Silently returning a truncated page to a calendar is how a booking goes
      // missing without anything reporting it. The cap is generous enough that
      // hitting it means the caller needs paging, not a bigger number.
      if (list.length === LIST_LIMIT) {
        console.warn(
          `[Reservation] List hit the ${LIST_LIMIT}-row cap for ${JSON.stringify(req.query)}; ` +
            'results are truncated and some bookings will be missing from the caller.'
        );
      }
      res.json(list);
    } catch (err) {
      console.error('[Reservation] List error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// GET /api/reservations/:id
router.get('/reservations/:id', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const r = await prisma.reservation.findUnique({
      where: { id: req.params.id },
      include: { notes: { orderBy: { createdAt: 'desc' } } },
    });
    if (!r) return res.status(404).json({ error: 'Not found.' });
    res.json(r);
  } catch (err) {
    console.error('[Reservation] Get error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/reservations/:id
router.patch('/reservations/:id', requireRole(...STAFF), async (req, res) => {
  try {
    const {
      checkIn,
      checkOut,
      adults,
      children,
      specialRequests,
      guestEmail,
      guestPhone,
      ratePlanId,
      assignedRoomId,
      expectedArrivalTime,
      paymentType,
      depositCents,
      source,
      origin,
      ratePlan,
      isNonRefundable,
      cardMasked,
      cardholderName,
      bankName,
      transferNetwork,
      senderName,
      gatewayRef,
      reference,
      transferredAt,
    } = req.body;
    const before = await prisma.reservation.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Not found.' });

    // A publicly-created booking (services/reservation/src/index.js's
    // /api/public/reservations) starts with no deposit at all — this is the
    // only route that lets staff record one against it before confirming, per
    // the Mandatory Downpayment Constraint enforced below on /confirm.
    if (paymentType !== undefined && !VALID_DEPOSIT_PAYMENT_TYPES.includes(paymentType)) {
      return res.status(400).json({
        error: `paymentType must be one of ${VALID_DEPOSIT_PAYMENT_TYPES.join(', ')}.`,
      });
    }
    if (depositCents !== undefined && !(Number(depositCents) > 0)) {
      return res.status(400).json({ error: 'depositCents must be greater than 0.' });
    }
    // Validate against the EFFECTIVE method/fields (existing row + this
    // patch), so completing a deposit over several PATCH calls is held to the
    // same standard as setting it all at once in the wizard.
    const effectivePaymentType = paymentType !== undefined ? paymentType : before.paymentType;
    if (paymentType !== undefined || depositCents !== undefined || cardMasked !== undefined ||
        cardholderName !== undefined || bankName !== undefined || transferNetwork !== undefined ||
        senderName !== undefined || gatewayRef !== undefined || reference !== undefined) {
      const effectiveDepositBody = {
        cardMasked: cardMasked !== undefined ? cardMasked : before.depositCardMasked,
        cardholderName: cardholderName !== undefined ? cardholderName : before.depositCardholderName,
        bankName: bankName !== undefined ? bankName : before.depositBankName,
        transferNetwork: transferNetwork !== undefined ? transferNetwork : before.depositTransferNetwork,
        senderName: senderName !== undefined ? senderName : before.depositSenderName,
        gatewayRef: gatewayRef !== undefined ? gatewayRef : before.depositGatewayRef,
        reference,
      };
      const missingDeposit = missingDepositField(effectivePaymentType, effectiveDepositBody);
      if (missingDeposit) return res.status(400).json({ error: missingDeposit });
    }

    // Validate dates BEFORE anything else. An unparseable value used to sail
    // past the comparison guards (every comparison with NaN is false) and then
    // throw deep inside the handler, surfacing as a 500 instead of a 400.
    if (checkIn !== undefined && Number.isNaN(new Date(checkIn).getTime())) {
      return res.status(400).json({ error: 'checkIn is not a valid date.' });
    }
    if (checkOut !== undefined && Number.isNaN(new Date(checkOut).getTime())) {
      return res.status(400).json({ error: 'checkOut is not a valid date.' });
    }

    const data = {};
    // Patched dates get the same service-time stamp as a new booking, so an
    // edited window is comparable with every other one. nights is still counted
    // from the calendar dates.
    if (checkIn || checkOut) {
      const times = await serviceTimes();
      if (checkIn) data.checkIn = stampWindow({ checkIn: new Date(checkIn), ...times }).checkIn;
      if (checkOut) data.checkOut = stampWindow({ checkOut: new Date(checkOut), ...times }).checkOut;
    }
    if (checkIn && checkOut) data.nights = nightsBetweenDates(checkIn, checkOut);
    if (adults !== undefined) data.adults = adults;
    if (children !== undefined) data.children = children;
    if (specialRequests !== undefined) data.specialRequests = specialRequests;
    if (guestEmail !== undefined) data.guestEmail = guestEmail;
    if (guestPhone !== undefined) data.guestPhone = guestPhone;
    if (ratePlanId !== undefined) data.ratePlanId = ratePlanId;
    // Same '' → null normalisation as the create path: an empty string is a
    // phantom room that the double-booking constraint treats as real.
    if (assignedRoomId !== undefined) {
      const newRoomId = normaliseRoomId(assignedRoomId);
      // Only a REAL reassignment needs checking — re-saving the same room (or
      // clearing it) can't newly collide with anything. Same gap as the create
      // path: this used to write straight through with no server-side check,
      // so moving a reservation onto a room a walk-in is currently occupying
      // (no reservation row to trip the exclusion constraint) went through
      // silently.
      if (newRoomId && newRoomId !== before.assignedRoomId) {
        const free = await isRoomFree({
          inventory,
          prisma,
          roomTypeCode: before.roomTypeCode,
          checkIn: data.checkIn || before.checkIn,
          checkOut: data.checkOut || before.checkOut,
          excludeReservationId: before.id,
          roomId: newRoomId,
        });
        if (!free) {
          return res.status(409).json({ error: 'That room is no longer available for the selected dates.' });
        }
      }
      data.assignedRoomId = newRoomId;
    }
    if (expectedArrivalTime !== undefined) data.expectedArrivalTime = expectedArrivalTime;
    if (paymentType !== undefined) data.paymentType = paymentType;
    if (depositCents !== undefined) data.depositCents = BigInt(depositCents);
    if (source !== undefined) data.source = source;
    // Both are columns the reservation header displays and Quick Edit edits.
    // `ratePlan` is the free-text label shown as "Rate Plan(s)"; `ratePlanId` is
    // the FK above and is set independently.
    if (origin !== undefined) data.origin = origin;
    if (ratePlan !== undefined) data.ratePlan = ratePlan;
    if (isNonRefundable !== undefined) data.isNonRefundable = Boolean(isNonRefundable);
    if (cardMasked !== undefined) data.depositCardMasked = cardMasked;
    if (cardholderName !== undefined) data.depositCardholderName = cardholderName;
    if (bankName !== undefined) data.depositBankName = bankName;
    if (transferNetwork !== undefined) data.depositTransferNetwork = transferNetwork;
    if (senderName !== undefined) data.depositSenderName = senderName;
    if (gatewayRef !== undefined || reference !== undefined) {
      data.depositGatewayRef = gatewayRef || reference;
    }
    if (transferredAt !== undefined) data.depositTransferredAt = new Date(transferredAt);
    // Never trust a client-sent fee — recompute authoritatively whenever the
    // method or amount that determines it changes.
    if (paymentType !== undefined || depositCents !== undefined) {
      data.depositFeeCents = await depositFeeCentsFor(
        effectivePaymentType,
        depositCents !== undefined ? depositCents : before.depositCents
      );
    }

    // ── Re-hold on a date change ─────────────────────────────────────────────
    // Moving a booking's dates invalidates the inventory hold that was taken for
    // the ORIGINAL range. Without re-holding, the old nights stay blocked and the
    // new nights are never checked — so a date change was a second route to
    // silent oversell. Claim the new range first, and only release the old hold
    // once the update has committed.
    const datesChanged =
      (data.checkIn && data.checkIn.getTime() !== before.checkIn.getTime()) ||
      (data.checkOut && data.checkOut.getTime() !== before.checkOut.getTime());

    let newHold = null;
    if (datesChanged) {
      if (['CANCELLED', 'NO_SHOW', 'CHECKED_OUT'].includes(before.status)) {
        return res.status(409).json({ error: `Cannot change the dates of a ${before.status} reservation.` });
      }
      const nextCheckIn = data.checkIn || before.checkIn;
      const nextCheckOut = data.checkOut || before.checkOut;
      if (nextCheckOut <= nextCheckIn) {
        return res.status(400).json({ error: 'checkOut must be after checkIn.' });
      }
      data.nights = nightsBetweenDates(nextCheckIn, nextCheckOut);

      try {
        newHold = await inventory.acquireHold({
          roomTypeCode: before.roomTypeCode,
          checkIn: nextCheckIn,
          checkOut: nextCheckOut,
          quantity: 1,
        });
        data.inventoryHoldGroupId = newHold.groupId;
      } catch (err) {
        if (err instanceof NoInventoryError) {
          return res.status(409).json({
            error: 'No availability for the requested new dates. The booking was left unchanged.',
            ...err.detail,
          });
        }
        if (err.statusCode === 400) return res.status(400).json({ error: err.message });
        console.error('[Reservation] Could not re-hold on date change:', err.message);
        return res
          .status(502)
          .json({ error: 'Could not verify availability for the new dates. Please try again.' });
      }
    }

    let r;
    try {
      r = await prisma.reservation.update({ where: { id: req.params.id }, data });
      if (newHold) await inventory.attachHold(newHold.groupId, r.id);
    } catch (err) {
      if (newHold) {
        // Put the booking back the way it was. Without restoring the dates, a
        // failed attach would leave the row carrying its NEW dates while
        // pointing at a hold group that is about to be released — capacity
        // tracked for one range, guest expected in another.
        await prisma.reservation
          .update({
            where: { id: req.params.id },
            data: {
              checkIn: before.checkIn,
              checkOut: before.checkOut,
              nights: before.nights,
              inventoryHoldGroupId: before.inventoryHoldGroupId,
            },
          })
          .catch((e) =>
            console.error(
              `[Reservation] CRITICAL: could not restore reservation ${req.params.id} after a failed re-hold: ${e.message}`
            )
          );
        await inventory.releaseHold(newHold.groupId);
      }
      const mapped = mapDbConstraintError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.error });
      throw err;
    }

    // The move succeeded — hand the original nights back. Released AFTER the new
    // hold is attached so capacity is never briefly unclaimed; the two groups
    // legitimately share a reservationId on overlapping nights in between, which
    // is why there is no unique index on (reservationId, date).
    if (newHold && before.inventoryHoldGroupId) {
      await inventory.releaseHold(before.inventoryHoldGroupId);
    }

    // Activity summary
    const changes = [];
    // Stored dates are UTC midnight (date-only), so utcDayKey is the matching
    // formatter for comparison against a client-supplied YYYY-MM-DD.
    if (checkIn && utcDayKey(before.checkIn) !== checkIn)
      changes.push(`Check-in ${utcDayKey(before.checkIn)} → ${checkIn}`);
    if (checkOut && utcDayKey(before.checkOut) !== checkOut)
      changes.push(`Check-out ${utcDayKey(before.checkOut)} → ${checkOut}`);
    if (assignedRoomId && before.assignedRoomId !== assignedRoomId)
      changes.push(`Room ${before.assignedRoomId || 'unassigned'} → ${assignedRoomId}`);
    if (changes.length) await logActivity(r.id, req.user, 'modify', changes.join(' · '));

    // The window travels with the event. A Stay keeps its OWN
    // expectedCheckIn/expectedCheckOut, and those are what the registration
    // card prints, what Arrivals' early-check-in guard compares and what Reports
    // shows next to the actual times — so a date edit here has to reach them or
    // they quietly describe the booking as it used to be.
    redis.publish(
      'reservation:updated',
      JSON.stringify({
        reservationId: r.id,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
      })
    );
    res.json(r);
  } catch (err) {
    console.error('[Reservation] Update error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/reservations/:id/confirm
router.post('/reservations/:id/confirm', requireRole(...STAFF), async (req, res) => {
  try {
    const existing = await prisma.reservation.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    if (existing.status !== 'PENDING') {
      return res
        .status(409)
        .json({ error: `Only a pending reservation can be confirmed (current: ${existing.status}).` });
    }
    // Mandatory Downpayment Constraint: confirmation is the other side of the
    // gate this file enforces at creation. A publicly-created booking (which
    // starts with no deposit at all) reaches this route with nothing recorded,
    // so it lands here rather than at create — PATCH /reservations/:id is how
    // staff record the deposit before confirming.
    if (!(existing.depositCents > 0n) || !VALID_DEPOSIT_PAYMENT_TYPES.includes(existing.paymentType)) {
      return res.status(409).json({
        error:
          'Cannot confirm without a recorded downpayment. Record depositCents and paymentType ' +
          `(${VALID_DEPOSIT_PAYMENT_TYPES.join(', ')}) first.`,
      });
    }
    // Closes the gap PATCH leaves open: a deposit completed over several PATCH
    // calls must satisfy the same per-method requirements as one set at
    // creation before it is allowed to confirm.
    const missingDeposit = missingDepositField(existing.paymentType, {
      cardMasked: existing.depositCardMasked,
      cardholderName: existing.depositCardholderName,
      bankName: existing.depositBankName,
      transferNetwork: existing.depositTransferNetwork,
      senderName: existing.depositSenderName,
      gatewayRef: existing.depositGatewayRef,
    });
    if (missingDeposit) {
      return res.status(409).json({ error: `Cannot confirm: ${missingDeposit}` });
    }
    const r = await prisma.reservation.update({
      where: { id: req.params.id },
      data: { status: 'CONFIRMED' },
    });
    await logActivity(r.id, req.user, 'confirm', 'Reservation confirmed');
    redis.publish(
      'reservation:confirmed',
      JSON.stringify({
        reservationId: r.id,
        confirmationNumber: r.confirmationNumber,
        guestId: r.guestId,
        guestName: r.guestName,
        roomTypeCode: r.roomTypeCode,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
      })
    );
    res.json(r);
  } catch (err) {
    console.error('[Reservation] Confirm error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// A card ON FILE as a booking guarantee, not a payment. No field here could
// ever hold a full number or a CVV — see the ReservationCard model comment.
const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'JCB', 'OTHER'];

function validateCard(body) {
  const { brand, last4, expMonth, expYear, cardholderName } = body || {};
  if (!CARD_BRANDS.includes(brand)) return `brand must be one of ${CARD_BRANDS.join(', ')}.`;
  if (!/^\d{4}$/.test(String(last4 || ''))) return 'last4 must be exactly 4 digits.';
  const m = Number(expMonth);
  const y = Number(expYear);
  if (!Number.isInteger(m) || m < 1 || m > 12) return 'expMonth must be 1-12.';
  if (!Number.isInteger(y)) return 'expYear must be a whole number.';
  // The LAST day of the expiry month, since a card is good through the end of
  // that month, not just its first instant.
  if (new Date(y, m, 1) <= new Date()) return 'This card has already expired.';
  if (!String(cardholderName || '').trim()) return 'cardholderName is required.';
  return null;
}

// POST /api/reservations/:id/cards
router.post('/reservations/:id/cards', requireRole(...STAFF), async (req, res) => {
  try {
    const existing = await prisma.reservation.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found.' });

    const error = validateCard(req.body);
    if (error) return res.status(400).json({ error });

    const { brand, last4, expMonth, expYear, cardholderName } = req.body;
    const card = await prisma.reservationCard.create({
      data: {
        reservationId: req.params.id,
        brand,
        last4: String(last4),
        expMonth: Number(expMonth),
        expYear: Number(expYear),
        cardholderName: cardholderName.trim(),
        createdBy: req.user?.username || req.user?.sub,
      },
    });
    res.status(201).json(card);
  } catch (err) {
    console.error('[Reservation] Add card error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reservations/:id/cards
router.get('/reservations/:id/cards', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const cards = await prisma.reservationCard.findMany({
      where: { reservationId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(cards);
  } catch (err) {
    console.error('[Reservation] List cards error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/reservations/:id/cards/:cardId
router.delete('/reservations/:id/cards/:cardId', requireRole(...STAFF), async (req, res) => {
  try {
    // Scoped to the reservation in the path, same as the note-archive route —
    // a card id alone must not be removable through a different reservation's
    // URL.
    const result = await prisma.reservationCard.deleteMany({
      where: { id: req.params.cardId, reservationId: req.params.id },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Card not found for this reservation.' });
    res.status(204).end();
  } catch (err) {
    console.error('[Reservation] Remove card error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/reservations/:id/documents — filename/contentType/contentBase64.
// The bytes go to MinIO (see lib/storage.js); only metadata is stored here.
router.post('/reservations/:id/documents', requireRole(...STAFF), async (req, res) => {
  try {
    const existing = await prisma.reservation.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found.' });

    const { filename, contentType, contentBase64 } = req.body || {};
    if (!filename || !String(filename).trim())
      return res.status(400).json({ error: 'filename is required.' });
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 is required.' });

    let buffer;
    try {
      buffer = Buffer.from(contentBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'contentBase64 is not valid base64.' });
    }
    if (buffer.length === 0) return res.status(400).json({ error: 'The uploaded file is empty.' });
    if (buffer.length > MAX_DOCUMENT_BYTES) {
      return res.status(400).json({
        error: `File is ${(buffer.length / (1024 * 1024)).toFixed(1)}MB, over the ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit.`,
      });
    }

    const objectKey = storage.objectKeyFor(req.params.id, filename);
    await storage.ensureBucket();
    await storage.putDocument(objectKey, buffer, contentType);

    const doc = await prisma.reservationDocument.create({
      data: {
        reservationId: req.params.id,
        filename: String(filename),
        contentType: contentType || 'application/octet-stream',
        sizeBytes: buffer.length,
        objectKey,
        uploadedBy: req.user?.username || req.user?.sub,
      },
    });
    res.status(201).json(doc);
  } catch (err) {
    console.error('[Reservation] Upload document error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reservations/:id/documents
router.get('/reservations/:id/documents', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const docs = await prisma.reservationDocument.findMany({
      where: { reservationId: req.params.id },
      orderBy: { uploadedAt: 'desc' },
    });
    res.json(docs);
  } catch (err) {
    console.error('[Reservation] List documents error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reservations/:id/documents/:docId/download — streams the file back
// through this service rather than a direct MinIO link, so it stays behind the
// same gateway auth as everything else; MinIO itself is never reachable from a
// browser.
router.get(
  '/reservations/:id/documents/:docId/download',
  requireRole(...ROLE_GROUPS.DESK_AUDIT),
  async (req, res) => {
    try {
      const doc = await prisma.reservationDocument.findFirst({
        where: { id: req.params.docId, reservationId: req.params.id },
      });
      if (!doc) return res.status(404).json({ error: 'Document not found for this reservation.' });

      const stream = await storage.getDocumentStream(doc.objectKey);
      res.setHeader('Content-Type', doc.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
      stream.on('error', (err) => {
        console.error('[Reservation] Document stream error:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Could not read the stored file.' });
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[Reservation] Download document error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// DELETE /api/reservations/:id/documents/:docId
router.delete('/reservations/:id/documents/:docId', requireRole(...STAFF), async (req, res) => {
  try {
    const doc = await prisma.reservationDocument.findFirst({
      where: { id: req.params.docId, reservationId: req.params.id },
    });
    if (!doc) return res.status(404).json({ error: 'Document not found for this reservation.' });

    await storage.removeDocument(doc.objectKey);
    await prisma.reservationDocument.deleteMany({ where: { id: doc.id, reservationId: req.params.id } });
    res.status(204).end();
  } catch (err) {
    console.error('[Reservation] Delete document error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/reservations/:id/send-confirmation-email — the desk's on-demand
// resend, for when a guest says they never got it. Sent synchronously here
// (like the folio receipt-email route) rather than through the Redis event
// the /confirm route publishes, so the desk gets an honest pass/fail back
// instead of a fire-and-forget that only ever logs to the console.
router.post('/reservations/:id/send-confirmation-email', requireRole(...STAFF), async (req, res) => {
  try {
    const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
    if (!r) return res.status(404).json({ error: 'Not found.' });

    // The template says "Your reservation is confirmed" — sending that on a
    // booking that isn't (or no longer is) would tell the guest something
    // false, which is worse than the "Coming soon" stub this replaces.
    if (['PENDING', 'CANCELLED', 'NO_SHOW'].includes(r.status)) {
      return res
        .status(409)
        .json({ error: `A confirmation email cannot be sent for a ${r.status.toLowerCase()} reservation.` });
    }
    if (!r.guestEmail) {
      return res.status(400).json({ error: 'This reservation has no guest email on file.' });
    }

    const { subject, body } = TEMPLATES.reservation_confirmed(r);
    await sendMail({ to: r.guestEmail, subject, body });
    res.json({ sent: true, to: r.guestEmail });
  } catch (err) {
    console.error('[Reservation] Send confirmation email error:', err.message);
    res.status(502).json({ error: 'Could not send the confirmation email.' });
  }
});

// POST /api/reservations/:id/cancel
router.post('/reservations/:id/cancel', requireRole(...STAFF), async (req, res) => {
  try {
    const { reason, cancellationFeeCents: explicitFee, note } = req.body;
    const cancellationNumber = nextCancellationNumber();
    // Look up reservation first so we can compute the fee from policy if not supplied.
    const existing = await prisma.reservation.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    if (existing.status === 'CANCELLED') {
      return res.status(409).json({ error: 'Reservation is already cancelled.' });
    }
    if (
      existing.status === 'CHECKED_IN' ||
      existing.status === 'IN_HOUSE' ||
      existing.status === 'CHECKED_OUT'
    ) {
      return res.status(409).json({ error: `Cannot cancel a ${existing.status} reservation.` });
    }
    let computedFeeCents;
    if (explicitFee != null) {
      const fee = Number(explicitFee);
      if (!Number.isFinite(fee) || fee < 0) {
        return res.status(400).json({ error: 'cancellationFeeCents must be a non-negative number.' });
      }
      computedFeeCents = Math.round(fee);
    } else {
      computedFeeCents = Math.round(
        cancellationFeeCents({
          totalEstimateCents: Number(existing.totalEstimateCents || 0),
          checkIn: existing.checkIn,
          method: existing.paymentType,
          isNonRefundable: existing.isNonRefundable,
        }) || 0
      );
    }
    const r = await prisma.reservation.update({
      where: { id: req.params.id },
      data: {
        status: 'CANCELLED',
        cancellationReason: reason,
        cancellationNumber,
        cancellationFeeCents: BigInt(computedFeeCents),
        cancelledAt: new Date(),
        cancelledBy: req.user?.sub,
      },
    });
    if (note) {
      await prisma.reservationNote.create({
        data: { reservationId: r.id, author: req.user?.username || req.user?.sub, body: note },
      });
    }
    await logActivity(
      r.id,
      req.user,
      'cancel',
      `Cancelled (${cancellationNumber}) — reason: ${reason || 'unspecified'}${computedFeeCents ? `, fee ₱${(computedFeeCents / 100).toFixed(2)}` : ''}`
    );
    // Return the capacity DIRECTLY rather than relying on the event below.
    // Redis pub/sub has no persistence and no retry: if the inventory service
    // happened to be restarting, the cancellation message was dropped and the
    // hold kept blocking that room type until its expiry. releaseHold never
    // throws, and the subscriber remains as a backstop for holds cancelled by
    // other paths.
    if (existing.inventoryHoldGroupId) {
      await inventory.releaseHold(existing.inventoryHoldGroupId);
    }

    redis.publish(
      'reservation:cancelled',
      JSON.stringify({
        reservationId: r.id,
        cancellationNumber,
        reason,
        // Who and which booking. Without these the notification could only say
        // "Reservation cancelled", which is true of every cancellation and
        // therefore identifies none of them.
        guestName: r.guestName,
        confirmationNumber: r.confirmationNumber,
        cancellationFeeCents: computedFeeCents,
        // Inventory service should release any active holds tied to this reservation.
        releaseHolds: true,
        roomTypeCode: r.roomTypeCode,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
      })
    );
    res.json(r);
  } catch (err) {
    console.error('[Reservation] Cancel error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/reservations/:id/deposit-refund — refund or forfeit what is left
// of a cancelled reservation's deposit after the cancellation fee.
//
// MGMT_AUDIT (Admin/Manager/Auditor), not the broader STAFF group /cancel
// uses: this moves money back to a guest, the same role group Folio's own
// /folios/:id/refund and void-transaction routes require for exactly that
// reason (services/folio/src/routes/folio.routes.js's FINANCE group) — Front
// Desk cancels a booking, but does not decide what happens to its deposit.
router.post(
  '/reservations/:id/deposit-refund',
  requireRole(...ROLE_GROUPS.MGMT_AUDIT),
  async (req, res) => {
    try {
      const { action, amountCents, reason } = req.body;
      if (action !== 'refund' && action !== 'forfeit') {
        return res.status(400).json({ error: 'action must be "refund" or "forfeit".' });
      }
      const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
      if (!r) return res.status(404).json({ error: 'Not found.' });
      if (r.status !== 'CANCELLED') {
        return res.status(409).json({ error: 'Only a cancelled reservation has a deposit decision to make.' });
      }
      if (r.depositForfeitedAt) {
        return res.status(409).json({ error: 'The remaining deposit was already forfeited.' });
      }
      const remaining = remainingDepositRefundCents(r);
      if (remaining <= 0) {
        return res.status(409).json({ error: 'Nothing left of this deposit to refund.' });
      }

      if (action === 'forfeit') {
        const updated = await prisma.reservation.update({
          where: { id: r.id },
          data: { depositForfeitedAt: new Date(), depositForfeitedBy: req.user?.sub },
        });
        await logActivity(
          r.id,
          req.user,
          'deposit_forfeit',
          `Remaining deposit of ₱${(remaining / 100).toFixed(2)} forfeited${reason ? ` — reason: ${reason}` : ''}`
        );
        return res.json(updated);
      }

      const refundCents = Math.round(Number(amountCents));
      if (!Number.isFinite(refundCents) || refundCents <= 0) {
        return res.status(400).json({ error: 'amountCents must be a positive number.' });
      }
      if (refundCents > remaining) {
        return res.status(400).json({
          error: 'amountCents exceeds what remains of this deposit.',
          remainingCents: remaining,
        });
      }
      const updated = await prisma.reservation.update({
        where: { id: r.id },
        data: {
          depositRefundedCents: BigInt(refundedCents + refundCents),
          depositRefundedAt: new Date(),
          depositRefundedBy: req.user?.sub,
          depositRefundReason: reason || null,
        },
      });
      await logActivity(
        r.id,
        req.user,
        'deposit_refund',
        `Refunded ₱${(refundCents / 100).toFixed(2)} of the deposit${reason ? ` — reason: ${reason}` : ''}`
      );
      redis.publish(
        'reservation:deposit_refunded',
        JSON.stringify({
          reservationId: r.id,
          confirmationNumber: r.confirmationNumber,
          guestName: r.guestName,
          amountCents: refundCents,
        })
      );
      res.json(updated);
    } catch (err) {
      console.error('[Reservation] Deposit refund error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// DELETE /api/reservations/:id — Admin/Manager ONLY (not the broader STAFF
// group every other write route here uses). Front desk still cancels a
// booking; this is a separate, stricter action for permanently ERASING the
// record — a duplicate entry, a mistaken booking, a stale no-show nobody
// needs a paper trail for.
//
// Refused once a real stay ever existed against this reservation
// (CHECKED_IN/IN_HOUSE/CHECKED_OUT): at that point folios, charges and guest
// history reference it, and deleting the booking behind them would orphan
// all of that silently (Stay.reservationId is a plain string, not a foreign
// key, so nothing in the database would even complain). Cancel remains the
// right tool once a stay is real; Delete is for a booking that never became
// one.
router.delete('/reservations/:id', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const existing = await prisma.reservation.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    if (['CHECKED_IN', 'IN_HOUSE', 'CHECKED_OUT'].includes(existing.status)) {
      return res.status(409).json({
        error:
          `Cannot delete a ${existing.status.toLowerCase().replace('_', ' ')} reservation — ` +
          'a real stay exists against it. Cancel it instead if it must go away.',
      });
    }
    // Same discipline as /cancel: return the capacity directly rather than
    // relying purely on the event below, so a slow/restarting inventory
    // service does not leave this room type's hold blocking sales.
    if (existing.inventoryHoldGroupId) {
      await inventory.releaseHold(existing.inventoryHoldGroupId);
    }
    // Every child row (activity log, cards, documents, notes, notification
    // log) is onDelete: Cascade in the schema, so this alone removes them.
    await prisma.reservation.delete({ where: { id: req.params.id } });
    redis.publish(
      'reservation:deleted',
      JSON.stringify({ reservationId: req.params.id, confirmationNumber: existing.confirmationNumber })
    );
    res.status(204).end();
  } catch (err) {
    console.error('[Reservation] Delete error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/reservations/:id/notes
router.post('/reservations/:id/notes', requireRole(...STAFF), async (req, res) => {
  try {
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'body required.' });
    const note = await prisma.reservationNote.create({
      data: { reservationId: req.params.id, author: req.user?.username || req.user?.sub, body },
    });
    res.status(201).json(note);
  } catch (err) {
    console.error('[Reservation] Note error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reservations/:id/notes
router.get('/reservations/:id/notes', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const notes = await prisma.reservationNote.findMany({
      where: { reservationId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(notes);
  } catch (err) {
    console.error('[Reservation] List notes error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/reservations/:id/notes/:noteId  (archive/unarchive)
router.patch('/reservations/:id/notes/:noteId', requireRole(...STAFF), async (req, res) => {
  try {
    const { archived } = req.body;
    // Scope the update to the reservation in the path so a note id can't be
    // archived through a different reservation's URL.
    const result = await prisma.reservationNote.updateMany({
      where: { id: req.params.noteId, reservationId: req.params.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Note not found for this reservation.' });
    const n = await prisma.reservationNote.findUnique({ where: { id: req.params.noteId } });
    res.json(n);
  } catch (err) {
    console.error('[Reservation] Note update error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reservations/:id/activity
router.get('/reservations/:id/activity', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const list = await prisma.reservationActivity.findMany({
      where: { reservationId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(list);
  } catch (err) {
    console.error('[Reservation] Activity error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reservations/:id/notifications — every attempted booking
// confirmation, across Email, SMS and Viber. SMS/Viber are mocked (no real
// provider exists in this stack), so this is the only place to see what
// would have gone out — see lib/notifyChannels.js.
router.get('/reservations/:id/notifications', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const list = await prisma.notificationLog.findMany({
      where: { reservationId: req.params.id },
      orderBy: { sentAt: 'desc' },
      take: 200,
    });
    res.json(list);
  } catch (err) {
    console.error('[Reservation] Notifications error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/settings/addon-fee-percent — read the current add-on surcharge so
// the reservation wizard can show it before checkout.
router.get('/settings/addon-fee-percent', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'addon_fee_percent' } });
    res.json({ feePercent: Number(row?.value ?? 10) });
  } catch (err) {
    console.error('[Reservation] Get setting error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/settings/payment-fee-percent — proxies Folio's own setting (Folio
// owns it; this just lets the wizard show the same CARD/BANK_TRANSFER
// surcharge preview without the frontend calling folio directly). 0 on any
// failure — a fee preview is a nicety, never a reason to block a booking.
router.get('/settings/payment-fee-percent', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    res.json({ feePercent: await folio.getPaymentFeePercent().catch(() => 0) });
  } catch (err) {
    console.error('[Reservation] Get payment fee percent error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/settings/addon-fee-percent — admin/manager only.
router.put('/settings/addon-fee-percent', requireRole(...ROLE_GROUPS.MGMT), async (req, res) => {
  try {
    const feePercent = Number(req.body.feePercent);
    if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
      return res.status(400).json({ error: 'feePercent must be a number between 0 and 100.' });
    }
    const row = await prisma.appSetting.upsert({
      where: { key: 'addon_fee_percent' },
      create: { key: 'addon_fee_percent', value: String(feePercent) },
      update: { value: String(feePercent) },
    });
    res.json({ feePercent: Number(row.value) });
  } catch (err) {
    console.error('[Reservation] Set setting error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── System accent theme ─────────────────────────────────────────────────────
// Stored in AppSetting, the same key/value table the add-on surcharge uses, so
// this needs no migration. It lives HERE rather than in browser storage because
// it is a property of the hotel, not of a device: an admin sets the accent once
// and every terminal picks it up. Per-browser storage would have meant the front
// desk and the back office disagreeing about what the system looks like.
const THEME_KEY = 'accent_theme';

// The shipped palette, returned when nobody has customised anything. Kept in
// sync with :root in web/src/styles.css.
const THEME_DEFAULT = { primary: '#0a6b3d', secondary: '#22c55e', hover: '#075130' };

// Exactly `#rrggbb`. These values are interpolated into a CSS custom property in
// the browser, so anything that is not a plain hex colour is refused here rather
// than being allowed to carry arbitrary CSS into every page.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// GET /api/settings/theme — every role, because every page renders the accent.
router.get('/settings/theme', async (_req, res) => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: THEME_KEY } });
    if (!row?.value) return res.json(THEME_DEFAULT);
    const saved = JSON.parse(row.value);
    // Fall back per FIELD, so a partially written row still yields a usable
    // palette instead of an undefined colour.
    res.json({
      primary: HEX_RE.test(saved.primary) ? saved.primary : THEME_DEFAULT.primary,
      secondary: HEX_RE.test(saved.secondary) ? saved.secondary : THEME_DEFAULT.secondary,
      hover: HEX_RE.test(saved.hover) ? saved.hover : THEME_DEFAULT.hover,
    });
  } catch (err) {
    console.error('[Reservation] Get theme error:', err.message);
    // A corrupt row must not take the whole UI's colours down with it.
    res.json(THEME_DEFAULT);
  }
});

// PUT /api/settings/theme — ADMIN only; this changes what everyone sees.
router.put('/settings/theme', requireRole('ADMIN'), async (req, res) => {
  try {
    const { primary, secondary, hover } = req.body || {};
    for (const [name, v] of Object.entries({ primary, secondary, hover })) {
      if (!HEX_RE.test(String(v || ''))) {
        return res.status(400).json({ error: `${name} must be a hex colour like #0a6b3d.` });
      }
    }
    const value = JSON.stringify({ primary, secondary, hover });
    await prisma.appSetting.upsert({
      where: { key: THEME_KEY },
      create: { key: THEME_KEY, value },
      update: { value },
    });
    res.json({ primary, secondary, hover });
  } catch (err) {
    console.error('[Reservation] Set theme error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/settings/theme/reset — ADMIN only, same as the write above.
router.put('/settings/theme/reset', requireRole('ADMIN'), async (_req, res) => {
  try {
    await prisma.appSetting.deleteMany({ where: { key: THEME_KEY } });
    res.json(THEME_DEFAULT);
  } catch (err) {
    console.error('[Reservation] Reset theme error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
