const express = require('express');
const Redis = require('ioredis');

const router = express.Router();
const prisma = require('../lib/prisma');
const retention = require('../retention/policy');
const profanity = require('../moderation/profanity');
const { normalizeRef, refColumns, messagePreview } = require('../lib/recordRef');
const { recordExists } = require('../lib/recordLookup');
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

// "Someone is typing to you right now." DIRECTED, unlike presence: the key names
// both ends, so typing to one colleague never shows you as typing to another.
//
// Redis rather than a column, for the same reason presence is: this is worth
// nothing a few seconds from now, and writing a row per keystroke-burst to
// Postgres would be the heaviest write in the service for the most disposable
// fact in it. The TTL is the whole expiry mechanism — nothing has to clean up
// after a browser that was closed mid-sentence.
//
// 6s against the client's 2.5s repeat (web/src/lib/useMessaging.js) tolerates one
// dropped request without the indicator flickering, and means it fades about two
// thread polls after someone stops.
const TYPING_TTL_SEC = 6;
const typingKey = (from, to) => `typing:${from}:${to}`;

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
      select: {
        senderId: true,
        recipientId: true,
        body: true,
        refType: true,
        refLabel: true,
        createdAt: true,
      },
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
        // The body, or "Shared folio: …" for a message that is only an
        // attachment — otherwise a row whose last message was a record would
        // preview as blank, which reads as nothing having been sent.
        lastMessagePreview: last ? messagePreview(last, 120) : null,
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

    // Piggy-backed on the thread poll rather than given its own interval: this
    // is already fetched every 3s while a conversation is open, and a second
    // timer would double the request rate for one boolean.
    let peerTyping = false;
    try {
      peerTyping = (await redis.exists(typingKey(peer, me))) === 1;
    } catch {
      /* Redis down — the transcript still loads, the indicator just never shows */
    }

    res.json({ messages, hasMore, peerTyping });
  } catch (err) {
    console.error('[Messaging] Thread error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/messages
router.post('/messages', async (req, res) => {
  try {
    const me = req.user.sub;
    const { recipientId, body, ref: rawRef } = req.body || {};

    // `body` may be omitted when the message is only an attachment; anything
    // present has to be a string.
    if (!recipientId || (body != null && typeof body !== 'string')) {
      return res.status(400).json({ error: 'recipientId and body are required.' });
    }
    // The optional record reference — a reservation, folio or guest the
    // recipient can open from the chip. Shape-checked here; whether the record
    // exists is asked of its owning service below, after the cheap checks.
    const normalized = normalizeRef(rawRef);
    if (!normalized.ok) return res.status(400).json({ error: normalized.error });
    const ref = normalized.ref;

    const text = (body || '').trim();
    if (!text && !ref) return res.status(400).json({ error: 'Message cannot be empty.' });
    if (text.length > MAX_BODY) {
      return res.status(400).json({ error: `Message cannot exceed ${MAX_BODY} characters.` });
    }
    if (recipientId === me) return res.status(400).json({ error: 'Cannot message yourself.' });

    // Moderation, enforced HERE rather than in the browser. A client-side check
    // is a courtesy to the person typing; this is the one that holds, because
    // the endpoint is reachable without the page. See moderation/profanity.js
    // for why this blocks the send instead of masking the words.
    //
    // The chip's label and sub-line are checked too. They are copied from a
    // record in the normal case, but the endpoint does not know that — a label
    // is just another string a caller chose, and it is rendered in the thread.
    const verdict = profanity.check([text, ref?.label, ref?.sub].filter(Boolean).join('\n'));
    if (!verdict.clean) {
      // Log the rule, never the message — a moderation log that quotes what was
      // refused just relocates the problem into a file more people can read.
      console.warn(`[Messaging] Blocked a message from ${me} (matched: ${verdict.matches.join(', ')}).`);
      return res.status(400).json({
        // `code` so the composer can show this inline and keep the draft, rather
        // than flashing it as one more transient toast the sender may miss.
        code: 'PROFANITY',
        // The second sentence exists because the filter now blocks sexual
        // propositions, and the words in a proposition are the same words
        // somebody uses to REPORT one. Refusing that report with nothing but
        // "reword it" leaves the person who most needs to be heard guessing at
        // what the machine will accept, so the refusal says which way out
        // works: describe it rather than quote it.
        error:
          'That message contains language this system does not allow. Please reword it and try again. ' +
          'If you are reporting something that was said to you, describe what happened rather than ' +
          'quoting it, and tell your supervisor.',
      });
    }

    const recipient = await prisma.userCache.findUnique({ where: { id: recipientId } });
    if (!recipient || recipient.status !== 'ACTIVE') {
      return res.status(404).json({ error: 'Recipient not found.' });
    }

    // Last, because it is the one check that leaves this service. A definite
    // 404 refuses the send — a chip that opens onto "not found" is worse than
    // no chip. An unreachable or slow owner lets it through; see
    // lib/recordLookup.js for why that is the right way round.
    if (ref && (await recordExists(ref)) === 'missing') {
      return res.status(400).json({
        code: 'REF_MISSING',
        error: 'That record no longer exists. Remove the attachment and try again.',
      });
    }

    const message = await prisma.message.create({
      data: { senderId: me, recipientId, ...pairOf(me, recipientId), body: text, ...refColumns(ref) },
    });

    // Carries enough to RENDER the notification, not just to trigger a refetch.
    // The SSE fan-out in services/inventory treats this channel as DIRECTED (the
    // same mechanism the housekeeping call uses), so the only browser that ever
    // receives this frame is the recipient's — which is what makes it safe to
    // put the sender's name and a preview of the body on the bus at all.
    //
    // The preview is short on purpose: a notification is a nudge to go and read
    // the thread, and the full body has no business sitting in a toast on a
    // shared front-desk screen.
    const senderName = (await prisma.userCache.findUnique({ where: { id: me } }).catch(() => null))
      ?.displayName;
    redis
      .publish(
        'messaging:message_sent',
        JSON.stringify({
          messageId: message.id,
          senderId: me,
          senderName: senderName || 'A colleague',
          recipientId,
          preview: messagePreview(message, 90),
          createdAt: message.createdAt,
        })
      )
      .catch(() => {});

    // The message IS the end of typing. Without this the recipient keeps seeing
    // "typing…" underneath the message that just arrived, for the rest of the
    // TTL — which reads as a second message coming that never does.
    redis.del(typingKey(me, recipientId)).catch(() => {});

    res.status(201).json(message);
  } catch (err) {
    console.error('[Messaging] Send error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/messages/typing — "I am writing to this person right now."
//
// The sender is always req.user.sub and never a body parameter, so this cannot
// be used to make someone else appear to be typing.
router.post('/messages/typing', async (req, res) => {
  // Not an activity-log entry, for the same reason the presence ping is not:
  // the browser repeats this every 2.5 seconds for as long as someone is
  // writing a sentence. See services/_shared/activityLog.js.
  res.locals.activity = false;
  try {
    const me = req.user.sub;
    const { recipientId, typing = true } = req.body || {};
    if (!recipientId || typeof recipientId !== 'string') {
      return res.status(400).json({ error: 'recipientId is required.' });
    }
    if (recipientId === me) return res.status(400).json({ error: 'Cannot type to yourself.' });

    // `typing: false` is the explicit stop — sent when the box is cleared or the
    // message goes. Without it the indicator would hang on for the whole TTL
    // after someone deletes what they were writing, which reads as a message
    // that never arrives.
    if (typing) await redis.set(typingKey(me, recipientId), '1', 'EX', TYPING_TTL_SEC);
    else await redis.del(typingKey(me, recipientId));

    res.json({ ok: true, ttlSec: TYPING_TTL_SEC });
  } catch (err) {
    // Never 500 into a keystroke handler: a typing indicator is the least
    // important thing on the screen and must not surface an error over the
    // message someone is actually writing.
    console.error('[Messaging] Typing signal failed:', err.message);
    res.json({ ok: false });
  }
});

// POST /api/messages/presence/ping — "I still have the app open."
//
// The caller is always req.user.sub and never a body parameter, so this cannot
// be used to make someone else look online.
router.post('/messages/presence/ping', async (req, res) => {
  // Not an activity-log entry, and this is the one route where that has to be
  // said explicitly. The browser beats every 25 seconds for as long as the app
  // is open (web/src/components/Layout.jsx), so left alone this single endpoint
  // writes thousands of rows per signed-in user per day and buries every real
  // action in the admin's Activity Log. It is a liveness heartbeat, not
  // something a person did — the same reasoning that excludes /metrics in
  // lib/activityLog.js, which is also driven by a timer.
  //
  // `false` here rather than a path filter in the shared middleware: only this
  // route knows it is a heartbeat, and encoding one service's route paths into a
  // file vendored into all ten of them is how that file starts to drift.
  res.locals.activity = false;
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
