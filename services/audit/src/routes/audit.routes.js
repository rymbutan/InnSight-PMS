const express = require('express');
const Redis = require('ioredis');
const { requireRole, signServiceToken } = require('../middleware/auth');
const { localDay, startOfLocalDay, parseLocalDay, endOfLocalDay } = require('../lib/date');

const AUDIT_ROLES = ['ADMIN', 'MANAGER', 'AUDITOR'];

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('error', (e) => console.error('[Audit] redis error:', e.message));
const STAY_URL = process.env.STAY_URL || 'http://stay-service:3006';
const FOLIO_URL = process.env.FOLIO_URL || 'http://folio-service:3007';
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory-service:3005';
const RESERVATION_URL = process.env.RESERVATION_URL || 'http://reservation-service:3011';

// Minted by the shared helper so the claim shape, the SEPARATE service signing key
// and the pinned issuer/audience are identical everywhere. This used to sign with
// the same JWT_SECRET as human sessions, which meant a compromise of this service
// could forge a login for any user.
function serviceToken() {
  return signServiceToken({
    name: 'audit',
    roles: ['ADMIN', 'AUDITOR'],
    permissions: ['audit.run', 'folio.charge', 'folio.close', 'report.read'],
    expiresIn: '10m',
  });
}

// A business day is a LOCAL calendar day in the property's timezone, stored at
// local midnight. Format it with localDay() — never toISOString(), which would
// shift it back into the previous UTC day under Asia/Manila (UTC+8).
const dayKey = startOfLocalDay;

// Node's global fetch has NO default timeout, so a wedged upstream stalls its
// caller forever. That matters most here: the night audit makes several sequential
// cross-service calls per in-house stay, so one slow service could hang the whole
// end-of-day run with no error and no progress.
const SERVICE_TIMEOUT_MS = Number(process.env.SERVICE_TIMEOUT_MS || 8000);

async function callService(url, options = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceToken()}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${url} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function recordStep(businessDayId, stepName, runner) {
  const step = await prisma.auditStep.create({
    data: { businessDayId, stepName, status: 'RUNNING', startedAt: new Date() },
  });
  try {
    const result = await runner();
    await prisma.auditStep.update({
      where: { id: step.id },
      data: { status: 'COMPLETED', completedAt: new Date(), payload: result || {} },
    });
    return result;
  } catch (err) {
    await prisma.auditStep.update({
      where: { id: step.id },
      data: { status: 'FAILED', completedAt: new Date(), errorMessage: err.message },
    });
    throw err;
  }
}

// GET /api/audit/current
router.get('/audit/current', requireRole(...AUDIT_ROLES), async (req, res) => {
  try {
    const day = await prisma.businessDay.findFirst({
      where: { status: 'OPEN' },
      orderBy: { businessDate: 'desc' },
      include: { steps: { orderBy: { startedAt: 'asc' } } },
    });
    res.json(day);
  } catch (err) {
    console.error('[Audit] Current error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/audit/days
router.get('/audit/days', requireRole(...AUDIT_ROLES), async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = {};
    if (from || to) {
      // businessDate rows are stored at LOCAL midnight, so the bounds must be
      // built the same way. `new Date('2026-07-29')` parses as UTC midnight
      // (= 08:00 local), which silently excluded the 2026-07-29 business day
      // from a `?from=2026-07-29` query. `to` is an inclusive calendar day, so
      // it becomes an exclusive `lt` on the following midnight.
      where.businessDate = {};
      if (from) where.businessDate.gte = parseLocalDay(from);
      if (to) where.businessDate.lt = endOfLocalDay(parseLocalDay(to));
    }
    const days = await prisma.businessDay.findMany({
      where,
      orderBy: { businessDate: 'desc' },
      take: 60,
    });
    res.json(days);
  } catch (err) {
    console.error('[Audit] Days error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/audit/open-day
router.post('/audit/open-day', requireRole(...AUDIT_ROLES), async (req, res) => {
  try {
    const date = dayKey(req.body.businessDate || new Date());
    const existing = await prisma.businessDay.findUnique({ where: { businessDate: date } });
    if (existing)
      return res.status(409).json({ error: 'Business day already exists.', businessDay: existing });
    const day = await prisma.businessDay.create({ data: { businessDate: date } });
    redis.publish('audit:day_opened', JSON.stringify({ businessDate: date }));
    res.status(201).json(day);
  } catch (err) {
    console.error('[Audit] Open day error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/audit/run
router.post('/audit/run', requireRole(...AUDIT_ROLES), async (req, res) => {
  let day;
  try {
    // `nightlyRateCents` is now an OPTIONAL fallback. Default behavior: charge
    // each stay using its own reservation's rate (totalEstimateCents / nights),
    // which gives correct per-room-type pricing instead of one flat rate.
    const { nightlyRateCents: fallbackRateCents, roomChargeCode = 'RM' } = req.body;

    const date = dayKey(req.body.businessDate || new Date());
    // Guard against re-running a day that is already closed or in progress —
    // re-running would post a second room charge to every in-house folio.
    const existingDay = await prisma.businessDay.findUnique({ where: { businessDate: date } });
    if (existingDay && (existingDay.status === 'CLOSED' || existingDay.status === 'CLOSING')) {
      return res.status(409).json({
        error: `Night audit for ${localDay(date)} is already ${existingDay.status.toLowerCase()}.`,
        businessDay: existingDay,
      });
    }
    day = await prisma.businessDay.upsert({
      where: { businessDate: date },
      update: { status: 'CLOSING' },
      create: { businessDate: date, status: 'CLOSING' },
    });

    // Step 1 — gather in-house stays
    const stays = await recordStep(day.id, 'fetch_in_house', async () => {
      return callService(`${STAY_URL}/api/in-house`);
    });

    // Step 2 — post room charge per in-house stay using per-reservation rate
    const roomPostings = await recordStep(day.id, 'post_room_charges', async () => {
      const posted = [];
      for (const s of stays) {
        if (!s.folioId) continue;
        const auditRef = `AUDIT-${localDay(date)}-${s.id}`;
        // Idempotency: if this stay's room charge for the day is already on the
        // folio (e.g. from a prior partial/FAILED run), skip it rather than
        // double-charging the guest.
        try {
          const folio = await callService(`${FOLIO_URL}/api/folios/${s.folioId}`);
          if ((folio.transactions || []).some((t) => t.reference === auditRef)) {
            posted.push({ stayId: s.id, folioId: s.folioId, skipped: 'already charged' });
            continue;
          }
        } catch (e) {
          /* lookup failed — fall through and attempt the post */
        }
        // Look up the originating reservation to compute that stay's nightly rate.
        let nightlyForStayCents = fallbackRateCents;
        if (s.reservationId) {
          try {
            const r = await callService(`${RESERVATION_URL}/api/reservations/${s.reservationId}`);
            const nights = r.nights || 1;
            const total = Number(r.totalEstimateCents || 0);
            if (total > 0) nightlyForStayCents = Math.round(total / nights);
          } catch (e) {
            /* fall through to fallback */
          }
        }
        if (!nightlyForStayCents) {
          posted.push({ stayId: s.id, folioId: s.folioId, error: 'no nightly rate available' });
          continue;
        }
        try {
          const tx = await callService(`${FOLIO_URL}/api/folios/${s.folioId}/charges`, {
            method: 'POST',
            body: JSON.stringify({
              chargeCode: roomChargeCode,
              description: `Room charge for ${localDay(date)}`,
              amountCents: nightlyForStayCents,
              postedBy: 'system.audit',
              sourceSystem: 'night-audit',
              reference: auditRef,
            }),
          });
          posted.push({ stayId: s.id, folioId: s.folioId, txId: tx.id, rateCents: nightlyForStayCents });
        } catch (err) {
          posted.push({ stayId: s.id, folioId: s.folioId, error: err.message });
        }
      }
      return { posted, distinctRates: new Set(posted.map((p) => p.rateCents).filter(Boolean)).size };
    });

    // Step 3 — mark no-shows
    const noShowSummary = await recordStep(day.id, 'mark_no_shows', async () => {
      const to = endOfLocalDay(date);
      const candidates = await callService(
        `${RESERVATION_URL}/api/reservations?status=CONFIRMED&to=${to.toISOString()}`
      );
      // A reservation whose check-in day IS the business day being closed has
      // failed to arrive and must be no-showed by tonight's audit. The previous
      // `< date` comparison only caught reservations from earlier days, so every
      // no-show was recorded a full day late. Compare on the local calendar day.
      const businessDayKey = localDay(date);
      const overdue = candidates.filter((r) => localDay(r.checkIn) <= businessDayKey);
      const touched = [];
      for (const r of overdue) {
        try {
          await callService(`${STAY_URL}/api/no-show/${r.id}`, { method: 'POST' });
          touched.push(r.id);
        } catch (err) {
          touched.push({ id: r.id, error: err.message });
        }
      }
      return { scanned: candidates.length, marked: touched };
    });

    // Step 4 — occupancy snapshot
    const occupancy = await recordStep(day.id, 'occupancy_snapshot', async () => {
      const rooms = await callService(`${INVENTORY_URL}/api/rooms`);
      const occupied = rooms.filter((r) => r.status === 'OCCUPIED').length;
      const available = rooms.length;
      const pct = available ? (occupied / available) * 100 : 0;
      return { occupied, available, pct };
    });

    // Step 5 — arrivals / departures counts
    const dateStr = localDay(date);
    const movements = await recordStep(day.id, 'movements_snapshot', async () => {
      const [arrivals, departures] = await Promise.all([
        callService(`${STAY_URL}/api/arrivals?date=${dateStr}`).catch(() => []),
        callService(`${STAY_URL}/api/departures?date=${dateStr}`).catch(() => []),
      ]);
      return { arrivals: arrivals.length, departures: departures.length };
    });

    // Step 6 — folio revenue aggregation
    const revenue = await recordStep(day.id, 'revenue_aggregation', async () => {
      const totals = await callService(`${FOLIO_URL}/api/folios/daily-totals?date=${dateStr}`).catch(() => ({
        roomRevenueCents: '0',
        facilityRevenueCents: '0',
        otherRevenueCents: '0',
        taxCents: '0',
        paymentsCents: '0',
      }));
      return totals;
    });

    // Step 7 — finalize
    const roomRevenueCents = BigInt(revenue.roomRevenueCents || 0);
    // `|| 0` is doing real work here: a folio service running an older image
    // returns no facilityRevenueCents at all, and BigInt(undefined) throws — which
    // would abort the night audit rather than report a zero.
    const facilityRevenueCents = BigInt(revenue.facilityRevenueCents || 0);
    const otherRevenueCents = BigInt(revenue.otherRevenueCents || 0);
    const taxCents = BigInt(revenue.taxCents || 0);
    const paymentsCents = BigInt(revenue.paymentsCents || 0);
    const postedCount = (roomPostings.posted || []).filter((p) => !p.error).length;
    const roomRevenueNum = Number(roomRevenueCents);

    const closed = await prisma.businessDay.update({
      where: { id: day.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedBy: req.user?.sub,
        roomsOccupied: occupancy.occupied,
        roomsAvailable: occupancy.available,
        occupancyPct: occupancy.pct,
        arrivals: movements.arrivals,
        departures: movements.departures,
        noShows: Array.isArray(noShowSummary.marked) ? noShowSummary.marked.length : 0,
        roomRevenueCents,
        facilityRevenueCents,
        otherRevenueCents,
        taxCents,
        paymentsCents,
        adr: postedCount ? roomRevenueNum / postedCount : 0,
        revPar: occupancy.available ? roomRevenueNum / occupancy.available : 0,
      },
    });

    redis.publish(
      'audit:day_closed',
      JSON.stringify({
        businessDate: closed.businessDate,
        occupancyPct: closed.occupancyPct,
        roomRevenueCents: closed.roomRevenueCents.toString(),
      })
    );

    res.json({
      businessDay: closed,
      stepsSummary: { stays: stays.length, roomPostings, noShowSummary, occupancy },
    });
  } catch (err) {
    console.error('[Audit] Run error:', err.message);
    if (day) {
      await prisma.businessDay
        .update({
          where: { id: day.id },
          data: { status: 'FAILED', notes: err.message },
        })
        .catch(() => {});
    }
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
