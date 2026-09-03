const express = require('express');
const inventoryRoutes = require('./routes/inventory.routes');
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
const logger = makeLogger('inventory');
const { startSubscriber } = require('./subscribers/redis.subscriber');
const { utcDayStart, utcDayKey } = require('./lib/date');

const app = express();
const PORT = process.env.PORT || 3005;

// cors handled by gateway
app.use(express.json());
app.use(requestContext(logger));
app.use(metricsMiddleware);
app.get('/metrics', metricsHandler);
mountDocs(app, buildSpec({ serviceName: 'inventory', description: 'InnSight inventory service' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ service: 'inventory', status: 'healthy', timestamp: new Date().toISOString() });
});

// PUBLIC routes — no auth required, used by the public booking engine.
// Only the read-only availability endpoint is exposed.
// The SAME client instance the routes and the Redis subscriber use — see
// src/lib/prisma.js for why this service no longer opens three pools. Aliased as
// publicPrisma purely to keep the public-route handlers below reading unchanged.
const publicPrisma = require('./lib/prisma');
app.get('/api/public/availability', async (req, res) => {
  try {
    const { checkIn, checkOut, roomType } = req.query;
    if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut required.' });
    const types = roomType
      ? await publicPrisma.roomType.findMany({ where: { code: roomType } })
      : await publicPrisma.roomType.findMany();
    // Normalise to UTC day starts so the range lines up with the UTC-midnight
    // `date` keys holds are written with, regardless of the caller's format.
    let ci, co;
    try {
      ci = utcDayStart(checkIn);
      co = utcDayStart(checkOut);
    } catch {
      return res.status(400).json({ error: 'Invalid checkIn/checkOut.' });
    }
    const result = [];
    for (const t of types) {
      const holds = await publicPrisma.inventoryHold.findMany({
        where: {
          roomTypeCode: t.code,
          status: { in: ['ACTIVE', 'COMMITTED'] },
          date: { gte: ci, lt: co },
          expiresAt: { gt: new Date() },
        },
      });
      // Availability is limited by the busiest single night, not the sum of
      // per-night hold rows across the range.
      const perNight = new Map();
      for (const h of holds) {
        const key = utcDayKey(h.date);
        perNight.set(key, (perNight.get(key) || 0) + h.quantity);
      }
      const peakHeld = perNight.size ? Math.max(...perNight.values()) : 0;
      result.push({
        roomTypeCode: t.code,
        name: t.name,
        baseRate: Number(t.baseRate || 0),
        maxOccupancy: t.maxOccupancy,
        totalInventory: t.totalInventory,
        available: Math.max(0, t.totalInventory - peakHeld),
      });
    }
    res.json(result);
  } catch (err) {
    console.error('[Inventory] public availability error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Public promo-code validation (used by the booking flow to apply a discount).
app.get('/api/public/promo/:code', async (req, res) => {
  try {
    const p = await publicPrisma.promoCode.findUnique({
      where: { code: String(req.params.code).toUpperCase() },
    });
    const now = new Date();
    const valid = !!p && p.active && (!p.validFrom || p.validFrom <= now) && (!p.validTo || p.validTo >= now);
    if (!valid) return res.json({ valid: false });
    res.json({ valid: true, code: p.code, percentOff: p.percentOff, description: p.description });
  } catch (err) {
    console.error('[Inventory] promo validate error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Server-Sent Events bridge (Redis → browser) ─────────────────────────────
// EventSource cannot set an Authorization header, so authorisation is passed in the
// query string. It used to be the SESSION JWT itself — a 12-hour bearer token — and
// nginx logs `"$request"`, which includes the query string. Every live-dashboard
// connection therefore wrote a valid 12h credential into
// /var/log/nginx/access.log, the browser's history, and any intermediate proxy.
//
// Now the client first POSTs to /api/events/ticket with a normal Authorization
// header and gets a SINGLE-USE, 30-SECOND ticket, which is what appears in the URL.
// A leaked ticket is worthless: it is consumed on connect (deleted from Redis) and
// expires almost immediately. The gateway also masks query strings in its log
// format, so even the ticket is not written down.
//
// Two streams share one implementation:
//   /api/rooms/events — only room status transitions (the housekeeping map).
//   /api/events       — every cross-module business event, so the dashboard
//                       and other screens can auto-refresh when anything
//                       changes anywhere in the PMS.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { JWT_SECRET } = require('./middleware/auth');

// Separate from the pub/sub subscriber: a client in subscriber mode cannot run
// ordinary commands like SET/GETDEL.
const ticketRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
ticketRedis.on('error', (e) => console.error('[Inventory] ticket redis error:', e.message));

// The full set of events any screen might want to react to. Adding a channel
// here is all it takes to make the whole frontend live-aware of a new event.
const LIVE_CHANNELS = [
  // Inventory / housekeeping
  'room:status_changed',
  'room:maintenance',
  // Reservations
  'reservation:created',
  'reservation:updated',
  'reservation:confirmed',
  'reservation:cancelled',
  // Front desk / stay
  'room:checkin',
  'room:checkout',
  'stay:no_show',
  'stay:extended',
  'stay:room_changed',
  'stay:early_departure',
  // Folio / billing
  'folio:opened',
  'folio:charge_posted',
  'folio:payment_received',
  'folio:settled',
  'folio:closed',
  'folio:deposit_received',
  'folio:refund_posted',
  'folio:early_departure_adjusted',
  // Guests
  'guest:profile_created',
  'guest:profile_updated',
  'guest:flagged',
  // Maintenance
  'maintenance:work_order_created',
  'maintenance:room_out_of_service',
  'maintenance:room_restored',
  // Night audit
  'audit:day_opened',
  'audit:day_closed',
  // Facilities / amenities. These were PUBLISHED by this service but never
  // forwarded, while web/src/pages/Amenities.jsx subscribed to exactly these two
  // names — so amenity edits and bookings were permanently invisible to every
  // other client, with nothing reporting the mismatch.
  'facility:changed',
  'facility:booked',
];

// ── ONE Redis subscriber for the whole process ───────────────────────────────
//
// This used to be `new Redis(...)` INSIDE the request handler, so every browser
// tab opened its own TCP connection to Redis and its own set of 30 channel
// subscriptions. 50 tabs meant 50 connections and 1,500 subscriptions, with no
// cap of any kind. Worse, cleanup hung off `req.on('close')` alone: a socket that
// errored rather than closing cleanly leaked both the Redis connection and the
// 25-second `setInterval` for the lifetime of the process.
//
// Now: one subscriber, one interval, and a client registry that each message
// fans out to. Cost per additional tab is one entry in a Set.
const sseClients = new Set();

// A client that has stopped reading (laptop asleep, network black hole) makes the
// kernel socket buffer grow without bound as we keep queueing events into it.
// Past this much unflushed data the connection is dropped; SSE clients reconnect
// on their own (with backoff — see web/src/lib/useLiveEvents.js), so dropping a
// stalled consumer is recovery, not data loss.
const MAX_BUFFERED_BYTES = 1024 * 1024;

// Hard ceiling on concurrent streams so a reconnect storm cannot exhaust file
// descriptors. The gateway also caps concurrent streams per client address.
const MAX_SSE_CLIENTS = 500;

function dropClient(client, why) {
  if (!sseClients.delete(client)) return;
  if (why) console.warn(`[Inventory] SSE client dropped: ${why}`);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
  try {
    client.res.destroy();
  } catch {
    /* already gone */
  }
}

function sendTo(client, frame) {
  const { res } = client;
  if (res.writableEnded || res.destroyed) {
    dropClient(client);
    return;
  }
  // The previous code ignored write()'s return value entirely — no backpressure.
  if (res.writableLength > MAX_BUFFERED_BYTES) {
    dropClient(client, `not draining (${res.writableLength} bytes queued)`);
    return;
  }
  try {
    res.write(frame);
  } catch (err) {
    dropClient(client, `write failed (${err.message})`);
  }
}

const liveSub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
// Without this listener an ioredis 'error' event is an unhandled 'error' on an
// EventEmitter, which terminates the process — and for THIS service that means
// the capacity gate disappears.
liveSub.on('error', (e) => console.error('[Inventory] SSE redis error:', e.message));
liveSub.subscribe(...LIVE_CHANNELS).catch((e) => {
  console.error('[Inventory] SSE subscribe failed:', e.message);
});
liveSub.on('message', (channel, message) => {
  // Serialise the frame once, not once per client.
  const frame = `event: ${channel}\ndata: ${message}\n\n`;
  for (const client of sseClients) {
    // Each stream declares the channels it wants; /api/rooms/events only takes
    // room status, so a folio charge is not written to the housekeeping map.
    if (client.channels.has(channel)) sendTo(client, frame);
  }
});

// One shared heartbeat for every stream. Comment pings keep nginx and any
// intermediate proxy from timing out an idle connection.
const sseHeartbeat = setInterval(() => {
  for (const client of sseClients) sendTo(client, ': ping\n\n');
}, 25000);
sseHeartbeat.unref();

// ── Short-lived SSE tickets ─────────────────────────────────────────────────
// Stored in Redis so any inventory replica can redeem a ticket minted by another.
const TICKET_TTL_S = 30;
const ticketKey = (t) => `sse:ticket:${t}`;

// POST /api/events/ticket — authenticated normally (Authorization header), returns
// an opaque one-shot ticket for the EventSource URL.
app.post('/api/events/ticket', verifyToken, async (req, res) => {
  try {
    const ticket = crypto.randomBytes(32).toString('base64url');
    // Remember WHO it was minted for, so the stream can still be attributed and a
    // future per-role channel filter has something to work with.
    await ticketRedis.set(
      ticketKey(ticket),
      JSON.stringify({ sub: req.user.sub, roles: req.user.roles || [] }),
      'EX',
      TICKET_TTL_S
    );
    res.json({ ticket, expiresInSeconds: TICKET_TTL_S });
  } catch (err) {
    console.error('[Inventory] SSE ticket error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Redeem: GETDEL makes it strictly single-use, so replaying a ticket captured from
// a log or history fails even inside the 30s window.
async function redeemTicket(ticket) {
  if (!ticket) return null;
  try {
    const raw = await ticketRedis.getdel(ticketKey(ticket));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('[Inventory] ticket redeem failed:', e.message);
    return null;
  }
}

function sseStream(channels) {
  const wanted = new Set(channels);
  return async (req, res) => {
    // A raw session JWT is still accepted as a documented fallback ONLY when
    // ALLOW_SSE_JWT=true, for a client that hasn't been updated. Off by default,
    // because accepting it is precisely the leak this replaced.
    const ticket = String(req.query.ticket || '');
    let principal = await redeemTicket(ticket);
    if (!principal && process.env.ALLOW_SSE_JWT === 'true') {
      try {
        const claims = jwt.verify(String(req.query.token || ''), JWT_SECRET);
        principal = { sub: claims.sub, roles: claims.roles || [] };
      } catch {
        /* fall through to 401 */
      }
    }
    if (!principal) {
      return res
        .status(401)
        .json({ error: 'A valid one-time SSE ticket is required. POST /api/events/ticket first.' });
    }

    if (sseClients.size >= MAX_SSE_CLIENTS) {
      return res.status(503).json({ error: 'Too many live streams open. Try again shortly.' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Nagle would hold small event frames back waiting for more data, which is
    // exactly wrong for a stream whose whole purpose is latency.
    req.socket?.setNoDelay?.(true);
    // The heartbeat is what detects a dead peer; don't let Node time the socket
    // out from under a legitimately idle stream.
    req.socket?.setTimeout?.(0);

    const client = { res, channels: wanted };
    sseClients.add(client);

    // Listen on BOTH req and res, and on 'error' as well as 'close'. The old code
    // only had req.on('close'), which is why an errored socket leaked.
    const cleanup = () => dropClient(client);
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('close', cleanup);
    req.on('error', cleanup);
  };
}

app.get('/api/rooms/events', sseStream(['room:status_changed']));
app.get('/api/events', sseStream(LIVE_CHANNELS));

// Routes
app.use('/api', verifyToken, idempotency, inventoryRoutes);

// Start Redis subscriber for inter-service events
const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Inventory Service running on port ${PORT}`);
});

gracefulShutdown(server, [
  () => subscriber?.disconnect?.(),
  // Close every open SSE stream so `server.close()` can actually finish — a
  // long-lived stream is an in-flight request and would otherwise hold the
  // shutdown open until the 10s hard-exit timer fired. Clients reconnect to the
  // replacement container on their own.
  () => {
    clearInterval(sseHeartbeat);
    for (const client of [...sseClients]) dropClient(client);
    liveSub.disconnect();
  },
]);
