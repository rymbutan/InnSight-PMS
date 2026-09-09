const express = require('express');
const reservationRoutes = require('./routes/reservation.routes');
const { verifyToken } = require('./middleware/auth');
const { idempotency } = require('./middleware/idempotency');
const {
  makeLogger,
  requestContext,
  metricsMiddleware,
  metricsHandler,
  gracefulShutdown,
  jsonErrorHandler,
} = require('./lib/observability');
const { buildSpec, mountDocs } = require('./lib/openapi');
const logger = makeLogger('reservation');
const { startSubscriber } = require('./subscribers/redis.subscriber');

const app = express();
const PORT = process.env.PORT || 3011;

// cors handled by gateway
// Documents are uploaded as base64 JSON (see routes/reservation.routes.js), so
// the body-parser's tiny default limit has to grow past that encoding's ~33%
// overhead on top of the 10MB document size cap the route itself enforces.
app.use(express.json({ limit: '15mb' }));
app.use(requestContext(logger));
app.use(metricsMiddleware);
app.get('/metrics', metricsHandler);
mountDocs(app, buildSpec({ serviceName: 'reservation', description: 'InnSight reservation service' }));

BigInt.prototype.toJSON = function () {
  return this.toString();
};

app.get('/health', (req, res) => {
  res.json({ service: 'reservation', status: 'healthy', timestamp: new Date().toISOString() });
});

// PUBLIC route — guest-initiated booking from /book.
// Creates a PENDING reservation tagged source=DIRECT and emits an event so
// the inventory service can place a hold + the email subscriber can notify staff.
const crypto = require('crypto');
const Redis = require('ioredis');
// The SAME client instance the routes and the Redis subscriber use — see
// src/lib/prisma.js for why this service no longer opens three pools. Aliased as
// publicPrisma purely to keep the public-route handlers below reading unchanged.
const publicPrisma = require('./lib/prisma');
const publicRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
publicRedis.on('error', (e) => console.error('[Reservation] public redis error:', e.message));
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory-service:3005';
const { makeInventoryClient, NoInventoryError } = require('./lib/inventoryClient');
const { makeFolioClient } = require('./lib/folioClient');
const { quotePublicTotal } = require('./lib/publicQuote');
const { JWT_SECRET } = require('./middleware/auth');
const inventory = makeInventoryClient({ name: 'reservation', secret: JWT_SECRET });
const folio = makeFolioClient({ name: 'reservation' });
app.post('/api/public/reservations', async (req, res) => {
  try {
    // Pricing is computed server-side from the room type's published rate —
    // client-supplied totalEstimateCents/depositCents are ignored so a guest
    // cannot book a room for an arbitrary amount.
    const {
      guestName,
      guestEmail,
      guestPhone,
      roomTypeCode,
      checkIn,
      checkOut,
      adults,
      children,
      promoCode,
      specialRequests,
      expectedArrivalTime,
    } = req.body;
    // Email and phone are both mandatory: this is how a booking confirmation
    // (see redis.subscriber.js's Email + SMS/Viber dispatch on
    // reservation:confirmed) reaches the guest at all. The frontend already
    // requires both; this is the guard that matters, since the frontend check
    // is trivially bypassed by anyone calling the API directly.
    if (!guestName || !guestEmail || !guestPhone || !roomTypeCode || !checkIn || !checkOut) {
      return res.status(400).json({
        error: 'guestName, guestEmail, guestPhone, roomTypeCode, checkIn, checkOut required.',
      });
    }
    const ci = new Date(checkIn);
    const co = new Date(checkOut);
    if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime()) || co <= ci) {
      return res.status(400).json({ error: 'checkOut must be after checkIn.' });
    }
    const nights = Math.max(1, Math.round((co - ci) / 86400000));

    // Look up the room type's rate and remaining availability from inventory.
    let roomType;
    try {
      // Bounded: Node's global fetch has no default timeout, so a wedged
      // inventory service would hang public booking requests indefinitely.
      const rows = await fetch(
        `${INVENTORY_URL}/api/public/availability?checkIn=${ci.toISOString()}&checkOut=${co.toISOString()}`,
        { signal: AbortSignal.timeout(5000) }
      ).then((r) => r.json());
      roomType = Array.isArray(rows) ? rows.find((t) => t.roomTypeCode === roomTypeCode) : null;
    } catch (e) {
      return res.status(502).json({ error: 'Could not verify availability. Please try again.' });
    }
    if (!roomType) return res.status(400).json({ error: 'Unknown room type.' });

    // NOTE: `roomType.available` from the availability read above is advisory
    // ONLY — it is a read against a different service's database, so acting on
    // it is a time-of-check/time-of-use race that no transaction can cover. It
    // is used purely to fail fast with a friendly message. The AUTHORITATIVE
    // decision is the hold acquired below, which is taken under a row lock
    // inside inventory's own transaction.
    if (roomType.available <= 0)
      return res.status(409).json({ error: 'No rooms available for the selected dates.' });

    let grossCents = Math.round(Number(roomType.baseRate || 0) * nights);
    // Apply a validated promo code (discount computed server-side).
    let appliedPromo = null;
    if (promoCode) {
      try {
        const pr = await fetch(`${INVENTORY_URL}/api/public/promo/${encodeURIComponent(promoCode)}`, {
          signal: AbortSignal.timeout(3000),
        }).then((r) => r.json());
        if (pr && pr.valid) {
          grossCents = Math.round(grossCents * (1 - pr.percentOff / 100));
          appliedPromo = `${pr.code} (-${pr.percentOff}%)`;
        }
      } catch {
        /* ignore promo lookup failure — book at full price */
      }
    }
    // Tax-inclusive: computed at folio's configured rates so this quote
    // matches what the guest actually owes at checkout (see lib/publicQuote.js).
    const { totalEstimateCents } = await quotePublicTotal({
      grossCents,
      getFolioTaxRates: () => folio.getTaxRates(),
    });

    // ── PHASE 1: claim capacity transactionally in inventory ─────────────────
    // Two guests racing for the last room both used to pass the `available <= 0`
    // check above and both got a reservation. The hold below is taken under a
    // row lock inside inventory's own database, so exactly one of them wins.
    let hold;
    try {
      hold = await inventory.acquireHold({ roomTypeCode, checkIn: ci, checkOut: co, quantity: 1 });
    } catch (err) {
      if (err instanceof NoInventoryError) {
        return res.status(409).json({ error: 'No rooms available for the selected dates.', ...err.detail });
      }
      if (err.statusCode === 400) return res.status(400).json({ error: err.message });
      console.error('[Reservation] public hold error:', err.message);
      return res.status(502).json({ error: 'Could not verify availability. Please try again.' });
    }

    // ── PHASE 2: persist, then bind the hold ─────────────────────────────────
    let reservation;
    try {
      reservation = await publicPrisma.reservation.create({
        data: {
          confirmationNumber: `R-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
          guestName,
          guestEmail,
          guestPhone,
          roomTypeCode,
          checkIn: ci,
          checkOut: co,
          nights,
          adults: adults || 1,
          children: children || 0,
          source: 'DIRECT',
          status: 'PENDING',
          totalEstimateCents,
          depositCents: BigInt(0), // no payment collected on the public engine yet
          origin: 'Public booking engine',
          inventoryHoldGroupId: hold.groupId,
          // Combined, not replaced: this used to overwrite whatever the guest
          // typed in Special Requests with just the promo note the moment a
          // promo code was applied, silently dropping the guest's own text.
          ...(specialRequests || appliedPromo
            ? {
                specialRequests: [specialRequests, appliedPromo ? `Promo applied: ${appliedPromo}` : null]
                  .filter(Boolean)
                  .join('\n'),
              }
            : {}),
          ...(expectedArrivalTime ? { expectedArrivalTime } : {}),
        },
      });
      await inventory.attachHold(hold.groupId, reservation.id);
    } catch (err) {
      // Roll the reservation back before releasing the hold: a committed row
      // with no hold is invisible to availability and gets duplicated on retry.
      if (reservation?.id) {
        await publicPrisma.reservation
          .delete({ where: { id: reservation.id } })
          .catch((e) =>
            console.error(
              `[Reservation] CRITICAL: could not roll back public reservation ${reservation.id}: ${e.message}`
            )
          );
      }
      await inventory.releaseHold(hold.groupId);
      return res.status(503).json({ error: 'Could not complete the booking. Please try again.' });
    }

    // Notify staff. Inventory no longer places holds off this event — capacity
    // was already claimed above — so this is purely a notification fan-out. We do
    // NOT emit reservation:confirmed; a public booking stays PENDING until staff
    // confirm it via /api/reservations/:id/confirm.
    publicRedis.publish(
      'reservation:created',
      JSON.stringify({
        reservationId: reservation.id,
        confirmationNumber: reservation.confirmationNumber,
        roomTypeCode,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        nights,
        source: 'PUBLIC',
        inventoryHoldGroupId: hold.groupId,
      })
    );
    res.status(201).json(reservation);
  } catch (err) {
    console.error('[Reservation] public create error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
app.get('/api/public/reservations/:confirmationNumber', async (req, res) => {
  try {
    const r = await publicPrisma.reservation.findFirst({
      where: { confirmationNumber: req.params.confirmationNumber },
    });
    if (!r) return res.status(404).json({ error: 'Not found.' });
    // Strip sensitive fields before returning to public callers.
    res.json({
      id: r.id,
      confirmationNumber: r.confirmationNumber,
      guestName: r.guestName,
      guestEmail: r.guestEmail,
      roomTypeCode: r.roomTypeCode,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      nights: r.nights,
      adults: r.adults,
      children: r.children,
      status: r.status,
      totalEstimateCents: r.totalEstimateCents,
      depositCents: r.depositCents,
    });
  } catch (err) {
    console.error('[Reservation] public lookup error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
app.post('/api/public/reservations/:confirmationNumber/notes', async (req, res) => {
  try {
    const r = await publicPrisma.reservation.findFirst({
      where: { confirmationNumber: req.params.confirmationNumber },
    });
    if (!r) return res.status(404).json({ error: 'Not found.' });
    const note = await publicPrisma.reservationNote.create({
      data: { reservationId: r.id, author: 'guest_portal', body: req.body.body || '' },
    });
    res.status(201).json({ id: note.id });
  } catch (err) {
    console.error('[Reservation] public note error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.use('/api', verifyToken, idempotency, reservationRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Reservation Service running on port ${PORT}`);
});

// Best-effort: a bucket that doesn't exist yet is created lazily on the first
// upload attempt too (see routes), so a MinIO hiccup at boot doesn't crash a
// service that has nothing to do with documents on its critical path.
require('./lib/storage')
  .ensureBucket()
  .catch((e) => console.warn('[Reservation] Could not ensure MinIO bucket at startup:', e.message));

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
