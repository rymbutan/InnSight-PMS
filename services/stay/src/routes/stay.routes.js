const express = require('express');
const PDFDocument = require('pdfkit');
const Redis = require('ioredis');
const { requireRole, JWT_SECRET, ROLE_GROUPS } = require('../middleware/auth');
const { makeInventoryClient } = require('../lib/inventoryClient');
const { localDayBounds, parseLocalDay } = require('../lib/date');

const AUDIT_ROLES = ['ADMIN', 'MANAGER', 'AUDITOR'];
const STAFF = ['ADMIN', 'MANAGER', 'FRONT_DESK']; // front-desk operations

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
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

// GET /api/arrivals?date=
router.get('/arrivals', requireRole(...ROLE_GROUPS.OPS_READ), async (req, res) => {
  try {
    const { start, end } = dayBounds(req.query.date);
    const arrivals = await prisma.stay.findMany({
      where: {
        status: 'PRE_ARRIVAL',
        expectedCheckIn: { gte: start, lt: end },
      },
      orderBy: { expectedCheckIn: 'asc' },
    });
    res.json(arrivals);
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
