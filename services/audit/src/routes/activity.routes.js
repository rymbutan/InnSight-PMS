// Read-only API over the system-wide user activity log.
//
// READ-ONLY IS THE POINT. There is no POST/PATCH/DELETE here and there must never
// be one: rows are written solely by src/subscribers/redis.subscriber.js from the
// Redis bus, so an admin cannot edit or delete entries from the same screen that
// displays them. A log the reader can rewrite answers no question worth asking.
//
// ADMIN only. MANAGER is deliberately excluded, matching how this codebase already
// treats operational data (Service Health is ADMIN-only for the same reason) —
// and because a manager who can review their own department's actions, and who is
// also recorded in the log, is a separation-of-duties problem rather than a
// convenience.

const express = require('express');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../lib/prisma');

const ACTIVITY_ROLES = ['ADMIN'];

// A page the browser can actually render, and a ceiling a caller cannot raise.
// Without the cap, `?pageSize=1000000` is a full table scan serialised to JSON.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function intParam(value, fallback, { min, max }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// GET /api/activity
// Filters: ?from&to (ISO dates) &actorId &service &action &q &page &pageSize
router.get('/activity', requireRole(...ACTIVITY_ROLES), async (req, res) => {
  try {
    const { from, to, actorId, service, action, q } = req.query;
    const page = intParam(req.query.page, 1, { min: 1, max: 100000 });
    const pageSize = intParam(req.query.pageSize, DEFAULT_PAGE_SIZE, { min: 1, max: MAX_PAGE_SIZE });

    const where = {};
    if (from || to) {
      where.at = {};
      // `at` is a real timestamp, not a business day, so these are plain instants
      // — no localDay() treatment. `to` is read as an inclusive calendar day when
      // it has no time part, which is what a date picker sends and what a person
      // reading "to: 17 Sep" means.
      if (from) where.at.gte = new Date(from);
      if (to) {
        const end = new Date(to);
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) end.setHours(23, 59, 59, 999);
        where.at.lte = end;
      }
    }
    if (actorId) where.actorId = String(actorId);
    if (service) where.service = String(service);
    if (action) where.action = String(action);
    if (q) {
      const term = String(q).slice(0, 200);
      where.OR = [
        { summary: { contains: term, mode: 'insensitive' } },
        { actorName: { contains: term, mode: 'insensitive' } },
        { path: { contains: term, mode: 'insensitive' } },
        { targetId: { contains: term, mode: 'insensitive' } },
      ];
    }

    // The count is returned alongside so the UI can say "1–50 of 4,812" rather
    // than leaving the reader to guess whether a full page means there is more.
    const [total, rows] = await Promise.all([
      prisma.activityLog.count({ where }),
      prisma.activityLog.findMany({
        where,
        orderBy: { at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ rows, total, page, pageSize, pageCount: Math.ceil(total / pageSize) || 1 });
  } catch (err) {
    console.error('[Audit] Activity list error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/activity/filters
// The distinct values behind the screen's dropdowns. Computed server-side because
// the alternative — deriving them from the current page — offers the reader only
// the filters they can already see, which is precisely backwards.
router.get('/activity/filters', requireRole(...ACTIVITY_ROLES), async (req, res) => {
  try {
    const [services, actions, actors] = await Promise.all([
      prisma.activityLog.findMany({
        distinct: ['service'],
        select: { service: true },
        orderBy: { service: 'asc' },
      }),
      prisma.activityLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
      }),
      prisma.activityLog.findMany({
        distinct: ['actorId'],
        select: { actorId: true, actorName: true },
        orderBy: { actorName: 'asc' },
        // A property has tens of staff accounts, not thousands; this bound exists
        // so a runaway table cannot turn a dropdown into a megabyte of JSON.
        take: 500,
      }),
    ]);

    res.json({
      services: services.map((s) => s.service),
      actions: actions.map((a) => a.action),
      actors: actors.filter((a) => a.actorId).map((a) => ({ id: a.actorId, name: a.actorName })),
    });
  } catch (err) {
    console.error('[Audit] Activity filters error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
