const express = require('express');
const Redis = require('ioredis');
const { requireRole, ROLE_GROUPS } = require('../middleware/auth');
const { makeServiceCaller } = require('../lib/serviceCall');

const ADMIN = ['ADMIN', 'MANAGER'];
const STAFF = ['ADMIN', 'MANAGER', 'FRONT_DESK']; // front desk maintains guest profiles

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const STAY_URL = process.env.STAY_URL || 'http://stay-service:3006';
// Used on exactly one path — the delete below. Claims no roles, because the
// only question it asks is "does this guest have a live stay", which
// /api/stays answers to any authenticated caller.
const stayCall = makeServiceCaller({ name: 'guest', roles: [], permissions: [] });

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
    // No term = the most recent profiles, NOT an empty array. This endpoint
    // backs the Guest Profiles list as well as the type-ahead, and returning []
    // for a blank query meant the page opened empty and stayed empty: you could
    // create a guest and watch nothing appear, because the only way to make a
    // row show up was to already know the name and search for it.
    const guests = await prisma.guest.findMany({
      where: {
        status: 'ACTIVE',
        ...(q
          ? {
              OR: [
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
                { displayName: { contains: q, mode: 'insensitive' } },
                { profileNumber: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      // Newest first so a profile created a second ago is the first row on the
      // page. The type-ahead is unaffected — it never sends a blank term.
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json(guests);
  } catch (err) {
    console.error('[Guest] Search error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/guests/batch?ids=a,b,c — resolve many guests' display names in one
// call. The folio list renders a guest name per row and would otherwise issue
// one request per row.
//
// MUST be declared BEFORE /guests/:id. Express matches in declaration order, so
// registering it after would make this path match as a guest whose id is the
// literal string 'batch' — the same trap /folios/outstanding documents in the
// folio service.
router.get('/guests/batch', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // No ids means no guests. Falling through to "every guest" would turn a
    // missing query param into a full PII dump.
    if (ids.length === 0) return res.json([]);
    // Bounded so one caller cannot ask for the whole table in a single request.
    const guests = await prisma.guest.findMany({
      where: { id: { in: ids.slice(0, 200) } },
      select: { id: true, displayName: true, profileNumber: true, nationality: true },
    });
    res.json(guests);
  } catch (err) {
    console.error('[Guest] Batch lookup error:', err.message);
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
const { nextDisplayName } = require('../lib/displayName');

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

    // A rename has to carry displayName with it, or every document that prints
    // `guest.displayName` keeps the old name. See lib/displayName.js for why an
    // author-written display name is left alone.
    const before = await prisma.guest.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const derived = nextDisplayName(before, data);
    if (derived) data.displayName = derived;

    const guest = await prisma.guest.update({ where: { id: req.params.id }, data });
    // The new name travels WITH the event. Reservation and Stay both keep a
    // denormalised `guestName` (it is what the calendar, the records list and
    // arrivals render), and their subscribers would otherwise have to call back
    // here just to learn what changed.
    redis.publish(
      'guest:profile_updated',
      JSON.stringify({ guestId: guest.id, displayName: guest.displayName || null })
    );
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

// DELETE /api/guests/:id — remove the profile permanently.
//
// ADMIN and MANAGER only. Front desk maintains profiles (POST/PATCH above) but
// does not destroy them: a mistyped name is fixed with an edit, and the one
// operation that cannot be undone should need someone who can also undo the
// decision to hire.
//
// DELETE vs ANONYMIZE. Both exist and they answer different questions.
// Anonymize (above) is the data-protection action: the guest stayed here, the
// stay must remain on the books, and only the identifying fields go. Delete is
// for a profile that should never have existed — a duplicate, a test record, a
// typo'd walk-in — where there is nothing to preserve. If a guest asks to be
// forgotten and has history, anonymize is the correct tool and this route will
// still happily run; the difference is a judgement the operator makes, which is
// why the confirmation in the browser spells both out.
//
// WHAT IS NOT CASCADED, AND WHY THAT IS SAFE. Reservations, stays and folios
// live in other services and hold `guestId` as a plain string — the
// per-service-database rule means there is no foreign key to violate. They also
// denormalise `guestName` at write time, so a past booking keeps showing who it
// was for after the profile is gone. It loses the link to a profile, not the
// record of the stay.
router.delete('/guests/:id', requireRole(...ADMIN), async (req, res) => {
  try {
    const guest = await prisma.guest.findUnique({ where: { id: req.params.id } });
    if (!guest) return res.status(404).json({ error: 'Guest not found.' });

    // The one refusal. Erasing the profile of the guest currently in a room
    // leaves the desk holding a stay it cannot look up, mid-stay, which is the
    // exact moment they most need to. Anything already departed is fair game.
    try {
      const stays = await stayCall.call(`${STAY_URL}/api/stays?guestId=${encodeURIComponent(guest.id)}`);
      const live = (Array.isArray(stays) ? stays : []).find((s) => s.status === 'IN_HOUSE');
      if (live) {
        return res.status(409).json({
          error:
            'This guest is currently checked in. Check them out first, or use Anonymize to clear their ' +
            'personal details while keeping the stay.',
        });
      }
    } catch (err) {
      // FAIL CLOSED. Everywhere else in this codebase a degraded dependency
      // falls open so the desk keeps working — but "keep working" for a delete
      // means destroying a profile we could not prove was safe to destroy.
      // Refusing costs a retry; guessing costs the record.
      console.error('[Guest] Delete: stay lookup failed, refusing:', err.message);
      return res.status(503).json({
        error: 'Cannot confirm whether this guest is checked in right now. Please try again shortly.',
      });
    }

    await prisma.$transaction(async (px) => {
      // The guest's own rows, which DO have foreign keys to it.
      await px.guestContact.deleteMany({ where: { guestId: guest.id } });
      await px.guestPreference.deleteMany({ where: { guestId: guest.id } });
      await px.consentRecord.deleteMany({ where: { guestId: guest.id } });
      await px.loyaltyAccount.deleteMany({ where: { guestId: guest.id } });
      await px.guest.delete({ where: { id: guest.id } });
    });

    console.log(`[Guest] Profile ${guest.profileNumber} deleted by ${req.user?.username || req.user?.sub}.`);
    redis.publish(
      'guest:profile_deleted',
      JSON.stringify({
        guestId: guest.id,
        profileNumber: guest.profileNumber,
        guestName: guest.displayName || `${guest.firstName} ${guest.lastName}`.trim(),
        deletedBy: req.user?.username || req.user?.sub,
      })
    );
    res.json({ deleted: true, id: guest.id, profileNumber: guest.profileNumber });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Guest not found.' });
    console.error('[Guest] Delete error:', err.message);
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
