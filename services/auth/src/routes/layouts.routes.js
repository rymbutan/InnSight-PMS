// Room layouts — one shared truth per room tier.
//
// These used to be per-browser localStorage blobs, so "the layout" was whatever
// the machine in front of you happened to hold. Now every browser reads the same
// row, and the editor writes to it.
//
// Append-only: PUT inserts version N+1 rather than updating, so a bad edit never
// destroys the previous layout — it becomes version N+1 and version N is still
// there to restore. The live layout is the highest version for the tier.

const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../lib/prisma');

const EDIT_ROLES = ['ADMIN', 'MANAGER'];
const TIERS = ['Standard', 'Deluxe', 'Suite', 'Presidential'];
// A layout is ~60 fixtures of short numeric records. Well past anything real,
// but bounded so a malformed client cannot post megabytes into the column.
const MAX_FIXTURES = 400;
const KEEP_VERSIONS = 50;

function badTier(tier) {
  return !TIERS.includes(tier);
}

// Reject anything that is not plan-shaped BEFORE it reaches the database — a
// layout that fails to parse client-side would otherwise brick every room.
function validate(body) {
  const { room, furniture, walls, stations } = body || {};
  if (!room || typeof room !== 'object') return 'room is required.';
  if (!Number.isFinite(room.w) || !Number.isFinite(room.l)) return 'room.w and room.l must be numbers.';
  if (!Array.isArray(room.spawn) || room.spawn.length !== 2) return 'room.spawn must be [x, z].';
  for (const [name, val] of [
    ['furniture', furniture],
    ['walls', walls],
    ['stations', stations],
  ]) {
    if (!Array.isArray(val)) return `${name} must be an array.`;
    if (val.length > MAX_FIXTURES) return `${name} has more than ${MAX_FIXTURES} entries.`;
  }
  for (const f of furniture) {
    if (!f || typeof f !== 'object') return 'every fixture must be an object.';
    if (!f.model && !f.type) return 'every fixture needs a model or a type.';
    if (!Array.isArray(f.pos) || f.pos.length !== 2 || !f.pos.every(Number.isFinite)) {
      return 'every fixture needs pos: [x, z].';
    }
  }
  return null;
}

const shape = (row) => ({
  roomTier: row.roomTier,
  version: row.version,
  room: row.room,
  furniture: row.furniture,
  walls: row.walls,
  stations: row.stations,
  updatedBy: row.updatedBy,
  updatedAt: row.createdAt,
});

// GET /api/room-layouts — the live layout for every tier that has one.
//
// Deliberately readable by any signed-in account: a housekeeping trainee cannot
// run the 3D sim without the room they are standing in. Nothing here is
// sensitive — it is furniture coordinates — and writes stay admin-only below.
router.get('/room-layouts', verifyToken, async (_req, res) => {
  try {
    const rows = await prisma.roomLayout.findMany({
      orderBy: [{ roomTier: 'asc' }, { version: 'desc' }],
    });
    // Highest version per tier wins.
    const live = new Map();
    for (const r of rows) if (!live.has(r.roomTier)) live.set(r.roomTier, r);
    res.json([...live.values()].map(shape));
  } catch (err) {
    console.error('[Auth] List room layouts error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/room-layouts/:tier/versions — the backup history for one tier.
router.get('/room-layouts/:tier/versions', verifyToken, requireRole(...EDIT_ROLES), async (req, res) => {
  try {
    if (badTier(req.params.tier)) return res.status(400).json({ error: 'Unknown room tier.' });
    const rows = await prisma.roomLayout.findMany({
      where: { roomTier: req.params.tier },
      orderBy: { version: 'desc' },
      select: { version: true, updatedBy: true, createdAt: true },
    });
    res.json(rows);
  } catch (err) {
    console.error('[Auth] Layout versions error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/room-layouts/:tier — save a new version. This is the autosave target.
router.put('/room-layouts/:tier', verifyToken, requireRole(...EDIT_ROLES), async (req, res) => {
  try {
    const tier = req.params.tier;
    if (badTier(tier)) return res.status(400).json({ error: 'Unknown room tier.' });

    const problem = validate(req.body);
    if (problem) return res.status(400).json({ error: problem });

    const { room, furniture, walls, stations } = req.body;

    // Two editors saving at once both compute the same next version; the unique
    // index rejects the loser, so retry once against the new highest.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const top = await prisma.roomLayout.findFirst({
        where: { roomTier: tier },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (top?.version ?? 0) + 1;
      try {
        const saved = await prisma.roomLayout.create({
          data: {
            roomTier: tier,
            version,
            room,
            furniture,
            walls,
            stations,
            updatedBy: req.user?.username || null,
          },
        });
        // Keep the history bounded; the last 50 are plenty to walk back through.
        const stale = await prisma.roomLayout.findMany({
          where: { roomTier: tier },
          orderBy: { version: 'desc' },
          skip: KEEP_VERSIONS,
          select: { id: true },
        });
        if (stale.length) {
          await prisma.roomLayout.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
        }
        return res.json(shape(saved));
      } catch (err) {
        if (err.code !== 'P2002') throw err; // not a version collision — real failure
      }
    }
    return res.status(409).json({ error: 'Another editor is saving; try again.' });
  } catch (err) {
    console.error('[Auth] Save room layout error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/room-layouts/:tier/restore/:version — bring an old version back.
// Restoring SAVES it as a new version, so restoring is itself undoable.
router.post(
  '/room-layouts/:tier/restore/:version',
  verifyToken,
  requireRole(...EDIT_ROLES),
  async (req, res) => {
    try {
      const tier = req.params.tier;
      if (badTier(tier)) return res.status(400).json({ error: 'Unknown room tier.' });
      const version = Number(req.params.version);
      if (!Number.isInteger(version)) return res.status(400).json({ error: 'Bad version.' });

      const old = await prisma.roomLayout.findUnique({
        where: { roomTier_version: { roomTier: tier, version } },
      });
      if (!old) return res.status(404).json({ error: 'That version does not exist.' });

      const top = await prisma.roomLayout.findFirst({
        where: { roomTier: tier },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const saved = await prisma.roomLayout.create({
        data: {
          roomTier: tier,
          version: (top?.version ?? 0) + 1,
          room: old.room,
          furniture: old.furniture,
          walls: old.walls,
          stations: old.stations,
          updatedBy: req.user?.username || null,
        },
      });
      res.json(shape(saved));
    } catch (err) {
      console.error('[Auth] Restore room layout error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// DELETE /api/room-layouts/:tier — drop every stored version, so the tier falls
// back to the layout committed in web/src/sim/roomLayouts.js. The "revert to
// file" escape hatch, now global rather than per-browser.
router.delete('/room-layouts/:tier', verifyToken, requireRole(...EDIT_ROLES), async (req, res) => {
  try {
    if (badTier(req.params.tier)) return res.status(400).json({ error: 'Unknown room tier.' });
    await prisma.roomLayout.deleteMany({ where: { roomTier: req.params.tier } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Auth] Reset room layout error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
