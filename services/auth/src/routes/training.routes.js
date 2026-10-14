const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../lib/prisma');
const { validateScenario } = require('../lib/scenarioValidation');
const { planCategoryCreate } = require('../lib/categoryRules');

const MGMT = ['ADMIN', 'MANAGER']; // can view all staff results
// INSPECTION is the room case study that replaced the turnover mini-games
// (Changes-to-be-made doc, item 3). Unknown activities are coerced to TURNOVER
// below, so omitting it here would silently mislog every inspection run.
const ACTIVITIES = ['TURNOVER', 'GUEST_SERVICE', 'LOST_FOUND', 'INSPECTION'];

// Server-authoritative scoring from the sim's per-task Did/Why outcomes.
//
// ⚠️ CASE MATTERS HERE. This table was keyed `{ GOOD: 1, ISSUES: 0.5 }`, but the
// sim sends the values from web/src/sim/taskKit.jsx, which are LOWERCASE:
//   export const GOOD = 'good'; ISSUES = 'issues'; SKIPPED = 'skipped';
// So `SC[it.procedure]` was `SC['good']` → undefined → 0 for every single task,
// and EVERY training run scored 0%. The `!== 'SKIPPED'` test never matched either,
// so skipped tasks were counted as attempted. Normalise before comparing, and
// accept either case so an older client can't silently zero itself again.
const SC = { good: 1, issues: 0.5 }; // anything else (skipped/null) = 0
const norm = (v) => String(v ?? '').toLowerCase();

function scoreItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { scorePct: 0, tasksTotal: 0, tasksAttempted: 0, knowledgeGaps: 0 };
  }
  let total = 0,
    attempted = 0,
    gaps = 0;
  for (const it of items) {
    const proc = SC[norm(it.procedure)] ?? 0;
    const know = it.understanding == null ? proc : (SC[norm(it.understanding)] ?? 0);
    total += (proc + know) / 2;
    if (it.procedure && norm(it.procedure) !== 'skipped') attempted += 1;
    if (norm(it.understanding) === 'issues') gaps += 1;
  }
  return {
    scorePct: Math.round((100 * total) / items.length),
    tasksTotal: items.length,
    tasksAttempted: attempted,
    knowledgeGaps: gaps,
  };
}
const toneFor = (pct) => (pct >= 85 ? 'great' : pct >= 60 ? 'ok' : 'bad');

// POST /api/training/results — record a completed training run for the caller.
// ── Fault categories (shared library) ───────────────────────────────────────
// The six built-in categories live in the client's defects.js. These are the
// teacher-authored additions, and they are GLOBAL: authored once, offered on
// every scenario and every room. That is the whole point — they used to be a
// per-scenario JSON blob, so a category could not be reused anywhere.

const CATEGORY_ID = /^custom_[a-z0-9]+(?:_[a-z0-9]+)*$/;

function readCategory(body) {
  const label = typeof body?.label === 'string' ? body.label.trim() : '';
  const why = typeof body?.why === 'string' ? body.why.trim() : '';
  const feedback = typeof body?.feedback === 'string' && body.feedback.trim() ? body.feedback.trim() : null;

  if (!label) return { error: 'A category needs a label.' };
  if (label.length > 120) return { error: 'That label is too long.' };
  // Required, not optional: it is the reason printed on the student's assessment,
  // and a category without one marks them wrong with a blank explanation.
  if (!why) {
    return { error: 'A category needs a "why" — the reason shown to the student after grading.' };
  }
  if (why.length > 1000 || (feedback && feedback.length > 1000)) {
    return { error: 'That explanation is too long.' };
  }
  return { label, why, feedback };
}

// GET /api/training/categories — readable by any signed-in account, because the
// flag menu a student uses has to offer them.
router.get('/training/categories', verifyToken, async (req, res) => {
  try {
    const where = String(req.query.all || '') === 'true' ? {} : { active: true };
    const rows = await prisma.inspectionCategory.findMany({ where, orderBy: { label: 'asc' } });
    res.json(rows);
  } catch (err) {
    console.error('[Auth] List categories error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/training/categories — create, or revive/update one with the same
// label. Re-saving a category a teacher already made must not fail with a
// duplicate-key error; that was indistinguishable from "cannot save".
router.post('/training/categories', verifyToken, requireRole(...MGMT), async (req, res) => {
  try {
    const parsed = readCategory(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    // An explicit id is an intentional update of that row. Without one the id is
    // derived from the label, and that must never overwrite a different category
    // that happens to share its slug (see planCategoryCreate).
    let id = typeof req.body?.id === 'string' && req.body.id ? req.body.id : '';
    if (!id) {
      const rows = await prisma.inspectionCategory.findMany({ select: { id: true, label: true, active: true } });
      const plan = planCategoryCreate(parsed.label, rows);
      if (plan.error) return res.status(plan.status).json({ error: plan.error });
      id = plan.id;
    }
    if (!CATEGORY_ID.test(id)) {
      return res.status(400).json({ error: `Category id "${id}" must look like custom_<slug>.` });
    }

    const saved = await prisma.inspectionCategory.upsert({
      where: { id },
      update: { ...parsed, active: true },
      create: { id, ...parsed, createdBy: req.user?.username || null },
    });
    res.status(201).json(saved);
  } catch (err) {
    console.error('[Auth] Save category error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/training/categories/:id
router.patch('/training/categories/:id', verifyToken, requireRole(...MGMT), async (req, res) => {
  try {
    const existing = await prisma.inspectionCategory.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Category not found.' });

    const parsed = readCategory({ ...existing, ...req.body });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const active = typeof req.body?.active === 'boolean' ? req.body.active : existing.active;
    const saved = await prisma.inspectionCategory.update({
      where: { id: existing.id },
      data: { ...parsed, active },
    });
    res.json(saved);
  } catch (err) {
    console.error('[Auth] Update category error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/training/categories/:id — retired, not erased. Scenarios already
// saved may reference it, and a hard delete would leave those tags naming a
// category that no longer exists: an unwinnable fault for the student.
router.delete('/training/categories/:id', verifyToken, requireRole(...MGMT), async (req, res) => {
  try {
    const existing = await prisma.inspectionCategory.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Category not found.' });
    await prisma.inspectionCategory.update({
      where: { id: existing.id },
      data: { active: false },
    });
    res.json({ ok: true, retired: true });
  } catch (err) {
    console.error('[Auth] Retire category error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/training/results', verifyToken, async (req, res) => {
  try {
    const { roomTier, items, activity } = req.body;
    if (!roomTier || !Array.isArray(items)) {
      return res.status(400).json({ error: 'roomTier and items[] required.' });
    }
    // Whitelist rather than trusting the client, so an unexpected value can't
    // create a phantom activity that skews the competency summary.
    const act = ACTIVITIES.includes(activity) ? activity : 'TURNOVER';
    const s = scoreItems(items);
    const rec = await prisma.trainingResult.create({
      data: {
        userId: req.user.sub,
        userName: req.user.username || req.user.displayName || null,
        activity: act,
        roomTier: String(roomTier),
        scorePct: s.scorePct,
        tone: toneFor(s.scorePct),
        tasksTotal: s.tasksTotal,
        tasksAttempted: s.tasksAttempted,
        knowledgeGaps: s.knowledgeGaps,
        detail: items,
      },
    });
    res.status(201).json(rec);
  } catch (err) {
    console.error('[Auth] Record training result error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/training/results?userId= — own results by default; managers/admins may
// pass a userId or omit it to see everyone.
router.get('/training/results', verifyToken, async (req, res) => {
  try {
    const isMgmt = (req.user.roles || []).some((r) => MGMT.includes(r));
    const where = {};
    if (req.query.userId) {
      if (req.query.userId !== req.user.sub && !isMgmt) return res.status(403).json({ error: 'Forbidden.' });
      where.userId = req.query.userId;
    } else if (!isMgmt) {
      where.userId = req.user.sub; // non-managers only see their own
    }
    const list = await prisma.trainingResult.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
    res.json(list);
  } catch (err) {
    console.error('[Auth] List training results error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/training/competency — per-staff summary: best score per room tier +
// whether they've reached a competent threshold (>=85). Management only.
router.get('/training/competency', verifyToken, requireRole(...MGMT), async (req, res) => {
  try {
    const rows = await prisma.trainingResult.findMany({ orderBy: { createdAt: 'desc' } });
    const byUser = new Map();
    for (const r of rows) {
      const u = byUser.get(r.userId) || {
        userId: r.userId,
        userName: r.userName,
        runs: 0,
        tiers: {},
        activities: {},
        lastAt: r.createdAt,
      };
      u.runs += 1;
      // Room-tier mastery counts the room-based activities: the legacy TURNOVER
      // shift and the INSPECTION case study that replaced it. Both are performed
      // against a room tier and both score 0-100, so best-per-tier stays
      // meaningful across the transition. Folding a Guest Services run into
      // `tiers` would make it look like an unmastered room type and hold
      // `competent` at false forever.
      if ((r.activity || 'TURNOVER') === 'TURNOVER' || r.activity === 'INSPECTION') {
        const best = u.tiers[r.roomTier];
        if (!best || r.scorePct > best) u.tiers[r.roomTier] = r.scorePct;
      } else {
        const bestA = u.activities[r.activity];
        if (!bestA || r.scorePct > bestA) u.activities[r.activity] = r.scorePct;
      }
      byUser.set(r.userId, u);
    }
    const summary = [...byUser.values()].map((u) => {
      const scores = Object.values(u.tiers);
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
      return { ...u, avgBest: avg, competent: scores.length > 0 && scores.every((s) => s >= 85) };
    });
    res.json(summary);
  } catch (err) {
    console.error('[Auth] Competency summary error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Instructor-authored inspection scenarios ────────────────────────────────
// A scenario is a room deliberately set up wrong. The booking it is wrong FOR is
// NOT part of it — that is the real reservation on whichever room of this tier
// the student is standing in, resolved client-side at run time (`booking` is a
// legacy column nothing reads).
// Reads are open to all staff because the student's sim fetches them on
// every run; writes are management-only, matching how property configuration is
// guarded elsewhere.

// GET /api/training/scenarios?roomTier=&active=true
router.get('/training/scenarios', verifyToken, async (req, res) => {
  try {
    const where = {};
    if (req.query.roomTier) where.roomTier = req.query.roomTier;
    if (req.query.active === 'true') where.active = true;
    if (req.query.active === 'false') where.active = false;
    const list = await prisma.inspectionScenario.findMany({
      where,
      orderBy: [{ roomTier: 'asc' }, { name: 'asc' }],
      take: 200,
    });
    res.json(list);
  } catch (err) {
    console.error('[Auth] List scenarios error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/training/scenarios
// A tag may name a built-in category or a teacher-authored one. `validateScenario`
// is a pure function and cannot see the library, so it only checks the SHAPE of a
// custom id — leaving it possible to save a tag naming a category nobody ever
// created. That fault would render with no way to categorise it correctly: the
// flag menu cannot offer what does not exist. So the ids are checked here, where
// the database is reachable.
async function unknownCustomCategories(data) {
  const ids = new Set();
  for (const t of data?.tags || []) if (CATEGORY_ID.test(t?.defectId || '')) ids.add(t.defectId);
  for (const a of data?.anchors || []) if (CATEGORY_ID.test(a?.defectId || '')) ids.add(a.defectId);
  // A scenario carrying its own legacy `categories` list declares them itself.
  for (const c of data?.categories || []) ids.delete(c.id);
  if (!ids.size) return [];
  const found = await prisma.inspectionCategory.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true },
  });
  const have = new Set(found.map((r) => r.id));
  return [...ids].filter((id) => !have.has(id));
}

router.post('/training/scenarios', verifyToken, requireRole(...MGMT), async (req, res) => {
  try {
    const v = validateScenario(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const missing = await unknownCustomCategories(v.data);
    if (missing.length) {
      return res.status(400).json({
        error: `These fault categories do not exist yet: ${missing.join(', ')}. Add them under "Fault categories" first.`,
      });
    }
    const row = await prisma.inspectionScenario.create({
      data: { ...v.data, createdBy: req.user?.sub },
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('[Auth] Create scenario error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/training/scenarios/:id — rename, re-author, activate/deactivate
router.patch('/training/scenarios/:id', verifyToken, requireRole(...MGMT), async (req, res) => {
  try {
    const v = validateScenario(req.body, true);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (!Object.keys(v.data).length) return res.status(400).json({ error: 'Nothing to update.' });
    const missing = await unknownCustomCategories(v.data);
    if (missing.length) {
      return res.status(400).json({
        error: `These fault categories do not exist yet: ${missing.join(', ')}. Add them under "Fault categories" first.`,
      });
    }
    const row = await prisma.inspectionScenario
      .update({ where: { id: req.params.id }, data: v.data })
      .catch((e) => {
        if (e.code === 'P2025') return null;
        throw e;
      });
    if (!row) return res.status(404).json({ error: 'Scenario not found.' });
    res.json(row);
  } catch (err) {
    console.error('[Auth] Update scenario error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/training/scenarios/:id
router.delete('/training/scenarios/:id', verifyToken, requireRole(...MGMT), async (req, res) => {
  try {
    const row = await prisma.inspectionScenario.delete({ where: { id: req.params.id } }).catch((e) => {
      if (e.code === 'P2025') return null;
      throw e;
    });
    if (!row) return res.status(404).json({ error: 'Scenario not found.' });
    // Rooms pinned to this scenario go back to generating their faults. The sim
    // tolerates a dangling id, but leaving the rows would quietly show a
    // supervisor a room as "assigned" to a scenario that no longer exists.
    await prisma.scenarioAssignment
      .deleteMany({ where: { scenarioId: req.params.id } })
      .catch((e) => console.error('[Auth] Clear assignments error:', e.message));
    res.status(204).end();
  } catch (err) {
    console.error('[Auth] Delete scenario error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Which scenario a room hands out ─────────────────────────────────────────
// A supervisor pins a premade scenario to a booked room; a room with no pin
// generates its faults or draws from its tier's authored pool. Reads are open to
// all staff because the sim resolves the pin on every run; writes are
// management-only, matching how the scenarios themselves are guarded.
//
// The link lives in this service, not as a column on inventory's Room: training
// owns the mapping, and there is no cross-service foreign key to enforce it.

// GET /api/training/scenario-assignments        → every pin, for the room grid
// GET /api/training/scenario-assignments?roomId= → one room's pin, or null
router.get('/training/scenario-assignments', verifyToken, async (req, res) => {
  try {
    if (req.query.roomId) {
      const row = await prisma.scenarioAssignment.findUnique({
        where: { roomId: String(req.query.roomId) },
      });
      return res.json(row || null);
    }
    const list = await prisma.scenarioAssignment.findMany({ take: 1000 });
    res.json(list);
  } catch (err) {
    console.error('[Auth] List scenario assignments error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/training/scenario-assignments/:roomId  { scenarioId }
router.put('/training/scenario-assignments/:roomId', verifyToken, requireRole(...MGMT), async (req, res) => {
  try {
    const scenarioId = req.body?.scenarioId;
    if (!scenarioId || typeof scenarioId !== 'string') {
      return res.status(400).json({ error: 'scenarioId is required.' });
    }
    // Checked at write time so a supervisor finds out now, rather than a
    // student finding out by being handed a generated room they did not expect.
    const exists = await prisma.inspectionScenario.findUnique({ where: { id: scenarioId } });
    if (!exists) return res.status(404).json({ error: 'Scenario not found.' });

    const roomId = String(req.params.roomId);
    const row = await prisma.scenarioAssignment.upsert({
      where: { roomId },
      create: { roomId, scenarioId, assignedBy: req.user?.sub },
      update: { scenarioId, assignedBy: req.user?.sub },
    });
    res.json(row);
  } catch (err) {
    console.error('[Auth] Assign scenario error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/training/scenario-assignments/:roomId — back to auto-generation
router.delete(
  '/training/scenario-assignments/:roomId',
  verifyToken,
  requireRole(...MGMT),
  async (req, res) => {
    try {
      // deleteMany, not delete: clearing a room that was never pinned is the
      // supervisor picking "auto-generate" on a fresh room, not an error.
      await prisma.scenarioAssignment.deleteMany({ where: { roomId: String(req.params.roomId) } });
      res.status(204).end();
    } catch (err) {
      console.error('[Auth] Clear scenario assignment error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

module.exports = router;
// Exported for unit tests — the scoring is the part that silently broke.
module.exports.scoreItems = scoreItems;
module.exports.toneFor = toneFor;
