const express = require('express');
const crypto = require('crypto');
const Redis = require('ioredis');
const { requireRole, ROLE_GROUPS } = require('../middleware/auth');
const { eachNight, utcDayStart, utcDayKey } = require('../lib/date');
const { leafFacilityIds } = require('../lib/conflictScope');

const _ADMIN = ['ADMIN', 'MANAGER'];
// Property configuration — rooms, prices, rate plans, amenity catalog — is
// ADMIN-only (managers can operate the desk but not change the property setup).
const ROOM_ADMIN = ['ADMIN'];
// Room status transitions are performed by housekeeping/maintenance and the
// front desk too. HOUSEKEEPING and MAINTENANCE were merged into one role
// (Unified Staff Role) — see ROLE_GROUPS.MAINT in middleware/auth.js.
const ROOM_STATUS_ROLES = ['ADMIN', 'MANAGER', 'HOUSEKEEPING_MAINTENANCE', 'FRONT_DESK'];
const BOOKING = ['ADMIN', 'MANAGER', 'FRONT_DESK']; // placing/releasing inventory holds & facility bookings

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
// Without an 'error' listener, ioredis throws on a connection blip and takes
// the whole process down — which for this service means the capacity gate
// disappears. Other files in this repo already do this; these did not.
redis.on('error', (e) => console.error('[Inventory] redis error:', e.message));

// GET /api/availability/find-room?typeCode=&checkIn=&checkOut=
//
// Two answers in one response, deliberately different:
//
//   `room`       one free room, GATED on room-type availability. The original
//                contract; unchanged.
//   `candidates` every physically usable room of the type, ordered the way
//                front-desk staff pick (lowest floor, then lowest number), and
//                NOT gated on availability.
//
// `candidates` exists because the reservation service assigns a room to a
// booking whose capacity it has ALREADY held. That hold is what makes
// `available` read 0, so gating the list would have made the last room of a
// type unassignable to the very booking that reserved it — leaving it with no
// room and therefore invisible on the calendar.
//
// Nor does `candidates` filter on Room.status beyond the two unusable states.
// Room.status describes the room RIGHT NOW: OCCUPIED or DIRTY tonight says
// nothing about a booking three weeks out. Whether a room is free for a DATE
// RANGE depends on assignedRoomId, which lives in the reservation database —
// see services/reservation/src/lib/roomAssignment.js.
router.get('/availability/find-room', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const { typeCode, checkIn, checkOut, excludeRoomId } = req.query;
    if (!typeCode || !checkIn || !checkOut)
      return res.status(400).json({ error: 'typeCode, checkIn, checkOut required.' });
    // Normalise to UTC day starts so the range matches the UTC-midnight `date`
    // keys the holds are written with, whatever format the caller sent.
    let ci, co;
    try {
      ci = utcDayStart(checkIn);
      co = utcDayStart(checkOut);
    } catch {
      return res.status(400).json({ error: 'Invalid checkIn/checkOut.' });
    }
    const rooms = await prisma.room.findMany({
      where: {
        typeCode,
        status: { notIn: ['OUT_OF_ORDER', 'OUT_OF_SERVICE', 'OCCUPIED'] },
        ...(excludeRoomId ? { id: { not: excludeRoomId } } : {}),
      },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    });
    // Holds are tracked per room-type per night (there is no per-room hold), so a
    // room type is bookable only while the busiest night in the range still has
    // inventory left. peakHeld is the max rooms held on any single night.
    const holds = await prisma.inventoryHold.findMany({
      where: {
        roomTypeCode: typeCode,
        status: { in: ['ACTIVE', 'COMMITTED'] },
        date: { gte: ci, lt: co },
        expiresAt: { gt: new Date() },
      },
    });
    const rt = await prisma.roomType.findUnique({ where: { code: typeCode } });
    const perNight = new Map();
    for (const h of holds) {
      const key = utcDayKey(h.date);
      perNight.set(key, (perNight.get(key) || 0) + h.quantity);
    }
    const peakHeld = perNight.size ? Math.max(...perNight.values()) : 0;
    const available = rt ? Math.max(0, rt.totalInventory - peakHeld) : 0;
    const free = available > 0 ? rooms[0] || null : null;
    // Unusable states only — see the header comment on why status is not
    // filtered further and why this list is ungated.
    const candidates = await prisma.room.findMany({
      where: {
        typeCode,
        status: { notIn: ['OUT_OF_ORDER', 'OUT_OF_SERVICE'] },
        ...(excludeRoomId ? { id: { not: excludeRoomId } } : {}),
      },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    });
    res.json({ room: free, candidates, candidatesChecked: rooms.length, available, peakHeld });
  } catch (err) {
    console.error('[Inventory] find-room error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/availability?checkIn=&checkOut=&roomType=
router.get('/availability', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const { checkIn, checkOut, roomType } = req.query;
    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: 'checkIn and checkOut required.' });
    }

    const roomTypes = roomType
      ? await prisma.roomType.findMany({ where: { code: roomType } })
      : await prisma.roomType.findMany();

    // UTC day starts, to match the `date` keys holds are written with.
    let checkInDate, checkOutDate;
    try {
      checkInDate = utcDayStart(checkIn);
      checkOutDate = utcDayStart(checkOut);
    } catch {
      return res.status(400).json({ error: 'Invalid checkIn/checkOut.' });
    }

    const results = [];
    for (const rt of roomTypes) {
      const holds = await prisma.inventoryHold.findMany({
        where: {
          roomTypeCode: rt.code,
          status: { in: ['ACTIVE', 'COMMITTED'] },
          date: { gte: checkInDate, lt: checkOutDate },
          expiresAt: { gt: new Date() },
        },
      });
      // A booking occupies one room on each of its nights, so availability for a
      // range is limited by the single busiest night, not the sum across nights.
      const perNight = new Map();
      for (const h of holds) {
        const key = utcDayKey(h.date);
        perNight.set(key, (perNight.get(key) || 0) + h.quantity);
      }
      const peakHeld = perNight.size ? Math.max(...perNight.values()) : 0;
      results.push({
        roomTypeCode: rt.code,
        name: rt.name,
        baseRate: rt.baseRate,
        totalInventory: rt.totalInventory,
        available: Math.max(0, rt.totalInventory - peakHeld),
      });
    }

    res.json(results);
  } catch (err) {
    console.error('[Inventory] Availability error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY HOLDS — the single authoritative gate on room-type capacity.
//
// This service owns capacity. Every booking path (staff wizard, public engine,
// walk-in) MUST acquire a hold here before persisting a reservation. Nothing
// else in the platform is permitted to write InventoryHold rows — the previous
// design had the Redis subscriber creating holds with no capacity check at all,
// which made oversell unbounded rather than merely racy.
//
// HOW THE RACE IS CLOSED
// ----------------------
// `SELECT ... FOR UPDATE` on the RoomType row is taken as the FIRST statement in
// the transaction. Every concurrent request for the same room type therefore
// queues on that one row lock, so the count-then-create sequence is fully
// serialized. Prisma has no first-class API for row locks, so this is the one
// place in the codebase that uses $queryRaw — deliberately, and it is a
// parameterized tagged template, not string concatenation.
//
// Postgres READ COMMITTED is sufficient here precisely BECAUSE of the explicit
// lock; SERIALIZABLE would add retry handling for no extra safety.
// ─────────────────────────────────────────────────────────────────────────────

// How long an unattached hold survives before capacity is handed back. Long
// enough to cover a reservation insert plus retries, short enough that a crashed
// caller does not park inventory for a meaningful length of time.
const UNATTACHED_HOLD_TTL_SECONDS = 120;

// Checkout morning for a hold set = the last night + 1 day. Always returns a new
// Date so callers cannot accidentally mutate a night key they are also inserting.
function checkoutMorning(lastNight) {
  const d = new Date(lastNight.getTime());
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

// POST /api/holds
// Body: { roomTypeCode, checkIn, checkOut, quantity?, ttlSeconds?, reservationId? }
//   or: { roomTypeCode, date, reservationId, quantity?, ttlSeconds? }   (single night)
//
// Returns 201 { groupId, nights, quantity, expiresAt, holds[] }
//      or 409 { error, roomTypeCode, firstFullNight, totalInventory } when full.
router.post('/holds', requireRole(...BOOKING), async (req, res) => {
  try {
    const { roomTypeCode, date, checkIn, checkOut, reservationId, quantity, ttlSeconds } = req.body;
    if (!roomTypeCode) return res.status(400).json({ error: 'roomTypeCode is required.' });

    // Work out which nights this hold covers.
    let nights;
    try {
      if (checkIn && checkOut) {
        nights = eachNight(checkIn, checkOut);
        if (!nights.length) return res.status(400).json({ error: 'checkOut must be after checkIn.' });
      } else if (date) {
        nights = [utcDayStart(date)];
      } else {
        return res.status(400).json({ error: 'Either checkIn+checkOut or date is required.' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid date.' });
    }

    const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    const groupId = crypto.randomUUID();
    // An attached hold (reservationId supplied up front) lives until checkout
    // morning; an unattached one gets the short reserve-phase TTL.
    // NOTE: clone the night before adding a day — mutating nights[] in place
    // would corrupt the very date we are about to insert.
    const expiresAt = reservationId
      ? checkoutMorning(nights[nights.length - 1])
      : new Date(Date.now() + (ttlSeconds || UNATTACHED_HOLD_TTL_SECONDS) * 1000);

    const created = await prisma.$transaction(
      async (px) => {
        // (1) Serialize every concurrent booking of this room type on one row lock.
        const locked = await px.$queryRaw`
          SELECT code, "totalInventory" FROM "RoomType" WHERE code = ${roomTypeCode} FOR UPDATE
        `;
        if (!locked.length) {
          throw Object.assign(new Error('Unknown room type.'), { statusCode: 400 });
        }
        const totalInventory = Number(locked[0].totalInventory);

        // (2) Count what is already held on each night in range. Safe to read
        //     after the lock — no other hold-writer for this type can be mid-flight.
        const existing = await px.inventoryHold.groupBy({
          by: ['date'],
          where: {
            roomTypeCode,
            status: { in: ['ACTIVE', 'COMMITTED'] },
            date: { in: nights },
            expiresAt: { gt: new Date() },
          },
          _sum: { quantity: true },
        });
        const heldByNight = new Map(existing.map((r) => [r.date.getTime(), r._sum.quantity || 0]));

        // (3) Hard block. A booking occupies one room on EVERY night it spans, so
        //     if any single night is full the whole booking is refused.
        for (const night of nights) {
          const held = heldByNight.get(night.getTime()) || 0;
          if (held + qty > totalInventory) {
            throw Object.assign(new Error('No inventory available for the requested dates.'), {
              statusCode: 409,
              detail: {
                roomTypeCode,
                firstFullNight: utcDayKey(night),
                totalInventory,
                alreadyHeld: held,
                requested: qty,
              },
            });
          }
        }

        // (4) Claim it.
        await px.inventoryHold.createMany({
          data: nights.map((night) => ({
            groupId,
            roomTypeCode,
            date: night,
            reservationId: reservationId || null,
            quantity: qty,
            expiresAt,
            status: 'ACTIVE',
          })),
        });
        return px.inventoryHold.findMany({ where: { groupId }, orderBy: { date: 'asc' } });
      },
      // The row lock is held for the duration, so keep the window bounded and
      // allow a queue to form under a burst rather than failing fast.
      { timeout: 10000, maxWait: 8000 }
    );

    redis.publish(
      'inventory:held',
      JSON.stringify({
        groupId,
        roomTypeCode,
        reservationId: reservationId || null,
        nights: nights.length,
      })
    );
    res.status(201).json({
      groupId,
      roomTypeCode,
      nights: nights.map(utcDayKey),
      quantity: qty,
      expiresAt,
      reservationId: reservationId || null,
      holds: created,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, ...(err.detail || {}) });
    }
    console.error('[Inventory] Create hold error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/holds/:groupId/attach
// Second phase of the two-phase booking: bind an unattached hold to the
// reservation row that was just inserted, and extend its life to checkout.
router.post('/holds/:groupId/attach', requireRole(...BOOKING), async (req, res) => {
  try {
    const { reservationId } = req.body;
    if (!reservationId) return res.status(400).json({ error: 'reservationId is required.' });

    const holds = await prisma.inventoryHold.findMany({
      where: { groupId: req.params.groupId },
      orderBy: { date: 'asc' },
    });
    if (!holds.length) return res.status(404).json({ error: 'Hold group not found.' });
    if (holds.some((h) => h.status !== 'ACTIVE')) {
      return res.status(409).json({ error: 'Hold group is no longer ACTIVE.' });
    }
    // An expired group has already handed its capacity back; re-attaching would
    // resurrect a claim that another booking may since have taken.
    if (holds.some((h) => h.expiresAt <= new Date())) {
      return res.status(409).json({ error: 'Hold group expired before it was attached.' });
    }

    const checkoutAt = checkoutMorning(holds[holds.length - 1].date);

    // expiresAt is part of the WHERE clause, not a separate pre-check: reading
    // it first and writing second leaves a window in which a group expiring in
    // between gets resurrected, re-claiming capacity another booking may already have taken.
    const bound = await prisma.inventoryHold.updateMany({
      where: { groupId: req.params.groupId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
      data: { reservationId, expiresAt: checkoutAt },
    });
    if (bound.count === 0) {
      return res.status(409).json({ error: 'Hold group expired before it was attached.' });
    }

    redis.publish(
      'inventory:held',
      JSON.stringify({
        groupId: req.params.groupId,
        reservationId,
        attached: true,
      })
    );
    res.json({ groupId: req.params.groupId, reservationId, expiresAt: checkoutAt, nights: holds.length });
  } catch (err) {
    console.error('[Inventory] Attach hold error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/holds/:groupId
// Compensating action when a booking fails after the hold was taken. Also used
// by the reservation-cancelled subscriber.
router.delete('/holds/:groupId', requireRole(...BOOKING), async (req, res) => {
  try {
    // Only ACTIVE holds are releasable — releasing a COMMITTED hold would put a
    // sold room back on the market while the reservation still exists.
    const result = await prisma.inventoryHold.updateMany({
      where: { groupId: req.params.groupId, status: 'ACTIVE' },
      data: { status: 'RELEASED' },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: 'Hold group not found or not in a releasable (ACTIVE) state.' });
    }
    redis.publish(
      'inventory:released',
      JSON.stringify({ groupId: req.params.groupId, nights: result.count })
    );
    res.json({ groupId: req.params.groupId, released: result.count });
  } catch (err) {
    console.error('[Inventory] Release hold error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/holds/:groupId/commit
router.post('/holds/:groupId/commit', requireRole(...BOOKING), async (req, res) => {
  try {
    const result = await prisma.inventoryHold.updateMany({
      where: { groupId: req.params.groupId, status: 'ACTIVE' },
      data: { status: 'COMMITTED' },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: 'Hold group not found or not in a committable (ACTIVE) state.' });
    }
    redis.publish(
      'inventory:committed',
      JSON.stringify({ groupId: req.params.groupId, nights: result.count })
    );
    res.json({ groupId: req.params.groupId, committed: result.count });
  } catch (err) {
    console.error('[Inventory] Commit hold error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/rooms
router.get('/rooms', requireRole(...ROLE_GROUPS.ALL_STAFF), async (req, res) => {
  try {
    const { status, typeCode } = req.query;
    const where = {};
    if (status) where.status = status;
    if (typeCode) where.typeCode = typeCode;
    const rooms = await prisma.room.findMany({
      where,
      orderBy: { number: 'asc' },
      include: { roomType: true },
    });
    res.json(rooms);
  } catch (err) {
    console.error('[Inventory] List rooms error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/rooms/:id
// Single room lookup. Added so other services can validate a room assignment
// server-side instead of trusting a client-supplied roomId — the stay service
// uses this to confirm a room exists and is in a habitable status before
// checking a guest into it.
router.get('/rooms/:id', requireRole(...ROLE_GROUPS.ALL_STAFF), async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { id: req.params.id },
      include: { roomType: true },
    });
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    res.json(room);
  } catch (err) {
    console.error('[Inventory] Get room error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/room-types
router.get('/room-types', requireRole(...ROLE_GROUPS.ALL_STAFF), async (req, res) => {
  try {
    const types = await prisma.roomType.findMany({ orderBy: { baseRate: 'asc' } });
    res.json(types);
  } catch (err) {
    console.error('[Inventory] List room types error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/rate-plans
router.get('/rate-plans', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const { roomTypeCode } = req.query;
    const where = {};
    if (roomTypeCode) where.roomTypeCode = roomTypeCode;
    const plans = await prisma.ratePlan.findMany({ where, orderBy: { validFrom: 'desc' } });
    res.json(plans);
  } catch (err) {
    console.error('[Inventory] List rate plans error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/room-types
router.post('/room-types', requireRole(...ROOM_ADMIN), async (req, res) => {
  try {
    const { code, name, baseRate, maxOccupancy, totalInventory } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required.' });
    const rt = await prisma.roomType.create({
      data: {
        code,
        name,
        baseRate: baseRate || 0,
        maxOccupancy: maxOccupancy || 2,
        totalInventory: totalInventory || 0,
      },
    });
    res.status(201).json(rt);
  } catch (err) {
    console.error('[Inventory] Create room type error:', err.message);
    if (err.code === 'P2002') return res.status(409).json({ error: 'Room type code already exists.' });
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/room-types/:code  (edit price/details at any time — ADMIN only)
router.patch('/room-types/:code', requireRole(...ROOM_ADMIN), async (req, res) => {
  try {
    const { name, baseRate, maxOccupancy, totalInventory } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (baseRate !== undefined) {
      if (!Number.isInteger(baseRate) || baseRate < 0)
        return res.status(400).json({ error: 'baseRate must be a non-negative integer (cents).' });
      data.baseRate = baseRate;
    }
    if (maxOccupancy !== undefined) {
      if (!Number.isInteger(maxOccupancy) || maxOccupancy < 1)
        return res.status(400).json({ error: 'maxOccupancy must be a positive integer.' });
      data.maxOccupancy = maxOccupancy;
    }
    if (totalInventory !== undefined) {
      if (!Number.isInteger(totalInventory) || totalInventory < 0)
        return res.status(400).json({ error: 'totalInventory must be a non-negative integer.' });
      data.totalInventory = totalInventory;
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No editable fields provided.' });
    const rt = await prisma.roomType.update({ where: { code: req.params.code }, data }).catch((e) => {
      if (e.code === 'P2025') return null;
      throw e;
    });
    if (!rt) return res.status(404).json({ error: 'Room type not found.' });
    // Notify open screens (rate/availability displays) that pricing changed.
    redis.publish('room:status_changed', JSON.stringify({ roomTypeCode: rt.code, priceChanged: true }));
    res.json(rt);
  } catch (err) {
    console.error('[Inventory] Update room type error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/room-types/:code — retire a room type entirely (ADMIN only)
//
// Added because there was no way to remove one, and it showed: every run of
// scripts/prove-no-double-booking.mjs created two throwaway "Race Test" types
// and left them in the rates screen forever, because the script had nothing to
// call. Test fixtures that cannot be cleaned up become permanent furniture.
//
// Deletion is REFUSED while anything still points at the type rather than
// cascading. Rooms carry a foreign key to it, live holds are counted against its
// inventory, and reservations in another service reference it by code with no
// foreign key at all — a cascade here would leave those reservations naming a
// room type that no longer exists, and availability could never be recomputed
// for them. Say what is in the way and let an admin clear it deliberately.
router.delete('/room-types/:code', requireRole(...ROOM_ADMIN), async (req, res) => {
  try {
    const code = req.params.code;
    const type = await prisma.roomType.findUnique({ where: { code } });
    if (!type) return res.status(404).json({ error: 'Room type not found.' });

    const rooms = await prisma.room.count({ where: { typeCode: code } });
    if (rooms > 0) {
      return res.status(409).json({
        error: `${rooms} room${rooms === 1 ? '' : 's'} still use this type. Delete or retype them first.`,
      });
    }

    // Only holds that still count toward availability block the delete. An
    // expired or released one is history, and history should not pin a type in
    // the rates screen forever.
    const holds = await prisma.inventoryHold.count({
      where: {
        roomTypeCode: code,
        status: { in: ['ACTIVE', 'COMMITTED'] },
        expiresAt: { gt: new Date() },
      },
    });
    if (holds > 0) {
      return res.status(409).json({
        error: `${holds} live booking hold${holds === 1 ? '' : 's'} reference this type.`,
      });
    }

    // Rate plans are owned BY the type and mean nothing without it, so they go
    // with it — unlike rooms and holds, nothing outside this service reads them.
    await prisma.$transaction([
      prisma.ratePlan.deleteMany({ where: { roomTypeCode: code } }),
      prisma.inventoryHold.deleteMany({ where: { roomTypeCode: code } }),
      prisma.roomType.delete({ where: { code } }),
    ]);

    redis.publish('room:status_changed', JSON.stringify({ roomTypeCode: code, deleted: true }));
    res.status(204).end();
  } catch (err) {
    console.error('[Inventory] Delete room type error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/rooms
router.post('/rooms', requireRole(...ROOM_ADMIN), async (req, res) => {
  try {
    const { id, number, typeCode, floor, features } = req.body;
    if (!number || !typeCode) return res.status(400).json({ error: 'number and typeCode required.' });
    const room = await prisma.room.create({
      data: {
        id: id || `ROOM-${number}`,
        number,
        typeCode,
        floor: floor || 1,
        features,
      },
    });
    res.status(201).json(room);
  } catch (err) {
    console.error('[Inventory] Create room error:', err.message);
    if (err.code === 'P2002') return res.status(409).json({ error: 'Room number already exists.' });
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/rooms/:id/status  (housekeeping status transitions)
router.patch('/rooms/:id/status', requireRole(...ROOM_STATUS_ROLES), async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['CLEAN', 'CLEAN_INSPECTED', 'DIRTY', 'OCCUPIED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}.` });
    }
    const room = await prisma.room
      .update({
        where: { id: req.params.id },
        data: { status },
      })
      .catch((e) => {
        if (e.code === 'P2025') return null;
        throw e;
      });
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    redis.publish(
      'room:status_changed',
      JSON.stringify({
        roomId: room.id,
        number: room.number,
        status: room.status,
        changedBy: req.user?.sub,
      })
    );
    res.json(room);
  } catch (err) {
    console.error('[Inventory] Update room status error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/rate-plans
router.post('/rate-plans', requireRole(...ROOM_ADMIN), async (req, res) => {
  try {
    const { roomTypeCode, name, baseRate, validFrom, validTo } = req.body;
    if (!roomTypeCode || !name || !validFrom || !validTo) {
      return res.status(400).json({ error: 'roomTypeCode, name, validFrom, validTo required.' });
    }
    const plan = await prisma.ratePlan.create({
      data: {
        roomTypeCode,
        name,
        baseRate: baseRate || 0,
        validFrom: new Date(validFrom),
        validTo: new Date(validTo),
      },
    });
    res.status(201).json(plan);
  } catch (err) {
    console.error('[Inventory] Create rate plan error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Amenities / Facilities (non-room, pay-per-use). Admin manages the catalog;
// front desk sells walk-in usage (via folio POS) and books reservable ones.
// ─────────────────────────────────────────────────────────────────────────────
const FACILITY_CATEGORIES = [
  'EVENT_HALL',
  'GYM',
  'POOL',
  'RESTAURANT',
  'SPA',
  'PARKING',
  'LAUNDRY',
  'MEETING_ROOM',
  'OTHER',
];
const PRICING_MODELS = ['PER_USE', 'PER_HOUR', 'PER_PERSON', 'PER_DAY'];

// Authoritative price computation for a facility usage (shared shape with folio POS).
function facilityTotalCents(f, { units, persons, startAt, endAt } = {}) {
  const p = f.priceCents;
  if (f.pricingModel === 'PER_HOUR') {
    const hrs =
      startAt && endAt
        ? Math.max(1, Math.ceil((new Date(endAt) - new Date(startAt)) / 3600000))
        : Math.max(1, units || 1);
    return p * hrs;
  }
  if (f.pricingModel === 'PER_DAY') {
    const days =
      startAt && endAt
        ? Math.max(1, Math.ceil((new Date(endAt) - new Date(startAt)) / 86400000))
        : Math.max(1, units || 1);
    return p * days;
  }
  if (f.pricingModel === 'PER_PERSON') return p * Math.max(1, persons || units || 1);
  return p * Math.max(1, units || 1); // PER_USE
}

// GET /api/facilities?active=true&category=
router.get('/facilities', requireRole(...ROLE_GROUPS.ALL_STAFF), async (req, res) => {
  try {
    const where = {};
    if (req.query.active === 'true') where.active = true;
    if (req.query.category) where.category = req.query.category;
    const list = await prisma.facility.findMany({ where, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    res.json(list);
  } catch (err) {
    console.error('[Inventory] List facilities error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/facilities/:code
router.get('/facilities/:code', requireRole(...ROLE_GROUPS.ALL_STAFF), async (req, res) => {
  try {
    const f = await prisma.facility.findUnique({ where: { code: req.params.code } });
    if (!f) return res.status(404).json({ error: 'Facility not found.' });
    res.json(f);
  } catch (err) {
    console.error('[Inventory] Get facility error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/facilities  (ADMIN)
router.post('/facilities', requireRole(...ROOM_ADMIN), async (req, res) => {
  try {
    const { code, name, category, pricingModel, priceCents, unit, capacity, reservable, description } =
      req.body;
    if (!code || !name || !category || !pricingModel) {
      return res.status(400).json({ error: 'code, name, category, pricingModel required.' });
    }
    if (!FACILITY_CATEGORIES.includes(category))
      return res.status(400).json({ error: `category must be one of ${FACILITY_CATEGORIES.join(', ')}.` });
    if (!PRICING_MODELS.includes(pricingModel))
      return res.status(400).json({ error: `pricingModel must be one of ${PRICING_MODELS.join(', ')}.` });
    if (!Number.isInteger(priceCents) || priceCents < 0)
      return res.status(400).json({ error: 'priceCents must be a non-negative integer.' });
    const f = await prisma.facility.create({
      data: {
        code,
        name,
        category,
        pricingModel,
        priceCents,
        unit: unit || null,
        capacity: Number.isInteger(capacity) ? capacity : null,
        reservable: !!reservable,
        description: description || null,
      },
    });
    redis.publish('facility:changed', JSON.stringify({ code: f.code, action: 'created' }));
    res.status(201).json(f);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Facility code already exists.' });
    console.error('[Inventory] Create facility error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/facilities/:code  (ADMIN) — edit price/details, activate/deactivate
router.patch('/facilities/:code', requireRole(...ROOM_ADMIN), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    if (b.name !== undefined) data.name = b.name;
    if (b.category !== undefined) {
      if (!FACILITY_CATEGORIES.includes(b.category))
        return res.status(400).json({ error: 'Invalid category.' });
      data.category = b.category;
    }
    if (b.pricingModel !== undefined) {
      if (!PRICING_MODELS.includes(b.pricingModel))
        return res.status(400).json({ error: 'Invalid pricingModel.' });
      data.pricingModel = b.pricingModel;
    }
    if (b.priceCents !== undefined) {
      if (!Number.isInteger(b.priceCents) || b.priceCents < 0)
        return res.status(400).json({ error: 'priceCents must be a non-negative integer.' });
      data.priceCents = b.priceCents;
    }
    if (b.unit !== undefined) data.unit = b.unit;
    if (b.capacity !== undefined)
      data.capacity = b.capacity === null ? null : Number.isInteger(b.capacity) ? b.capacity : undefined;
    if (b.reservable !== undefined) data.reservable = !!b.reservable;
    if (b.active !== undefined) data.active = !!b.active;
    if (b.description !== undefined) data.description = b.description;
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No editable fields provided.' });
    const f = await prisma.facility.update({ where: { code: req.params.code }, data }).catch((e) => {
      if (e.code === 'P2025') return null;
      throw e;
    });
    if (!f) return res.status(404).json({ error: 'Facility not found.' });
    redis.publish('facility:changed', JSON.stringify({ code: f.code, action: 'updated' }));
    res.json(f);
  } catch (err) {
    console.error('[Inventory] Update facility error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/facility-bookings?facilityCode=&from=&to=
router.get('/facility-bookings', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const where = {};
    if (req.query.facilityCode) {
      const f = await prisma.facility.findUnique({ where: { code: req.query.facilityCode } });
      where.facilityId = f?.id || '__none__';
    }
    if (req.query.from || req.query.to) {
      where.startAt = {};
      if (req.query.from) where.startAt.gte = new Date(req.query.from);
      if (req.query.to) where.startAt.lte = new Date(req.query.to);
    }
    const list = await prisma.facilityBooking.findMany({
      where,
      orderBy: { startAt: 'asc' },
      include: { facility: true },
      take: 200,
    });
    res.json(list);
  } catch (err) {
    console.error('[Inventory] List facility bookings error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/facility-bookings  (front desk) — reserve a time slot for a reservable facility
router.post('/facility-bookings', requireRole(...BOOKING), async (req, res) => {
  try {
    const { facilityCode, guestName, guestPhone, startAt, endAt, persons } = req.body;
    if (!facilityCode || !guestName || !startAt || !endAt) {
      return res.status(400).json({ error: 'facilityCode, guestName, startAt, endAt required.' });
    }
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return res.status(400).json({ error: 'endAt must be after startAt.' });
    }
    const f = await prisma.facility.findUnique({
      where: { code: facilityCode },
      include: { children: true },
    });
    if (!f) return res.status(404).json({ error: 'Facility not found.' });
    if (!f.active) return res.status(409).json({ error: 'Facility is inactive.' });
    if (!f.reservable)
      return res
        .status(400)
        .json({ error: 'This facility is walk-in only (not reservable). Use the POS sale instead.' });
    if (f.capacity && persons && persons > f.capacity) {
      return res.status(400).json({ error: `Exceeds capacity (${f.capacity}).` });
    }
    // A booking occupies a SET of physical spaces: the whole hall consumes every
    // section, a section consumes only itself. Two bookings clash when those sets
    // intersect — which is why sibling sections can be sold at the same time.
    const leaves = leafFacilityIds(f, f.children);
    const clash = await prisma.facilitySlotLock.findFirst({
      where: {
        facilityId: { in: leaves },
        startAt: { lt: end },
        endAt: { gt: start },
      },
    });
    if (clash) {
      const clashed = await prisma.facility.findUnique({ where: { id: clash.facilityId } });
      return res.status(409).json({
        error: `That time slot is already booked for ${clashed?.name || 'this space'}.`,
      });
    }
    const priceCents = facilityTotalCents(f, { persons, startAt: start, endAt: end });
    let booking;
    try {
      booking = await prisma.$transaction(async (px) => {
        const b = await px.facilityBooking.create({
          data: {
            facilityId: f.id,
            guestName,
            guestPhone,
            startAt: start,
            endAt: end,
            persons: persons || 1,
            priceCents,
            createdBy: req.user?.sub,
          },
          include: { facility: true },
        });
        await px.facilitySlotLock.createMany({
          data: leaves.map((facilityId) => ({
            bookingId: b.id,
            facilityId,
            startAt: start,
            endAt: end,
          })),
        });
        return b;
      });
    } catch (e) {
      // 23P01 = exclusion_violation: the database backstop caught a race the
      // check above could not, because a competing booking committed in between.
      if (e.code === 'P2010' || e.meta?.code === '23P01' || /23P01|exclusion/i.test(e.message)) {
        return res.status(409).json({ error: 'That time slot was just booked by someone else.' });
      }
      throw e;
    }
    redis.publish('facility:booked', JSON.stringify({ bookingId: booking.id, facilityCode, startAt, endAt }));
    res.status(201).json(booking);
  } catch (err) {
    console.error('[Inventory] Create facility booking error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Housekeeping room assignment ───────────────────────────────────────────
const HOUSEKEEPING_MGMT = ['ADMIN', 'MANAGER', 'HOUSEKEEPING_MAINTENANCE'];
// PATCH /api/rooms/:id/assign — assign a room to a housekeeper (or clear with null)
router.patch('/rooms/:id/assign', requireRole(...HOUSEKEEPING_MGMT), async (req, res) => {
  try {
    const { assignedTo, assignedToName } = req.body;
    const room = await prisma.room
      .update({
        where: { id: req.params.id },
        data: { assignedTo: assignedTo || null, assignedToName: assignedTo ? assignedToName || null : null },
      })
      .catch((e) => {
        if (e.code === 'P2025') return null;
        throw e;
      });
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    redis.publish(
      'room:status_changed',
      JSON.stringify({
        roomId: room.id,
        number: room.number,
        status: room.status,
        assignedTo: room.assignedTo,
      })
    );
    res.json(room);
  } catch (err) {
    console.error('[Inventory] Assign room error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Promo codes ─────────────────────────────────────────────────────────────
// GET /api/promo-codes — list (staff)
router.get('/promo-codes', requireRole(...ROLE_GROUPS.MGMT), async (req, res) => {
  try {
    res.json(await prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } }));
  } catch (err) {
    console.error('[Inventory] List promo error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/promo-codes  (ADMIN)
router.post('/promo-codes', requireRole(...ROOM_ADMIN), async (req, res) => {
  try {
    const { code, description, percentOff, validFrom, validTo } = req.body;
    if (!code || !Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
      return res.status(400).json({ error: 'code and an integer percentOff (1–100) are required.' });
    }
    const p = await prisma.promoCode.create({
      data: {
        code: String(code).toUpperCase(),
        description: description || null,
        percentOff,
        validFrom: validFrom ? new Date(validFrom) : null,
        validTo: validTo ? new Date(validTo) : null,
      },
    });
    res.status(201).json(p);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Promo code already exists.' });
    console.error('[Inventory] Create promo error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/promo-codes/:code  (ADMIN) — edit / activate / deactivate
router.patch('/promo-codes/:code', requireRole(...ROOM_ADMIN), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    if (b.description !== undefined) data.description = b.description;
    if (b.percentOff !== undefined) {
      if (!Number.isInteger(b.percentOff) || b.percentOff < 1 || b.percentOff > 100)
        return res.status(400).json({ error: 'percentOff must be 1–100.' });
      data.percentOff = b.percentOff;
    }
    if (b.active !== undefined) data.active = !!b.active;
    if (b.validFrom !== undefined) data.validFrom = b.validFrom ? new Date(b.validFrom) : null;
    if (b.validTo !== undefined) data.validTo = b.validTo ? new Date(b.validTo) : null;
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No editable fields.' });
    const p = await prisma.promoCode
      .update({ where: { code: String(req.params.code).toUpperCase() }, data })
      .catch((e) => {
        if (e.code === 'P2025') return null;
        throw e;
      });
    if (!p) return res.status(404).json({ error: 'Promo code not found.' });
    res.json(p);
  } catch (err) {
    console.error('[Inventory] Update promo error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/facility-bookings/:id  (front desk) — link a folio, or cancel
router.patch('/facility-bookings/:id', requireRole(...BOOKING), async (req, res) => {
  try {
    const data = {};
    if (req.body.folioId !== undefined) data.folioId = req.body.folioId;
    if (req.body.status !== undefined) {
      if (!['CONFIRMED', 'CANCELLED'].includes(req.body.status))
        return res.status(400).json({ error: 'Invalid status.' });
      data.status = req.body.status;
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update.' });
    const b = await prisma
      .$transaction(async (px) => {
        const updated = await px.facilityBooking.update({ where: { id: req.params.id }, data });
        // A cancelled booking must free its spaces immediately, or the hall stays
        // unbookable for a function that is no longer happening.
        if (data.status === 'CANCELLED') {
          await px.facilitySlotLock.deleteMany({ where: { bookingId: updated.id } });
        }
        return updated;
      })
      .catch((e) => {
        if (e.code === 'P2025') return null;
        throw e;
      });
    if (!b) return res.status(404).json({ error: 'Booking not found.' });
    res.json(b);
  } catch (err) {
    console.error('[Inventory] Update facility booking error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
