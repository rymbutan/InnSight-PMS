const express = require('express');
const { requireRole, ROLE_GROUPS, signServiceToken } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../lib/prisma');

// Financial and guest-ledger reports are restricted to management/audit roles.
const REPORT_ROLES = ['ADMIN', 'MANAGER', 'AUDITOR'];

const STAY_URL = process.env.STAY_URL || 'http://stay-service:3006';
const FOLIO_URL = process.env.FOLIO_URL || 'http://folio-service:3007';
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory-service:3005';
const AUDIT_URL = process.env.AUDIT_URL || 'http://audit-service:3012';
const RESERVATION_URL = process.env.RESERVATION_URL || 'http://reservation-service:3011';

// See the note in audit.routes.js — one minter, a separate signing key, and the
// narrowest roles this service actually needs.
function serviceToken() {
  return signServiceToken({
    name: 'reports',
    roles: ['ADMIN', 'MANAGER', 'AUDITOR'],
    permissions: ['report.read', 'folio.read', 'room.read', 'reservation.read'],
    expiresIn: '10m',
  });
}

// Node's global fetch has NO default timeout, so a wedged upstream stalls its
// caller forever. That matters most here: the night audit makes several sequential
// cross-service calls per in-house stay, so one slow service could hang the whole
// end-of-day run with no error and no progress.
const SERVICE_TIMEOUT_MS = Number(process.env.SERVICE_TIMEOUT_MS || 8000);

async function callService(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${serviceToken()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${url} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function saveRun({ type, params, result, runBy, status = 'COMPLETED', errorMsg }) {
  try {
    await prisma.reportRun.create({
      data: { type, params, result, runBy, status, errorMsg },
    });
  } catch (err) {
    console.error('[Reports] Persist run error:', err.message);
  }
}

// GET /api/reports/occupancy?from=&to=
router.get('/reports/occupancy', requireRole(...REPORT_ROLES), async (req, res) => {
  try {
    const { from, to } = req.query;
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const days = await callService(`${AUDIT_URL}/api/audit/days?${qs.toString()}`);
    const summary = {
      from,
      to,
      days: days.length,
      avgOccupancyPct: days.length ? days.reduce((s, d) => s + (d.occupancyPct || 0), 0) / days.length : 0,
      avgAdr: days.length ? days.reduce((s, d) => s + (d.adr || 0), 0) / days.length : 0,
      avgRevPar: days.length ? days.reduce((s, d) => s + (d.revPar || 0), 0) / days.length : 0,
      rows: days,
    };
    await saveRun({ type: 'occupancy', params: { from, to }, result: summary, runBy: req.user?.sub });
    res.json(summary);
  } catch (err) {
    console.error('[Reports] Occupancy error:', err.message);
    await saveRun({
      type: 'occupancy',
      params: req.query,
      status: 'FAILED',
      errorMsg: err.message,
      runBy: req.user?.sub,
    });
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reports/revenue?from=&to=
router.get('/reports/revenue', requireRole(...REPORT_ROLES), async (req, res) => {
  try {
    const { from, to } = req.query;
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const days = await callService(`${AUDIT_URL}/api/audit/days?${qs.toString()}`);
    const sum = (key) => days.reduce((s, d) => s + Number(d[key] || 0), 0);
    const summary = {
      from,
      to,
      totals: {
        roomRevenueCents: sum('roomRevenueCents'),
        otherRevenueCents: sum('otherRevenueCents'),
        taxCents: sum('taxCents'),
        paymentsCents: sum('paymentsCents'),
      },
      rows: days.map((d) => ({
        businessDate: d.businessDate,
        roomRevenueCents: d.roomRevenueCents,
        otherRevenueCents: d.otherRevenueCents,
        taxCents: d.taxCents,
        paymentsCents: d.paymentsCents,
      })),
    };
    await saveRun({ type: 'revenue', params: { from, to }, result: summary, runBy: req.user?.sub });
    res.json(summary);
  } catch (err) {
    console.error('[Reports] Revenue error:', err.message);
    await saveRun({
      type: 'revenue',
      params: req.query,
      status: 'FAILED',
      errorMsg: err.message,
      runBy: req.user?.sub,
    });
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reports/arrivals?date=
router.get('/reports/arrivals', requireRole(...ROLE_GROUPS.OPS_READ), async (req, res) => {
  try {
    const { date } = req.query;
    const data = await callService(`${STAY_URL}/api/arrivals${date ? `?date=${date}` : ''}`);
    const summary = { date, count: data.length, rows: data };
    await saveRun({ type: 'arrivals', params: { date }, result: summary, runBy: req.user?.sub });
    res.json(summary);
  } catch (err) {
    console.error('[Reports] Arrivals error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reports/departures?date=
router.get('/reports/departures', requireRole(...ROLE_GROUPS.OPS_READ), async (req, res) => {
  try {
    const { date } = req.query;
    const data = await callService(`${STAY_URL}/api/departures${date ? `?date=${date}` : ''}`);
    const summary = { date, count: data.length, rows: data };
    await saveRun({ type: 'departures', params: { date }, result: summary, runBy: req.user?.sub });
    res.json(summary);
  } catch (err) {
    console.error('[Reports] Departures error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reports/in-house
router.get('/reports/in-house', requireRole(...ROLE_GROUPS.OPS_READ), async (req, res) => {
  try {
    const data = await callService(`${STAY_URL}/api/in-house`);
    const summary = { count: data.length, rows: data };
    await saveRun({ type: 'in_house', result: summary, runBy: req.user?.sub });
    res.json(summary);
  } catch (err) {
    console.error('[Reports] In-house error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reports/room-status
router.get('/reports/room-status', requireRole(...ROLE_GROUPS.ALL_STAFF), async (req, res) => {
  try {
    const rooms = await callService(`${INVENTORY_URL}/api/rooms`);
    const byStatus = rooms.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    const summary = { total: rooms.length, byStatus, rows: rooms };
    await saveRun({ type: 'room_status', result: summary, runBy: req.user?.sub });
    res.json(summary);
  } catch (err) {
    console.error('[Reports] Room status error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reports/guest-ledger/:guestId
router.get('/reports/guest-ledger/:guestId', requireRole(...REPORT_ROLES), async (req, res) => {
  try {
    const reservations = await callService(
      `${RESERVATION_URL}/api/reservations?guestId=${req.params.guestId}`
    );
    const summary = {
      guestId: req.params.guestId,
      reservations,
      totalReservations: reservations.length,
    };
    await saveRun({
      type: 'guest_ledger',
      params: { guestId: req.params.guestId },
      result: summary,
      runBy: req.user?.sub,
    });
    res.json(summary);
  } catch (err) {
    console.error('[Reports] Guest ledger error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reports/amenities?from=&to=  — walk-in amenity/facility revenue,
// broken down by facility (enriched with facility names from inventory).
router.get('/reports/amenities', requireRole(...REPORT_ROLES), async (req, res) => {
  try {
    const { from, to } = req.query;
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const rev = await callService(`${FOLIO_URL}/api/folios/amenity-revenue?${qs.toString()}`);
    let facilities = [];
    try {
      facilities = await callService(`${INVENTORY_URL}/api/facilities`);
    } catch {
      /* names optional */
    }
    const nameOf = Object.fromEntries(facilities.map((f) => [f.code, f.name]));
    const catOf = Object.fromEntries(facilities.map((f) => [f.code, f.category]));
    const summary = {
      from,
      to,
      totalCents: rev.totalCents,
      count: rev.count,
      rows: (rev.byFacility || []).map((b) => ({
        ...b,
        name: nameOf[b.code] || b.code,
        category: catOf[b.code] || '',
      })),
    };
    await saveRun({ type: 'amenities', params: { from, to }, result: summary, runBy: req.user?.sub });
    res.json(summary);
  } catch (err) {
    console.error('[Reports] Amenities error:', err.message);
    await saveRun({
      type: 'amenities',
      params: req.query,
      status: 'FAILED',
      errorMsg: err.message,
      runBy: req.user?.sub,
    });
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/reports/runs
router.get('/reports/runs', requireRole(...REPORT_ROLES), async (req, res) => {
  try {
    const runs = await prisma.reportRun.findMany({
      orderBy: { runAt: 'desc' },
      take: 100,
      select: { id: true, type: true, params: true, runBy: true, runAt: true, status: true, errorMsg: true },
    });
    res.json(runs);
  } catch (err) {
    console.error('[Reports] List runs error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
