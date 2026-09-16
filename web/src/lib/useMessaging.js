import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api';

// ─────────────────────────────────────────────────────────────────────────────
// The messaging data layer, shared by the Messages page and the docked chat
// windows.
//
// It lives here because there are now TWO surfaces onto one conversation, and
// the polling is the part that must not be duplicated. Two copies of it would
// not merely be untidy — they would drift: a fix to the scroll-anchoring or the
// send path would land on one surface and not the other, and the same thread
// would behave differently depending on which window you had it open in.
//
// Polling rather than SSE, for the reason Messages.jsx already gave: the live
// bus is a broadcast, a conversation is addressed to one person, and putting
// threads on the bus would mean every browser receiving every message and
// filtering out what is not theirs. The live stream still drives the CHIME and
// the auto-open (Layout hands those the directed `messaging:message_sent`
// event); this is what fetches the transcript itself.
// ─────────────────────────────────────────────────────────────────────────────

// An open thread is being watched, so it polls fast. The contact list is
// peripheral. Both match what the page used before this was extracted.
export const THREAD_POLL_MS = 3000;
export const CONTACTS_POLL_MS = 4000;

/**
 * The staff list with presence and per-person unread counts.
 *
 * ONE poller, however many components ask for it. A module-level subscriber set
 * rather than a hook-local interval, because the dock and the page can be
 * mounted at the same time and a second interval would double the request rate
 * against the gateway for a list that is identical in both.
 */
let contactsState = { contacts: [], loading: true, error: null };
const contactSubs = new Set();
let contactTimer = null;

function publishContacts(next) {
  contactsState = next;
  for (const fn of contactSubs) fn(contactsState);
}

async function fetchContacts() {
  try {
    const { data } = await api.get('/api/messages/contacts');
    publishContacts({ contacts: Array.isArray(data) ? data : [], loading: false, error: null });
  } catch (e) {
    // Keep the last good list. A transient 502 must not blank the sidebar of
    // people you were about to message; the next tick retries.
    publishContacts({ ...contactsState, loading: false, error: e });
  }
}

/** Force a refresh now — used after sending, so the row's preview and ordering
 *  update without waiting out the poll interval. */
export function refreshContacts() {
  if (contactSubs.size > 0) fetchContacts();
}

export function useContacts({ enabled = true } = {}) {
  const [state, setState] = useState(contactsState);

  useEffect(() => {
    if (!enabled) return undefined;
    contactSubs.add(setState);
    // Hand the newcomer whatever is already known, so a second surface mounting
    // does not flash "Loading…" over a list this tab already has.
    setState(contactsState);
    if (contactSubs.size === 1) {
      fetchContacts();
      contactTimer = setInterval(fetchContacts, CONTACTS_POLL_MS);
    }
    return () => {
      contactSubs.delete(setState);
      if (contactSubs.size === 0 && contactTimer) {
        clearInterval(contactTimer);
        contactTimer = null;
      }
    };
  }, [enabled]);

  return state;
}

/**
 * One open conversation: its transcript, its send path, and the scroll
 * anchoring that keeps it readable while it polls.
 *
 * @param {string|null} peerId    who you are talking to; null loads nothing.
 * @param {string|null} meId      the signed-in user, for `mine` on each message.
 * @param {object}  opts
 * @param {boolean} opts.active   false pauses the poll entirely — what a
 *                                minimised chat window uses. A collapsed window
 *                                shows no transcript, so fetching one every
 *                                three seconds is pure cost; its unread count
 *                                comes off the contact list instead.
 */
export function useConversation(peerId, meId, { active = true } = {}) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  // Set when the server refuses a message on moderation grounds. State rather
  // than a toast because the sender has to act on it — a toast would fade while
  // the rejected draft sat there looking sent.
  const [blocked, setBlocked] = useState(false);

  const scrollRef = useRef(null);
  // Whether the thread was pinned to the bottom before the latest poll landed.
  // Re-scrolling unconditionally would yank someone out of older messages they
  // scrolled up to read, every three seconds.
  const wasAtBottom = useRef(true);

  useEffect(() => {
    if (!peerId || !active) {
      if (!peerId) setMessages([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    async function load() {
      const el = scrollRef.current;
      if (el) wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      try {
        const { data } = await api.get(`/api/messages/with/${peerId}`);
        if (cancelled) return;
        setMessages(data?.messages || []);
      } catch {
        /* transient — the next tick retries and the thread stays as it was */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, THREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [peerId, meId, active]);

  // Opening a thread starts at the newest message, not wherever the previous
  // conversation happened to be scrolled to.
  useEffect(() => {
    wasAtBottom.current = true;
    setBlocked(false);
  }, [peerId]);

  // Stick to the newest message unless the reader has scrolled away from it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && wasAtBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, active]);

  const send = useCallback(
    async (body) => {
      const text = String(body ?? '').trim();
      if (!text || !peerId || sending) return { ok: false };
      setSending(true);
      try {
        const { data } = await api.post('/api/messages', { recipientId: peerId, body: text });
        // Append rather than waiting for the next poll: up to 3s of the message
        // not appearing reads as the send having failed.
        setMessages((m) => [...m, data]);
        wasAtBottom.current = true;
        setBlocked(false);
        // The contact row's preview and its position in the list are now stale.
        refreshContacts();
        return { ok: true };
      } catch (err) {
        if (err?.response?.data?.code === 'PROFANITY') {
          setBlocked(true);
          // Not an `ok: false` with an error to toast — the caller must LEAVE
          // the draft in the box so the sender can edit the part that offended
          // rather than retyping the part that was fine.
          return { ok: false, blocked: true };
        }
        return { ok: false, error: err };
      } finally {
        setSending(false);
      }
    },
    [peerId, sending]
  );

  return {
    messages,
    loading,
    sending,
    blocked,
    clearBlocked: useCallback(() => setBlocked(false), []),
    send,
    scrollRef,
  };
}

/** The retention policy notice. Read once per mount and never polled: it is
 *  hotel configuration that changes on the order of never. */
export function useRetentionPolicy() {
  const [retention, setRetention] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/messages/settings/retention')
      .then(({ data }) => {
        if (!cancelled) setRetention(data);
      })
      .catch(() => {
        /* informational only; the server enforces the policy either way */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return retention;
}
