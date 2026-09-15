const express = require('express');
const Redis = require('ioredis');

const router = express.Router();
const prisma = require('../lib/prisma');
const retention = require('../retention/policy');
const profanity = require('../moderation/profanity');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('error', (e) => console.error('[Messaging] redis error:', e.message));

// ─────────────────────────────────────────────────────────────────────────────
// NO ROLE GUARDS IN THIS FILE, AND THAT IS THE FEATURE.
//
// Every other service restricts its routes by role because its data belongs to a
// department: folios are the desk's, work orders are maintenance's. Messages
// belong to the two people in the conversation and to nobody else, so "which
// role are you" is the wrong question — a housekeeper must be able to message
// the manager exactly as the manager messages them.
//
// What replaces the role check is an OWNERSHIP check: every route below derives
// the caller from `req.user.sub` (set by verifyToken) and never from a parameter,
// so the only inbox you can read is your own and the only presence you can
// publish is your own. See routes/authz.test.js, where each route is listed as
// deliberately open with that reasoning.
// ─────────────────────────────────────────────────────────────────────────────

// Long enough for a paragraph of context about a task, short enough that the
// column never becomes an attachment channel by accident.
const MAX_BODY = 4000;

// Presence is a Redis key that outlives one heartbeat but not two missed ones.
// The browser beats every 25s (web/src/components/Layout.jsx), so 45s tolerates
// a single dropped request without flickering the dot to offline.
const PRESENCE_TTL_SEC = 45;
const presenceKey = (userId) => `presence:${userId}`;

// The stable conversation key: the same unordered pair in both directions.
const pairOf = (a, b) => (a < b ? { userLo: a, userHi: b } : { userLo: b, userHi: a });

// EVERY read below is filtered by the retention cutoff, not just the thread.
// The purge sweep runs once a minute, so for up to a minute there are rows in
// the table that the configured policy says should be gone. If the contact list
// still previewed them, or the badge still counted them, a message would appear
// to outlive the setting — and the one place that inconsistency would show up
// worst is an unread badge for a message that no longer opens. See
// retention/policy.js for why the cutoff and the sweep are separate layers.

// GET /api/messages/contacts — everyone you can talk to, with live presence and
// what you have not read from each of them.
router.get('/messages/contacts', async (req, res) => {
  try {
    const me = req.user.sub;

    const contacts = await prisma.userCache.findMany({
      where: { status: 'ACTIVE', id: { not: me } },
      orderBy: { displayName: 'asc' },
    });
    if (contacts.length === 0) return res.json([]);

    const ids = contacts.map((c) => c.id);
    const live = await retention.createdAtFilter();

    // One pipelined round trip for every contact's presence, not one call each —
    // this runs on a ~4s poll for every signed-in user, so an N-call loop here
    // would multiply the whole staff's poll into a Redis flood.
    const presence = await redis.mget(ids.map(presenceKey)).catch((e) => {
      // Presence degrading to "everyone offline" is cosmetic. Failing the whole
      // contact list because Redis blinked would not be.
      console.error('[Messaging] presence read failed:', e.message);
      return [];
    });
    const onlineById = new Map(ids.map((id, i) => [id, presence[i] != null]));

    // Unread counts for every sender at once. groupBy keeps this one query
    // regardless of how many people have written to me.
    const unread = await prisma.message.groupBy({
      by: ['senderId'],
      where: { recipientId: me, readAt: null, ...live },
      _count: { _all: true },
    });
    const unreadBySender = new Map(unread.map((u) => [u.senderId, u._count._all]));

    // The most recent message in each of my conversations, for ordering and a
    // preview. Bounded by my own message volume, not the whole table.
    const recent = await prisma.message.findMany({
      where: { OR: [{ senderId: me }, { recipientId: me }], ...live },
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: { senderId: true, recipientId: true, body: true, createdAt: true },
    });
    const lastByPeer = new Map();
    for (const m of recent) {
      const peer = m.senderId === me ? m.recipientId : m.senderId;
      if (!lastByPeer.has(peer)) lastByPeer.set(peer, m);
    }

    const rows = contacts.map((c) => {
      const last = lastByPeer.get(c.id);
      return {
        id: c.id,
        username: c.username,
        displayName: c.displayName,
        roles: c.roles,
        online: onlineById.get(c.id) === true,
        unreadCount: unreadBySender.get(c.id) || 0,
        lastMessageAt: last ? last.createdAt : null,
        lastMessagePreview: last ? last.body.slice(0, 120) : null,
      };
    });

    // Conversations first, most recent at the top; everyone else alphabetically
    // below them. The alphabetical-only order the query returns is fine on a
    // small property and useless on a big one: with thirty-odd staff, a message
    // from someone late in the alphabet lands thirty rows down, and the whole
    // point of this screen is that a new message is the thing you came to see.
    rows.sort((a, b) => {
      if (a.lastMessageAt && b.lastMessageAt) return new Date(b.lastMessageAt) - new Date(a.lastMessageAt);
      if (a.lastMessageAt) return -1;
      if (b.lastMessageAt) return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    res.json(rows);
  } catch (err) {
    console.error('[Messaging] Contacts error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/messages/unread-count — one number, for the sidebar badge.
//
// Separate from /contacts on purpose: the badge is rendered on every page and
// polls on a slow cadence, and making it carry the whole contact list would mean
// every page in the product pays for the Messages page's query.
router.get('/messages/unread-count', async (req, res) => {
  try {
    const total = await prisma.message.count({
      where: { recipientId: req.user.sub, readAt: null, ...(await retention.createdAtFilter()) },
    });
    res.json({ total });
  } catch (err) {
    console.error('[Messaging] Unread count error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/messages/with/:userId — one conversation, newest last.
//
// Opening a thread marks what the other person sent as read. That is deliberate
// and differs from the notification bell, where "mark read" is an explicit
// action: the bell has an Unread tab you can be reading FROM, so clearing it out
// from under the reader would lose their place. A chat thread has no such
// tension — displaying a message IS reading it.
router.get('/messages/with/:userId', async (req, res) => {
  try {
    const me = req.user.sub;
    const peer = req.params.userId;
    if (peer === me) return res.status(400).json({ error: 'Cannot open a conversation with yourself.' });

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { userLo, userHi } = pairOf(me, peer);

    // Newest-first for the LIMIT to take the recent end, reversed for display.
    const rows = await prisma.message.findMany({
      where: { userLo, userHi, ...(await retention.createdAtFilter()) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse();

    await prisma.message.updateMany({
      where: { recipientId: me, senderId: peer, readAt: null },
      data: { readAt: new Date() },
    });

    res.json({ messages, hasMore });
  } catch (err) {
    console.error('[Messaging] Thread error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/messages
router.post('/messages', async (req, res) => {
  try {
    const me = req.user.sub;
    const { recipientId, body } = req.body || {};

    if (!recipientId || typeof body !== 'string') {
      return res.status(400).json({ error: 'recipientId and body are required.' });
    }
    const text = body.trim();
    if (!text) return res.status(400).json({ error: 'Message cannot be empty.' });
    if (text.length > MAX_BODY) {
      return res.status(400).json({ error: `Message cannot exceed ${MAX_BODY} characters.` });
    }
    if (recipientId === me) return res.status(400).json({ error: 'Cannot message yourself.' });

    // Moderation, enforced HERE rather than in the browser. A client-side check
    // is a courtesy to the person typing; this is the one that holds, because
    // the endpoint is reachable without the page. See moderation/profanity.js
    // for why this blocks the send instead of masking the words.
    const verdict = profanity.check(text);
    if (!verdict.clean) {
      // Log the rule, never the message — a moderation log that quotes what was
      // refused just relocates the problem into a file more people can read.
      console.warn(`[Messaging] Blocked a message from ${me} (matched: ${verdict.matches.join(', ')}).`);
      return res.status(400).json({
        // `code` so the composer can show this inline and keep the draft, rather
        // than flashing it as one more transient toast the sender may miss.
        code: 'PROFANITY',
        error: 'That message contains language this system does not allow. Please reword it and try again.',
      });
    }

    const recipient = await prisma.userCache.findUnique({ where: { id: recipientId } });
    if (!recipient || recipient.status !== 'ACTIVE') {
      return res.status(404).json({ error: 'Recipient not found.' });
    }

    const message = await prisma.message.create({
      data: { senderId: me, recipientId, ...pairOf(me, recipientId), body: text },
    });

    // Published for anything that wants to react (the SSE bus, a future push
    // notification). The browser does not depend on this — it polls — so a
    // failed publish must not fail the send.
    redis
      .publish('messaging:message_sent', JSON.stringify({ messageId: message.id, senderId: me, recipientId }))
      .catch(() => {});

    res.status(201).json(message);
  } catch (err) {
    console.error('[Messaging] Send error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/messages/presence/ping — "I still have the app open."
//
// The caller is always req.user.sub and never a body parameter, so this cannot
// be used to make someone else look online.
router.post('/messages/presence/ping', async (req, res) => {
  try {
    await redis.set(presenceKey(req.user.sub), '1', 'EX', PRESENCE_TTL_SEC);
    res.json({ online: true, expiresInSec: PRESENCE_TTL_SEC });
  } catch (err) {
    // A missed heartbeat shows the user as offline to others in about a minute.
    // Nothing else breaks, so report success-with-degradation rather than 500
    // into the browser console every 25 seconds while Redis is down.
    console.error('[Messaging] Presence ping failed:', err.message);
    res.json({ online: false, expiresInSec: PRESENCE_TTL_SEC });
  }
});

module.exports = router;
