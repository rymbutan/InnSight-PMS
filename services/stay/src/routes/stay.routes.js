const express = require('express');
const PDFDocument = require('pdfkit');
const Redis = require('ioredis');
const { requireRole, JWT_SECRET, ROLE_GROUPS } = require('../middleware/auth');
const { makeServiceCaller } = require('../lib/serviceCall');
const { qrPngBuffer } = require('../lib/qr');
const { publicUrl } = require('../lib/publicUrl');
const { makeInventoryClient } = require('../lib/inventoryClient');
const { localDayBounds, parseLocalDay, utcDayStart, utcDayKey } = require('../lib/date');
const { arrivalsWindow } = require('../lib/arrivalsWindow');

const AUDIT_ROLES = ['ADMIN', 'MANAGER', 'AUDITOR'];
const STAFF = ['ADMIN', 'MANAGER', 'FRONT_DESK']; // front-desk operations

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const FOLIO_URL = process.env.FOLIO_URL || 'http://folio-service:3007';
const RESERVATION_URL = process.env.RESERVATION_URL || 'http://reservation-service:3011';
// Narrow on purpose: this caller only ever reads whether a stay's folios are clear.
const folioCall = makeServiceCaller({
  name: 'stay',
  roles: ['FRONT_DESK'],
  permissions: ['folio.read'],
});
// Reads a reservation's confirmation number for the registration card's QR code.
const reservationCall = makeServiceCaller({
  name: 'stay',
  roles: ['FRONT_DESK'],
  permissions: ['reservation.read'],
});
// Without an 'error' listener, ioredis throws on a connection blip and takes
// the whole process down — which for this service means the capacity gate
// disappears. Other files in this repo already do this; these did not.
redis.on('error', (e) => console.error('[Stay] redis error:', e.message));
const inventory = makeInventoryClient({ name: 'stay', secret: JWT_SECRET });

// Statuses a room may be in and still receive a guest. A DIRTY room has not been
// serviced; OUT_OF_ORDER / OUT_OF_SERVICE are unavailable by definition.
const HABITABLE_ROOM_STATUSES = ['CLEAN', 'CLEAN_INSPECTED'];

/**
 * Validate a room assignment on the SERVER before a guest is placed in it.
 *
 * The front end computed availability in the browser (WalkIn.jsx built a Set of
 * occupied room ids from a list it had fetched earlier) and the server accepted
 * whatever roomId it was handed. Two clerks working from lists fetched seconds
 * apart would both be shown the same "free" room and both succeed.
 *
 * Two independent checks, because they have two different owners:
 *   - room exists and is habitable  → inventory service owns room state
 *   - room is not already occupied  → THIS service owns stays
 *
 * @param {string}  assignedRoomId
 * @param {string} [excludeStayId] stay being updated, so it doesn't clash with itself
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
async function validateRoomAssignment(assignedRoomId, excludeStayId) {
  if (!assignedRoomId) {
    return { ok: false, status: 400, error: 'assignedRoomId is required.' };
  }

  // (1) Does the room exist, and is it fit to occupy?
  let room;
  try {
    room = await inventory.getRoom(assignedRoomId);
  } catch (err) {
    console.error('[Stay] Room lookup failed during assignment validation:', err.message);
    // Fail closed. Checking a guest into an unverifiable room is how a room ends
    // up double-sold.
    return { ok: false, status: 502, error: 'Could not verify the room. Please try again.' };
  }
  if (!room) {
    return { ok: false, status: 400, error: 'That room does not exist.' };
  }
  if (!HABITABLE_ROOM_STATUSES.includes(room.status)) {
    return {
      ok: false,
      status: 409,
      error: `Room ${room.number} is ${String(room.status).toLowerCase().replace(/_/g, ' ')} and cannot be occupied.`,
    };
  }

  // (2) Is anyone already in it? This service is authoritative for occupancy.
  const occupant = await prisma.stay.findFirst({
    where: {
      assignedRoomId,
      status: 'IN_HOUSE',
      ...(excludeStayId ? { id: { not: excludeStayId } } : {}),
    },
  });
  if (occupant) {
    return {
      ok: false,
      status: 409,
      error: `Room ${room.number} is already occupied by ${occupant.guestName || 'another guest'}.`,
    };
  }

  return { ok: true, room };
}

// Arrivals/departures are LOCAL business days. Delegated to the shared helper so
// this service and the audit service agree on where a day starts — they used to
// build day keys with different conventions and sat 8 hours out of phase.
function dayBounds(dateStr) {
  return localDayBounds(dateStr ? parseLocalDay(dateStr) : new Date());
}

// GET /api/arrivals?range=today|week|month
//
// WHY THIS READS RESERVATIONS AND NOT Stay ROWS
// ---------------------------------------------
// This route used to query Stay rows with status PRE_ARRIVAL. Those rows exist
// only because subscribers/redis.subscriber.js received a reservation:confirmed
// message. A reservation confirmed while this service was down, or seeded
// directly, never got a Stay row and was PERMANENTLY invisible to the front
// desk — there is no reconciliation anywhere. Guests were missing off the
// arrivals sheet and nothing reported it.
//
// So the RESERVATION is now the source of truth for "who is expected", and the
// local Stay row is the source of truth for "have they arrived".
//
// The Stay join is load-bearing, not belt-and-braces: Reservation.status is
// flipped to CHECKED_IN by ANOTHER Redis subscriber
// (services/reservation/src/subscribers/redis.subscriber.js), so it is exactly
// as lossy as the projection this route stopped reading. POST /api/check-in
// writes the Stay row synchronously, which is why excluding on the stay's status
// is what actually keeps an in-house guest off the arrivals list.
router.get('/arrivals', requireRole(...ROLE_GROUPS.OPS_READ), async (req, res) => {
  try {
    // `?date=` is the NIGHT AUDIT's and the reports service's form: exactly one
    // business day, no overdue rows. Dropping it would make the audit's
    // movements_snapshot record a wrong arrival count for every day it closes.
    // It wins over `range` when both are sent.
    const dateParam = req.query.date;
    const window = dateParam
      ? (() => {
          const day = utcDayKey(utcDayStart(dateParam));
          const next = utcDayKey(new Date(utcDayStart(dateParam).getTime() + 86400000));
          // overdueBefore === checkInFrom means nothing can be overdue: the audit
          // asks a bounded historical question, and rows from other days would
          // inflate its count.
          return { range: null, checkInFrom: day, checkInTo: next, overdueBefore: day };
        })()
      : arrivalsWindow(req.query.range);

    // Two queries, not one: the in-range window, plus everything still expected
    // from BEFORE today. An overdue arrival is a problem the desk must see in
    // every view — today's strict window is exactly why a guest who was due
    // yesterday and never turned up used to vanish off the screen instead of
    // demanding action.
    const qs = (params) => new URLSearchParams({ status: 'CONFIRMED', ...params }).toString();

    let reservations = [];
    let degraded = false;
    try {
      const [inRange, overdue] = await Promise.all([
        reservationCall.call(
          `${RESERVATION_URL}/api/reservations?${qs({
            checkInFrom: window.checkInFrom,
            checkInTo: window.checkInTo,
          })}`
        ),
        // Skipped entirely for ?date= (range === null there): overdueBefore
        // equals checkInFrom in that branch by construction, so an overdue
        // query would just re-fetch rows the caller must not see. It is NOT
        // skipped for range= windows -- arrivalsWindow() also sets
        // overdueBefore equal to checkInFrom there (an overdue arrival must
        // show in every range), so that equality can't be used to tell the
        // two cases apart; only the branch itself can.
        window.range !== null
          ? reservationCall.call(
              `${RESERVATION_URL}/api/reservations?${qs({ checkInTo: window.overdueBefore })}`
            )
          : Promise.resolve([]),
      ]);
      // A reservation cannot be both in-range and overdue, but de-duplicate by
      // id anyway rather than trusting two independent queries to stay disjoint.
      const byId = new Map();
      for (const r of [...(overdue || []), ...(inRange || [])]) byId.set(r.id, r);
      reservations = [...byId.values()];
    } catch (err) {
      // Fall back to the local projection rather than failing the page. A desk
      // with a partial list can still work; a desk with an error cannot. But the
      // response says so — a short list that silently claims to be complete is
      // the exact failure this route was rewritten to remove.
      console.error('[Stay] Arrivals: reservation service unreachable, degrading:', err.message);
      degraded = true;
    }

    if (degraded) {
      const local = await prisma.stay.findMany({
        where: { status: 'PRE_ARRIVAL' },
        orderBy: { expectedCheckIn: 'asc' },
      });
      return res.json({
        range: window.range,
        degraded: true,
        arrivals: local.map((s) => ({
          id: s.id,
          stayId: s.id,
          reservationId: s.reservationId,
          guestId: s.guestId,
          guestName: s.guestName,
          confirmationNumber: null,
          expectedCheckIn: s.expectedCheckIn,
          expectedCheckOut: s.expectedCheckOut,
          nights: null,
          adults: null,
          children: null,
          roomTypeCode: null,
          status: 'PRE_ARRIVAL',
          overdue: false,
        })),
      });
    }

    // One query for every stay involved, rather than one per reservation.
    const stays = reservations.length
      ? await prisma.stay.findMany({
          where: { reservationId: { in: reservations.map((r) => r.id) } },
        })
      : [];
    const stayByReservation = new Map(stays.map((s) => [s.reservationId, s]));

    // Statuses that mean the guest is no longer expected at the door.
    const ARRIVED = new Set(['IN_HOUSE', 'DEPARTED', 'NO_SHOW']);
    const overdueBefore = new Date(`${window.overdueBefore}T00:00:00.000Z`);

    const arrivals = reservations
      .map((r) => {
        const stay = stayByReservation.get(r.id) || null;
        if (stay && ARRIVED.has(stay.status)) return null;
        const checkIn = r.checkIn ? new Date(r.checkIn) : null;
        return {
          // The React key. A reservation with no stay row has no stay id, so
          // fall back to a prefixed reservation id rather than emitting null.
          id: stay?.id || `res:${r.id}`,
          stayId: stay?.id || null,
          reservationId: r.id,
          guestId: r.guestId,
          guestName: r.guestName,
          confirmationNumber: r.confirmationNumber || null,
          expectedCheckIn: r.checkIn,
          expectedCheckOut: r.checkOut,
          nights: r.nights ?? null,
          adults: r.adults ?? null,
          children: r.children ?? null,
          roomTypeCode: r.roomTypeCode || null,
          status: stay?.status || 'PRE_ARRIVAL',
          overdue: Boolean(checkIn && checkIn < overdueBefore),
        };
      })
      .filter(Boolean)
      // Overdue first — those are the rows that need someone to do something.
      // Then by expected arrival, soonest first.
      .sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        return new Date(a.expectedCheckIn || 0) - new Date(b.expectedCheckIn || 0);
      });

    res.json({ range: window.range, degraded: false, arrivals });
  } catch (err) {
    console.error('[Stay] Arrivals error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/in-house
router.get('/in-house', requireRole(...ROLE_GROUPS.OPS_READ), async (req, res) => {
  try {
    const stays = await prisma.stay.findMany({ where: { status: 'IN_HOUSE' } });
    res.json(stays);
  } catch (err) {
    console.error('[Stay] In-house error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/departures?date=
router.get('/departures', requireRole(...ROLE_GROUPS.OPS_READ), async (req, res) => {
  try {
    const { start, end } = dayBounds(req.query.date);
    const deps = await prisma.stay.findMany({
      where: {
        status: 'IN_HOUSE',
        expectedCheckOut: { gte: start, lt: end },
      },
    });
    res.json(deps);
  } catch (err) {
    console.error('[Stay] Departures error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/check-in
router.post('/check-in', requireRole(...STAFF), async (req, res) => {
  try {
    const {
      reservationId,
      guestId,
      guestName,
      assignedRoomId,
      idVerification,
      depositAmount,
      keyCardsIssued,
    } = req.body;

    let stay = await prisma.stay.findFirst({ where: { reservationId } });

    // Verify the room server-side. Previously this route guarded the STAY's
    // status but never checked whether assignedRoomId was already occupied by a
    // DIFFERENT stay, so two arrivals could be checked into one room.
    const roomCheck = await validateRoomAssignment(assignedRoomId, stay?.id);
    if (!roomCheck.ok) return res.status(roomCheck.status).json({ error: roomCheck.error });

    if (stay) {
      if (stay.status === 'IN_HOUSE') {
        return res.status(409).json({ error: 'This reservation is already checked in.' });
      }
      if (stay.status === 'DEPARTED' || stay.status === 'NO_SHOW') {
        return res.status(409).json({ error: `Cannot check in a ${stay.status} stay.` });
      }
      stay = await prisma.stay.update({
        where: { id: stay.id },
        data: {
          status: 'IN_HOUSE',
          assignedRoomId,
          actualCheckInAt: new Date(),
          idVerification,
          depositAmount: depositAmount || 0,
          keyCardsIssued: keyCardsIssued || 1,
          guestName,
          guestId,
        },
      });
    } else {
      stay = await prisma.stay.create({
        data: {
          reservationId,
          guestId,
          guestName,
          assignedRoomId,
          status: 'IN_HOUSE',
          actualCheckInAt: new Date(),
          idVerification,
          depositAmount: depositAmount || 0,
          keyCardsIssued: keyCardsIssued || 1,
        },
      });
    }

    redis.publish(
      'room:checkin',
      JSON.stringify({
        event: 'guest.checked_in',
        stayId: stay.id,
        roomId: assignedRoomId,
        guestName,
        guestId,
        reservationId,
      })
    );

    res.status(201).json(stay);
  } catch (err) {
    console.error('[Stay] Check-in error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/check-out/:stayId
router.post('/check-out/:stayId', requireRole(...STAFF), async (req, res) => {
  try {
    const existing = await prisma.stay.findUnique({ where: { id: req.params.stayId } });
    if (!existing) return res.status(404).json({ error: 'Stay not found.' });
    if (existing.status !== 'IN_HOUSE') {
      return res
        .status(409)
        .json({ error: `Only an in-house stay can be checked out (current: ${existing.status}).` });
    }

    // EVERY folio on the stay must be clear, not just the first one. Bill splitting
    // means a stay can carry several folios, and releasing the room while one is
    // unpaid strands that balance with no guest left to bill it to.
    //
    // A folio service that is down or slow must NOT silently let an unpaid guest
    // walk: this fails closed and asks the desk to retry, which is the safe
    // direction for money.
    try {
      const { unsettled } = await folioCall.call(
        `${FOLIO_URL}/api/folios/outstanding?stayId=${encodeURIComponent(existing.id)}`
      );
      if (unsettled && unsettled.length) {
        return res.status(409).json({
          error: `Cannot check out: ${unsettled.length} folio(s) still carry a balance.`,
          folios: unsettled.map((f) => f.folioNumber),
        });
      }
    } catch (err) {
      console.error('[Stay] Folio balance check failed:', err.message);
      return res.status(503).json({ error: 'Could not confirm the guest has settled. Try again.' });
    }

    const checkOutAt = new Date();
    const stay = await prisma.stay.update({
      where: { id: req.params.stayId },
      data: { status: 'DEPARTED', actualCheckOutAt: checkOutAt },
    });

    // Nights actually stayed, for loyalty accrual. Prefer actual check-in;
    // fall back to expected. Minimum 1.
    const startAt = stay.actualCheckInAt || stay.expectedCheckIn;
    const nights = startAt ? Math.max(1, Math.round((checkOutAt - new Date(startAt)) / 86400000)) : 1;

    redis.publish(
      'room:checkout',
      JSON.stringify({
        event: 'guest.checked_out',
        stayId: stay.id,
        roomId: stay.assignedRoomId,
        guestName: stay.guestName,
        guestId: stay.guestId,
        nights,
      })
    );

    res.json(stay);
  } catch (err) {
    console.error('[Stay] Check-out error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/walk-in
router.post('/walk-in', requireRole(...STAFF), async (req, res) => {
  try {
    const { guestName, guestId, assignedRoomId, expectedCheckOut, depositAmount } = req.body;
    if (!guestName) return res.status(400).json({ error: 'guestName is required.' });

    // This route used to be a bare create() that trusted the client's roomId
    // entirely — WalkIn.jsx computed availability in the browser and the server
    // verified nothing. Two clerks with lists fetched seconds apart would both
    // be offered the same room and both succeed.
    const roomCheck = await validateRoomAssignment(assignedRoomId);
    if (!roomCheck.ok) return res.status(roomCheck.status).json({ error: roomCheck.error });

    const stay = await prisma.stay.create({
      data: {
        guestName,
        guestId,
        assignedRoomId,
        status: 'IN_HOUSE',
        actualCheckInAt: new Date(),
        expectedCheckOut: expectedCheckOut ? new Date(expectedCheckOut) : null,
        depositAmount: depositAmount || 0,
        keyCardsIssued: 1,
      },
    });

    redis.publish(
      'room:checkin',
      JSON.stringify({
        event: 'guest.checked_in',
        stayId: stay.id,
        roomId: assignedRoomId,
        guestName,
        guestId,
        walkIn: true,
      })
    );

    res.status(201).json(stay);
  } catch (err) {
    console.error('[Stay] Walk-in error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/no-show/:reservationId
router.post('/no-show/:reservationId', requireRole(...AUDIT_ROLES), async (req, res) => {
  try {
    const { feeCents } = req.body || {};
    // Only a not-yet-arrived stay can become a no-show. Don't touch in-house or
    // departed stays, and don't emit an event when nothing actually changed.
    const stay = await prisma.stay.updateMany({
      where: { reservationId: req.params.reservationId, status: 'PRE_ARRIVAL' },
      data: { status: 'NO_SHOW' },
    });
    if (stay.count === 0) {
      return res.status(409).json({ error: 'No pre-arrival stay to mark as no-show for this reservation.' });
    }
    redis.publish(
      'stay:no_show',
      JSON.stringify({
        reservationId: req.params.reservationId,
        feeCents: Number(feeCents || 0),
        markedBy: req.user?.username || req.user?.sub,
      })
    );
    res.json({ updated: stay.count });
  } catch (err) {
    console.error('[Stay] No-show error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/stays/:id/extend
router.post('/stays/:id/extend', requireRole(...STAFF), async (req, res) => {
  try {
    const { newCheckOut } = req.body;
    const parsed = new Date(newCheckOut);
    if (!newCheckOut || Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'A valid newCheckOut date is required.' });
    }
    const existing = await prisma.stay.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Stay not found.' });
    if (existing.status === 'DEPARTED' || existing.status === 'NO_SHOW') {
      return res.status(409).json({ error: `Cannot change the checkout date of a ${existing.status} stay.` });
    }
    const stay = await prisma.stay.update({
      where: { id: req.params.id },
      data: { expectedCheckOut: parsed },
    });
    redis.publish('stay:extended', JSON.stringify({ stayId: stay.id, newCheckOut }));
    res.json(stay);
  } catch (err) {
    console.error('[Stay] Extend error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/stays/:id/room-change
router.post('/stays/:id/room-change', requireRole(...STAFF), async (req, res) => {
  try {
    const { newRoomId, reason } = req.body;
    const before = await prisma.stay.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Stay not found.' });
    if (before.status !== 'IN_HOUSE') {
      return res
        .status(409)
        .json({ error: `Only an in-house stay can be moved (current: ${before.status}).` });
    }

    // Same validation as check-in — a room move is a check-in to a different
    // room, and was equally unguarded.
    const roomCheck = await validateRoomAssignment(newRoomId, before.id);
    if (!roomCheck.ok) return res.status(roomCheck.status).json({ error: roomCheck.error });

    const stay = await prisma.stay.update({
      where: { id: req.params.id },
      data: { assignedRoomId: newRoomId },
    });
    redis.publish(
      'stay:room_changed',
      JSON.stringify({
        stayId: stay.id,
        fromRoomId: before?.assignedRoomId,
        toRoomId: newRoomId,
        reason,
      })
    );
    res.json(stay);
  } catch (err) {
    console.error('[Stay] Room change error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/stays/:id/early-departure
router.post('/stays/:id/early-departure', requireRole(...STAFF), async (req, res) => {
  try {
    const { reason, unusedNights, nightlyRateCents } = req.body;
    const before = await prisma.stay.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Stay not found.' });
    if (before.status !== 'IN_HOUSE') {
      return res.status(400).json({ error: `Stay is ${before.status}, not IN_HOUSE.` });
    }

    const now = new Date();
    const stay = await prisma.stay.update({
      where: { id: req.params.id },
      data: {
        status: 'DEPARTED',
        actualCheckOutAt: now,
        expectedCheckOut: now,
      },
    });

    redis.publish(
      'stay:early_departure',
      JSON.stringify({
        stayId: stay.id,
        folioId: stay.folioId,
        roomId: stay.assignedRoomId,
        guestId: stay.guestId,
        reason,
        unusedNights: unusedNights || 0,
        nightlyRateCents: nightlyRateCents || 0,
      })
    );
    redis.publish(
      'room:checkout',
      JSON.stringify({
        event: 'guest.checked_out',
        stayId: stay.id,
        roomId: stay.assignedRoomId,
        guestName: stay.guestName,
        guestId: stay.guestId,
        earlyDeparture: true,
      })
    );

    res.json(stay);
  } catch (err) {
    console.error('[Stay] Early departure error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/stays?reservationId=&guestId=&status=
router.get('/stays', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const { reservationId, guestId, status } = req.query;
    const where = {};
    if (reservationId) where.reservationId = reservationId;
    if (guestId) where.guestId = guestId;
    if (status) where.status = status;
    const list = await prisma.stay.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(list);
  } catch (err) {
    console.error('[Stay] List stays error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/stays/:id — single stay by id, JSON. Added for the folio print
// route (Changes-to-be-made doc, item 2), which needs actual arrival/departure
// times and the reservationId for a given folio's stayId.
router.get('/stays/:id', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const stay = await prisma.stay.findUnique({ where: { id: req.params.id } });
    if (!stay) return res.status(404).json({ error: 'Not found.' });
    res.json(stay);
  } catch (err) {
    console.error('[Stay] Get error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/stays/:id/registration-card — renders registration card as PDF
router.get('/stays/:id/registration-card', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const stay = await prisma.stay.findUnique({ where: { id: req.params.id } });
    if (!stay) return res.status(404).json({ error: 'Not found.' });

    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="regcard-${stay.id}.pdf"`);
    doc.pipe(res);

    doc.fontSize(20).text('InnSight PMS', { align: 'left' });
    doc.fontSize(12).fillColor('#555').text('Guest Registration Card', { align: 'left' });
    doc.moveDown();
    doc.fillColor('black').fontSize(10);

    const row = (label, value) => {
      doc.font('Helvetica-Bold').text(label, { continued: true, width: 150 });
      doc.font('Helvetica').text(`  ${value ?? '—'}`);
    };

    row('Stay ID:', stay.id);
    row('Reservation:', stay.reservationId);
    row('Guest Name:', stay.guestName);
    row('Guest ID:', stay.guestId);
    row('Assigned Room:', stay.assignedRoomId);
    row('Status:', stay.status);
    row('Expected Check-In:', stay.expectedCheckIn?.toISOString().slice(0, 16).replace('T', ' '));
    row('Expected Check-Out:', stay.expectedCheckOut?.toISOString().slice(0, 16).replace('T', ' '));
    row('Actual Check-In:', stay.actualCheckInAt?.toISOString().slice(0, 16).replace('T', ' '));
    row('Key Cards Issued:', stay.keyCardsIssued);
    row('Deposit (cents):', stay.depositAmount);

    // The guest's digital copy. Encodes the guest portal, which already exists at
    // /portal/:confirmationNumber, so scanning gives them their booking without an
    // account or an app.
    //
    // Drawn at a fixed position rather than in the text flow: doc.image() does not
    // advance the cursor predictably, and the acknowledgement paragraph below has
    // to keep its place on the page. Absolute x/y is the only way this stays put as
    // the row list above grows or shrinks.
    // The portal keys strictly on the confirmation number, which a Stay does not
    // carry — only reservationId. Resolve it, and if that fails, print NO code:
    // a QR that leads to "Not found" is worse than a card without one.
    let confirmationNumber = null;
    if (stay.reservationId) {
      try {
        const r = await reservationCall.call(
          `${RESERVATION_URL}/api/reservations/${encodeURIComponent(stay.reservationId)}`
        );
        confirmationNumber = r?.confirmationNumber || null;
      } catch (err) {
        console.error('[Stay] Could not resolve confirmation number for QR:', err.message);
      }
    }

    // doc.text() with explicit x/width leaves BOTH the cursor and the wrap width
    // where it put them, so everything after the QR caption inherited the code's
    // 108pt column — the acknowledgement paragraph rendered as a narrow strip down
    // the right margin. Remember where the detail rows ended and restore it.
    const yAfterRows = doc.y;
    try {
      if (!confirmationNumber) throw new Error('no confirmation number to link to');
      const portalLink = publicUrl(`/portal/${encodeURIComponent(confirmationNumber)}`);
      doc.image(await qrPngBuffer(portalLink), 420, 96, { width: 108 });
      doc.fontSize(7.5).fillColor('#666').text('Scan for your digital copy', 420, 208, {
        width: 108,
        align: 'center',
      });
      if (!publicUrl.isScannableByPhone) {
        // Says so on the paper rather than letting a student blame their phone.
        doc.fontSize(6.5).text('(demo link — reachable on this machine only)', 420, 220, {
          width: 108,
          align: 'center',
        });
      }
      doc.fillColor('black').fontSize(10);
    } catch (qrErr) {
      // A registration card without a QR is still a valid registration card. Never
      // fail the guest's document over the convenience feature on it.
      console.error('[Stay] QR render failed, card issued without one:', qrErr.message);
    }

    // Back to the left margin, below the rows, at full width.
    doc.fontSize(10).fillColor('black').text('', 48, Math.max(yAfterRows, doc.y), { width: 500 });
    doc.moveDown();

    doc
      .fontSize(9)
      .fillColor('#555')
      .text(
        'I, the undersigned, acknowledge that the information above is correct and agree to the house rules, ' +
          'applicable rates, and policies of the hotel.',
        { align: 'justify' }
      );
    doc.moveDown(3);
    doc.fillColor('black').fontSize(10);
    doc.text('Guest Signature: ______________________________', 48);
    doc.moveDown();
    doc.text('Date: ______________________________', 48);

    doc.moveDown(2);
    doc
      .fontSize(8)
      .fillColor('#888')
      .text(`Printed ${new Date().toISOString().slice(0, 19).replace('T', ' ')} — InnSight PMS`, {
        align: 'center',
      });

    doc.end();
  } catch (err) {
    console.error('[Stay] Reg card print error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
