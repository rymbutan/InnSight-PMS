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

const { activityLog } = require('./lib/activityLog');
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
  // Bill splitting: a charge moved between two folios of one stay.
  'folio:transferred',
  // E-wallet refund/chargeback claims (services/folio's PaymentDispute).
  'folio:dispute_filed',
  'folio:dispute_resolved',
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
  // Front desk ringing housekeeping about a room. A live-only pair: a call is a
  // summons to somebody on shift NOW, so it is deliberately not persisted —
  // see POST /api/housekeeping-calls.
  'housekeeping:call_placed',
  'housekeeping:call_answered',
  'messaging:message_sent',
];

// ── Who may receive which channel ───────────────────────────────────────────
// Every authenticated client used to receive all of LIVE_CHANNELS regardless of
// role, because sseStream captured the principal and then threw it away. A
// housekeeper's browser was therefore fed guest names, folio charges, payment
// amounts and night-audit results — data no housekeeping screen renders and the
// HOUSEKEEPING role holds no permission for. The stream was the one authorised
// surface in the system with no authorisation on its payload.
//
// The lists below are derived from the role→permission map in
// services/auth/src/seed.js, NOT invented here, so a role receives exactly the
// domains it can already read through the REST API:
//
//   room.read      → every role, so room status is universal
//   reservation.*  → ADMIN, MANAGER, FRONT_DESK
//   folio.read     → ADMIN, MANAGER, FRONT_DESK, AUDITOR  (front desk POSTS the
//                    charges and takes the payments — folio.charge/folio.payment)
//   maintenance.*  → ADMIN, MANAGER, MAINTENANCE
//   audit.run      → ADMIN, MANAGER, AUDITOR
//
// Deriving it this way matters for more than tidiness: these channels also drive
// each page's live refresh, so a role that can open a screen must keep receiving
// the events that screen renders or it silently goes stale.
const CHANNEL_AUDIENCE = {
  rooms: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING_MAINTENANCE', 'AUDITOR'],
  reservations: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
  stays: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
  folio: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR'],
  guests: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
  maintenance: ['ADMIN', 'MANAGER', 'HOUSEKEEPING_MAINTENANCE'],
  audit: ['ADMIN', 'MANAGER', 'AUDITOR'],
  facilities: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
  // BOTH sides of the call. Housekeeping has to hear it ring, and the desk that
  // placed it has to see it answered — a caller who gets no answer-back rings
  // again, which is the one failure mode a summons must not have.
  housekeeping: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING_MAINTENANCE'],
  // Every role, because a direct message is addressed to a PERSON rather than
  // to a department — the same reasoning as the messaging service's routes. The
  // role list is not what protects this one: the directed fan-out below sends
  // each frame to the recipient's stream and to nobody else's.
  messaging: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING_MAINTENANCE', 'AUDITOR'],
};

const CHANNEL_DOMAIN = {
  'room:status_changed': 'rooms',
  'room:maintenance': 'rooms',
  'reservation:created': 'reservations',
  'reservation:updated': 'reservations',
  'reservation:confirmed': 'reservations',
  'reservation:cancelled': 'reservations',
  'room:checkin': 'stays',
  'room:checkout': 'stays',
  'stay:no_show': 'stays',
  'stay:extended': 'stays',
  'stay:room_changed': 'stays',
  'stay:early_departure': 'stays',
  'folio:opened': 'folio',
  'folio:charge_posted': 'folio',
  'folio:payment_received': 'folio',
  'folio:settled': 'folio',
  'folio:closed': 'folio',
  'folio:deposit_received': 'folio',
  'folio:refund_posted': 'folio',
  'folio:early_departure_adjusted': 'folio',
  // These three were in LIVE_CHANNELS with no domain, and an unmapped channel
  // is CLOSED (see mayReceive below) — so bill-split transfers and every
  // dispute event were forwarded to nobody at all.
  'folio:transferred': 'folio',
  'folio:dispute_filed': 'folio',
  'folio:dispute_resolved': 'folio',
  'guest:profile_created': 'guests',
  'guest:profile_updated': 'guests',
  'guest:flagged': 'guests',
  'maintenance:work_order_created': 'maintenance',
  'maintenance:room_out_of_service': 'maintenance',
  'maintenance:room_restored': 'maintenance',
  'audit:day_opened': 'audit',
  'audit:day_closed': 'audit',
  'facility:changed': 'facilities',
  'facility:booked': 'facilities',
  'housekeeping:call_placed': 'housekeeping',
  'housekeeping:call_answered': 'housekeeping',
  'messaging:message_sent': 'messaging',
};

// An unmapped channel is CLOSED, not open. Adding a channel to LIVE_CHANNELS and
// forgetting CHANNEL_DOMAIN should make it reach nobody rather than everybody —
// a missing entry must not be the permissive case.
function mayReceive(roles, channel) {
  const domain = CHANNEL_DOMAIN[channel];
  if (!domain) return false;
  const audience = CHANNEL_AUDIENCE[domain];
  if (!audience) return false;
  return roles.some((r) => audience.includes(r));
}

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
// A directed event names the one user it is for. Only the housekeeping call
// carries this, and it is parsed for that channel alone — every other event
// stays a pure Set lookup on the fanout path, which runs for every connected
// tab on every business event in the property.
//
// The DESK that placed the call is always kept on the recipient list even when
// the call is directed elsewhere: that is how its own handset learns the call
// was answered. Filtering that out here would silence the answer-back.
// A user id no session can ever hold, so a frame aimed at it is delivered to
// nobody. Used as the fallback for an unparseable direct message.
const NO_RECIPIENT = '__no_recipient__';

function directedTargetOf(channel, message) {
  if (channel === 'housekeeping:call_placed') {
    try {
      const d = JSON.parse(message);
      return d.targetUserId ? { targetUserId: d.targetUserId, callerId: d.callerId || null } : null;
    } catch {
      // A frame we cannot parse is broadcast rather than dropped: failing to
      // deliver a summons is worse than delivering it too widely.
      return null;
    }
  }

  // A direct message goes to the RECIPIENT and to nobody else — not even the
  // sender, who already knows what they typed. Note the opposite default to the
  // call above: an unparseable message frame is directed at a userId that
  // cannot match any client, so it reaches no one. Broadcasting a private
  // message on a parse failure is not a trade-off worth making.
  if (channel === 'messaging:message_sent') {
    try {
      const d = JSON.parse(message);
      return { targetUserId: d.recipientId || NO_RECIPIENT, callerId: null };
    } catch {
      return { targetUserId: NO_RECIPIENT, callerId: null };
    }
  }

  return null;
}

liveSub.on('message', (channel, message) => {
  // Serialise the frame once, not once per client.
  const frame = `event: ${channel}\ndata: ${message}\n\n`;
  const directed = directedTargetOf(channel, message);
  for (const client of sseClients) {
    // A directed call reaches its target and the caller, nobody else. Enforced
    // HERE, on the server, and not by the browser choosing whether to ring:
    // every housekeeper's stream is otherwise entitled to this channel.
    if (directed && client.userId !== directed.targetUserId && client.userId !== directed.callerId) {
      continue;
    }
    // `client.channels` is the intersection of what the stream offers and what
    // the connecting role is allowed (see mayReceive), so this single check is
    // both the routing rule — /api/rooms/events only takes room status, so a
    // folio charge is never written to the housekeeping map — and the
    // authorisation boundary on the payload.
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

    // Intersect what the stream offers with what this role may receive, ONCE at
    // connect time, so the hot fanout path stays a Set lookup. A client that asks
    // for channels it is not entitled to simply never sees them — the request is
    // not rejected, because a front desk agent opening a page that subscribes to
    // a broad group is normal, not an attack.
    const roles = Array.isArray(principal.roles) ? principal.roles : [];
    const allowed = new Set([...wanted].filter((c) => mayReceive(roles, c)));

    // `userId` is what lets a directed event reach one person — see
    // directedTargetOf on the fanout path. It comes from the redeemed ticket,
    // never from a query parameter.
    const client = { res, channels: allowed, userId: principal.sub || null };
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
app.use('/api', verifyToken, idempotency, activityLog({ service: 'inventory' }), inventoryRoutes);

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
