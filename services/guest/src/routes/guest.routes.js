const express = require('express');
const Redis = require('ioredis');
const { requireRole, ROLE_GROUPS } = require('../middleware/auth');

const ADMIN = ['ADMIN', 'MANAGER'];
const STAFF = ['ADMIN', 'MANAGER', 'FRONT_DESK']; // front desk maintains guest profiles

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

function nextProfileNumber() {
  return `G-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// POST /api/guests
router.post('/guests', requireRole(...STAFF), async (req, res) => {
  try {
    const { firstName, middleName, lastName, displayName, dateOfBirth, gender, nationality, vipLevel, tags } =
      req.body;
    const guest = await prisma.guest.create({
      data: {
        profileNumber: nextProfileNumber(),
        firstName,
        middleName,
        lastName,
        displayName: displayName || `${firstName} ${lastName}`,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        gender,
        nationality,
        vipLevel: vipLevel || 'NONE',
        tags,
      },
    });
    redis.publish(
      'guest:profile_created',
      JSON.stringify({ guestId: guest.id, profileNumber: guest.profileNumber })
    );
    res.status(201).json(guest);
  } catch (err) {
    console.error('[Guest] Create error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/guests/search?q=
router.get('/guests/search', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const guests = await prisma.guest.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
          { profileNumber: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 20,
    });
    res.json(guests);
  } catch (err) {
    console.error('[Guest] Search error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/guests/:id
router.get('/guests/:id', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const guest = await prisma.guest.findUnique({
      where: { id: req.params.id },
      include: { contacts: true, preferences: true, consents: true, loyalty: true },
    });
    if (!guest) return res.status(404).json({ error: 'Not found.' });
    res.json(guest);
  } catch (err) {
    console.error('[Guest] Get error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/guests/:id
const GUEST_EDITABLE = [
  'firstName',
  'middleName',
  'lastName',
  'displayName',
  'dateOfBirth',
  'gender',
  'nationality',
  'vipLevel',
  'tags',
];
router.patch('/guests/:id', requireRole(...STAFF), async (req, res) => {
  try {
    // Whitelist editable columns — never let the client set id/status/mergedInto
    // or unknown keys (mass assignment).
    const data = {};
    for (const k of GUEST_EDITABLE) {
      if (req.body[k] !== undefined)
        data[k] = k === 'dateOfBirth' && req.body[k] ? new Date(req.body[k]) : req.body[k];
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No editable fields provided.' });
    const guest = await prisma.guest.update({ where: { id: req.params.id }, data });
    redis.publish('guest:profile_updated', JSON.stringify({ guestId: guest.id }));
    res.json(guest);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Guest not found.' });
    console.error('[Guest] Update error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/guests/:id/merge
router.post('/guests/:id/merge', requireRole(...ADMIN), async (req, res) => {
  try {
    const { targetGuestId } = req.body;
    if (!targetGuestId) return res.status(400).json({ error: 'targetGuestId is required.' });
    if (targetGuestId === req.params.id)
      return res.status(400).json({ error: 'Cannot merge a guest into itself.' });
    const target = await prisma.guest.findUnique({ where: { id: targetGuestId } });
    if (!target) return res.status(404).json({ error: 'Target guest not found.' });
    if (target.status === 'MERGED' || target.status === 'ANONYMIZED') {
      return res
        .status(409)
        .json({ error: `Target guest is ${target.status} and cannot be a merge target.` });
    }
    const source = await prisma.guest.findUnique({ where: { id: req.params.id } });
    if (!source) return res.status(404).json({ error: 'Guest not found.' });
    const merged = await prisma.guest.update({
      where: { id: req.params.id },
      data: { status: 'MERGED', mergedInto: targetGuestId },
    });
    res.json(merged);
  } catch (err) {
    console.error('[Guest] Merge error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/guests/:id/preferences
router.get('/guests/:id/preferences', requireRole(...ROLE_GROUPS.OPS_READ), async (req, res) => {
  try {
    const prefs = await prisma.guestPreference.findMany({ where: { guestId: req.params.id } });
    res.json(prefs);
  } catch (err) {
    console.error('[Guest] Get prefs error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/guests/:id/preferences/:key
router.put('/guests/:id/preferences/:key', requireRole(...STAFF), async (req, res) => {
  try {
    const { category, value } = req.body;
    const pref = await prisma.guestPreference.upsert({
      where: {
        guestId_category_key: {
          guestId: req.params.id,
          category: category || 'general',
          key: req.params.key,
        },
      },
      create: { guestId: req.params.id, category: category || 'general', key: req.params.key, value },
      update: { value },
    });
    res.json(pref);
  } catch (err) {
    console.error('[Guest] Put pref error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/guests/:id/consent
router.post('/guests/:id/consent', requireRole(...STAFF), async (req, res) => {
  try {
    const { purpose, granted, legalBasis } = req.body;
    // Consent must be explicitly granted — an omitted `granted` defaults to
    // NOT granted rather than silently recording consent.
    const isGranted = granted === true;
    const consent = await prisma.consentRecord.create({
      data: {
        guestId: req.params.id,
        purpose,
        granted: isGranted,
        grantedAt: isGranted ? new Date() : null,
        legalBasis,
      },
    });
    res.status(201).json(consent);
  } catch (err) {
    console.error('[Guest] Consent error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/guests/:id/consent/:purpose
router.delete('/guests/:id/consent/:purpose', requireRole(...STAFF), async (req, res) => {
  try {
    const result = await prisma.consentRecord.updateMany({
      where: { guestId: req.params.id, purpose: req.params.purpose, granted: true },
      data: { granted: false, revokedAt: new Date() },
    });
    res.json({ revoked: result.count });
  } catch (err) {
    console.error('[Guest] Revoke consent error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/guests/:id/anonymize
router.post('/guests/:id/anonymize', requireRole(...ADMIN), async (req, res) => {
  try {
    // Scrub all PII atomically: profile fields, contacts, stored preferences,
    // and consent records. Loyalty balances are kept (non-PII) but detached
    // from any identifying data on the profile.
    const guest = await prisma.$transaction(async (px) => {
      const g = await px.guest.update({
        where: { id: req.params.id },
        data: {
          status: 'ANONYMIZED',
          firstName: 'REDACTED',
          middleName: null,
          lastName: 'REDACTED',
          displayName: 'REDACTED',
          dateOfBirth: null,
          gender: null,
          nationality: null,
          tags: null,
        },
      });
      await px.guestContact.deleteMany({ where: { guestId: req.params.id } });
      await px.guestPreference.deleteMany({ where: { guestId: req.params.id } });
      await px.consentRecord.deleteMany({ where: { guestId: req.params.id } });
      return g;
    });
    redis.publish('guest:anonymized', JSON.stringify({ guestId: guest.id }));
    res.json(guest);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Guest not found.' });
    console.error('[Guest] Anonymize error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/guests/:id/flag
router.post('/guests/:id/flag', requireRole(...ADMIN), async (req, res) => {
  try {
    const { reason, vipLevel } = req.body;
    // Require an explicit level rather than silently blacklisting the guest.
    if (!vipLevel) return res.status(400).json({ error: 'vipLevel is required.' });
    const guest = await prisma.guest.update({
      where: { id: req.params.id },
      data: { vipLevel },
    });
    redis.publish('guest:flagged', JSON.stringify({ guestId: guest.id, reason, vipLevel: guest.vipLevel }));
    res.json(guest);
  } catch (err) {
    console.error('[Guest] Flag error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/loyalty/:membershipNumber
router.get('/loyalty/:membershipNumber', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const acct = await prisma.loyaltyAccount.findUnique({
      where: { membershipNumber: req.params.membershipNumber },
      include: { guest: true },
    });
    if (!acct) return res.status(404).json({ error: 'Not found.' });
    res.json(acct);
  } catch (err) {
    console.error('[Guest] Loyalty lookup error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
