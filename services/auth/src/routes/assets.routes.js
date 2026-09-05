// Uploaded room assets — .glb fixtures an admin imports from their own machine.
//
// The shipped fixtures live in web/public/models and are baked into the image.
// These are added at runtime and stored in Postgres, so a new fixture is live
// for every browser the moment it uploads, without a rebuild or a deploy.
//
// Mounted under /api, giving /api/room-assets*. It sits beside layouts.routes.js
// on purpose: an asset is only meaningful because a layout references its key,
// and the two are edited from the same screen by the same role.

const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../lib/prisma');

const EDIT_ROLES = ['ADMIN', 'MANAGER'];
// 24 MB. The shipped set is ~44 MB for forty meshopt-compressed models, so a
// single fixture over this is almost certainly an un-optimised export — the cap
// is a guard rail, and the error says how to get under it.
const MAX_BYTES = 24 * 1024 * 1024;
// Mirrors the CHECK constraint on the column. Lowercase because fixture keys
// are compared verbatim against layout JSON, and a key that differs only in
// case would silently be a second fixture.
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// glTF-Binary starts with the ASCII magic "glTF" followed by a uint32 version.
// Checking the bytes rather than trusting the filename is what stops a renamed
// .exe being stored and later served back to every browser as a model.
function isGlb(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf.toString('ascii', 0, 4) !== 'glTF') return false;
  const version = buf.readUInt32LE(4);
  return version === 1 || version === 2;
}

// Turns "Modern Chair v2.glb" into "modern_chair_v2".
function slugify(name) {
  return String(name || '')
    .replace(/\.(glb|gltf)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

// GET /api/room-assets — the catalogue. Never the bytes: this is polled by every
// editor session, and shipping 24MB per fixture in a list response would make
// opening the palette a multi-hundred-megabyte download.
router.get('/room-assets', verifyToken, async (_req, res) => {
  try {
    const rows = await prisma.roomAsset.findMany({
      select: { key: true, filename: true, sizeBytes: true, uploadedBy: true, updatedAt: true },
      orderBy: { key: 'asc' },
    });
    res.json(rows);
  } catch (err) {
    console.error('[Auth] List room assets error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/room-assets/:key/file — the model itself, for GLTFLoader.
//
// UNAUTHENTICATED, deliberately. Two reasons, and they reinforce each other:
//
//  1. It cannot be otherwise. three.js loads a .glb through GLTFLoader, which
//     issues its own fetch and has no way to carry the app's bearer token. An
//     authenticated URL here would simply never load a model — in the editor or
//     in a student's room.
//  2. It changes nothing. The forty shipped fixtures are static files nginx
//     already serves to anyone at /models/*.glb with no auth at all. Gating the
//     uploaded ones would be inconsistent for no gain: a chair mesh is not
//     hotel data.
//
// The list, upload and delete routes below stay locked to ADMIN/MANAGER, so who
// can ADD or REMOVE a fixture is still controlled — only reading one is open.
router.get('/room-assets/:key/file', async (req, res) => {
  try {
    const row = await prisma.roomAsset.findUnique({ where: { key: req.params.key } });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    // Prisma hands back a Uint8Array. res.send() would JSON-stringify that into
    // {"0":103,"1":108,...} and label it model/gltf-binary — the same trap the
    // avatar route hit. Buffer.from + res.end sends the actual bytes.
    const bytes = Buffer.from(row.data);
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Content-addressed by updatedAt via the client's cache-buster, so a long
    // cache is safe and a re-upload still busts it.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(bytes);
  } catch (err) {
    console.error('[Auth] Fetch room asset error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/room-assets?key=&filename= — raw .glb bytes, not multipart.
// Same reasoning as the avatar route: multipart would add a dependency to carry
// one file, and base64 in JSON inflates the body by a third for nothing.
router.post(
  '/room-assets',
  verifyToken,
  requireRole(...EDIT_ROLES),
  express.raw({ type: ['model/gltf-binary', 'application/octet-stream'], limit: MAX_BYTES }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Send the raw .glb bytes as the request body.' });
      }
      if (req.body.length > MAX_BYTES) {
        return res.status(413).json({ error: 'Model must be 24MB or smaller.' });
      }
      if (!isGlb(req.body)) {
        return res.status(400).json({
          error: 'That file is not a binary glTF (.glb). Export as .glb, or convert a .gltf first.',
        });
      }
      const filename = String(req.query.filename || 'model.glb').slice(0, 200);
      const key = slugify(req.query.key || filename);
      if (!KEY_RE.test(key)) {
        return res.status(400).json({
          error: 'Asset name must start with a letter or digit and use only letters, digits, _ and -.',
        });
      }
      const saved = await prisma.roomAsset.upsert({
        where: { key },
        create: {
          key,
          filename,
          mime: 'model/gltf-binary',
          sizeBytes: req.body.length,
          data: req.body,
          uploadedBy: req.user?.sub || null,
        },
        // Re-uploading the same key REPLACES the model. That is the intent —
        // it is how you fix an export without every layout that references the
        // key having to be re-pointed at a new one.
        update: {
          filename,
          sizeBytes: req.body.length,
          data: req.body,
          uploadedBy: req.user?.sub || null,
        },
        select: { key: true, filename: true, sizeBytes: true, updatedAt: true },
      });
      res.status(201).json(saved);
    } catch (err) {
      console.error('[Auth] Upload room asset error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// DELETE /api/room-assets/:key
router.delete('/room-assets/:key', verifyToken, requireRole(...EDIT_ROLES), async (req, res) => {
  try {
    await prisma.roomAsset.delete({ where: { key: req.params.key } });
    // Deliberately NOT cascading into the layouts. A layout that still names
    // this key falls back to its procedural placeholder — the same thing that
    // happens for any unregistered key — so a delete degrades one fixture
    // instead of silently rewriting every room that used it.
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Not found.' });
    console.error('[Auth] Delete room asset error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
