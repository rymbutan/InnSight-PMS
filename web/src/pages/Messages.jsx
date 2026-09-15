import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import RoleBadge from '../components/RoleBadge';
import { primaryRole } from '../lib/roles';
import { playMessageChime, useMessageSound } from '../lib/sound';

// Staff direct messages.
//
// Polling rather than SSE, which is what the rest of the product uses for live
// data. The SSE bus (lib/useLiveEvents.js) carries business events to every
// signed-in browser; a conversation is addressed to one person, so putting it on
// a broadcast channel would mean every browser receiving every message and
// filtering out the ones that are not theirs. Two intervals are cheaper and
// leak nothing.
//
// The two cadences differ on purpose: an open thread is being watched and polls
// fast, the contact list is peripheral and polls slower.
const THREAD_POLL_MS = 3000;
const CONTACTS_POLL_MS = 4000;

function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Clock time for a message in today's conversation, date for anything older —
// "14:05" is useless on a message from last week and a full date is noise on one
// from a minute ago.
function stamp(iso) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay =
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Messages() {
  const { user } = useAuth();
  const toast = useToast();
  const [contacts, setContacts] = useState([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [peerId, setPeerId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [filter, setFilter] = useState('');
  const [retention, setRetention] = useState(null);
  // Set when the server refuses a message on moderation grounds. Kept as state
  // rather than raised as a toast because the sender has to act on it: the toast
  // would fade while the rejected draft sat there looking sent.
  const [blocked, setBlocked] = useState(false);
  const [soundOn, setSoundOn] = useMessageSound();

  const scrollRef = useRef(null);
  // Whether the thread was pinned to the bottom before the latest poll landed.
  // Re-scrolling unconditionally would yank someone out of older messages they
  // scrolled up to read, every three seconds.
  const wasAtBottom = useRef(true);
  // The last message id this thread has already shown. `null` means the thread
  // has not loaded yet — opening a conversation with unread replies in it must
  // not chime, because nothing arrived, we just looked.
  const lastSeenId = useRef(null);

  const peer = useMemo(() => contacts.find((c) => c.id === peerId) || null, [contacts, peerId]);

  const visibleContacts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) => c.displayName.toLowerCase().includes(q) || c.username.toLowerCase().includes(q)
    );
  }, [contacts, filter]);

  // Staff are told how long what they type will last. A retention rule nobody
  // can see is one people only discover by losing something.
  const policyNote = useMemo(() => {
    if (!retention || retention.mode === 'never') return null;
    if (retention.mode === 'logout') return 'Cleared when you sign out';
    return retention.label.replace(/^Clear\b/, 'Cleared');
  }, [retention]);

  // ── Retention policy ────────────────────────────────────────────────────
  // Read once. It is hotel configuration that changes on the order of never, so
  // polling it alongside the conversation would be pure noise.
  useEffect(() => {
    api
      .get('/api/messages/settings/retention')
      .then(({ data }) => setRetention(data))
      .catch(() => {
        /* the notice is informational; the server enforces the policy either way */
      });
  }, []);

  // ── Contact list ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data } = await api.get('/api/messages/contacts');
        if (!cancelled) setContacts(Array.isArray(data) ? data : []);
      } catch (e) {
        // Only surface the first failure. A toast every 4s while the service is
        // down would bury the screen it is complaining about.
        if (!cancelled && loadingContacts) toast.error(errMsg(e));
      } finally {
        if (!cancelled) setLoadingContacts(false);
      }
    }
    load();
    const t = setInterval(load, CONTACTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // ── Open conversation ───────────────────────────────────────────────────
  useEffect(() => {
    if (!peerId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    // A different conversation: nothing in it has been "seen" yet.
    lastSeenId.current = null;
    async function load() {
      const el = scrollRef.current;
      if (el) wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      try {
        const { data } = await api.get(`/api/messages/with/${peerId}`);
        if (cancelled) return;
        const list = data?.messages || [];
        const newest = list[list.length - 1];
        // Ring only for a message from the OTHER person that this thread has not
        // shown before. Opening the thread sets the marker without ringing, and
        // your own sends are yours — you know they happened.
        if (newest && lastSeenId.current !== null && newest.id !== lastSeenId.current) {
          if (newest.senderId !== user?.id) playMessageChime();
        }
        lastSeenId.current = newest ? newest.id : null;
        setMessages(list);
      } catch {
        /* transient — the next tick retries, and the thread stays as it was */
      }
    }
    load();
    const t = setInterval(load, THREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [peerId, user?.id]);

  // Stick to the newest message unless the reader has scrolled away from it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && wasAtBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !peerId || sending) return;
    setSending(true);
    try {
      const { data } = await api.post('/api/messages', { recipientId: peerId, body });
      // Append rather than waiting for the next poll: up to 3s of the message
      // not appearing would read as the send having failed.
      setMessages((m) => [...m, data]);
      lastSeenId.current = data.id;
      wasAtBottom.current = true;
      setDraft('');
      setBlocked(false);
    } catch (err) {
      if (err?.response?.data?.code === 'PROFANITY') {
        // Leave the draft in the box — the sender has to edit it, and clearing
        // it would make them retype the part that was fine.
        setBlocked(true);
      } else {
        toast.error(errMsg(err));
      }
    } finally {
      setSending(false);
    }
  }

  // Enter sends, Shift+Enter breaks the line — the convention every chat client
  // shares, and the reason the composer is a textarea rather than an input.
  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(e);
    }
  }

  return (
    <div>
      <div className="msg-head">
        <h2>Messages</h2>
        <div className="msg-head-tools">
          {policyNote && (
            <span className="msg-policy" title={retention?.detail || undefined}>
              <Icon name="info" size={13} strokeWidth={1.9} />
              {policyNote}
            </span>
          )}
          <button
            type="button"
            className="msg-sound-toggle"
            onClick={() => setSoundOn(!soundOn)}
            aria-pressed={soundOn}
            title={
              soundOn
                ? 'Notification sound is on for this device. Click to mute.'
                : 'Notification sound is muted on this device. Click to unmute.'
            }
          >
            <Icon name={soundOn ? 'bell' : 'bell-off'} size={15} strokeWidth={1.9} />
            {soundOn ? 'Sound on' : 'Sound off'}
          </button>
        </div>
      </div>

      <div className="msg-wrap">
        {/* ── Contacts ── */}
        <aside className="msg-contacts">
          <div className="msg-search">
            <Icon name="search" size={15} strokeWidth={1.9} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search staff"
              aria-label="Search staff"
            />
          </div>

          <div className="msg-contact-list">
            {loadingContacts && contacts.length === 0 && <div className="muted msg-pad">Loading…</div>}

            {!loadingContacts && contacts.length === 0 && (
              <div className="muted msg-pad">No other staff accounts yet.</div>
            )}

            {contacts.length > 0 && visibleContacts.length === 0 && (
              <div className="muted msg-pad">No one matches “{filter}”.</div>
            )}

            {visibleContacts.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`msg-contact${c.id === peerId ? ' active' : ''}`}
                onClick={() => setPeerId(c.id)}
              >
                <span className="msg-avatar">
                  {initials(c.displayName)}
                  <span
                    className={`msg-dot${c.online ? ' is-online' : ''}`}
                    title={c.online ? 'Online' : 'Offline'}
                  />
                </span>
                <span className="msg-contact-text">
                  <span className="msg-contact-top">
                    <span className="msg-contact-name">{c.displayName}</span>
                    {c.unreadCount > 0 && <span className="msg-unread">{c.unreadCount}</span>}
                  </span>
                  <span className="msg-contact-sub">
                    {c.lastMessagePreview || <RoleBadge code={primaryRole(c.roles)} />}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        {/* ── Thread ── */}
        <section className="msg-thread">
          {!peer ? (
            <EmptyState
              kind="inbox"
              title="No conversation open"
              hint="Pick someone from the list to start messaging."
            />
          ) : (
            <>
              <header className="msg-thread-head">
                <span className="msg-avatar">
                  {initials(peer.displayName)}
                  <span className={`msg-dot${peer.online ? ' is-online' : ''}`} />
                </span>
                <div>
                  <div className="msg-thread-name">{peer.displayName}</div>
                  <div className="msg-thread-sub">
                    <RoleBadge code={primaryRole(peer.roles)} />
                    <span className="muted">{peer.online ? 'Online' : 'Offline'}</span>
                  </div>
                </div>
              </header>

              <div className="msg-scroll" ref={scrollRef}>
                {messages.length === 0 ? (
                  <div className="muted msg-pad">
                    No messages yet — say hello to {peer.displayName.split(' ')[0]}.
                  </div>
                ) : (
                  messages.map((m) => {
                    const mine = m.senderId === user?.id;
                    return (
                      <div key={m.id} className={`msg-row${mine ? ' mine' : ''}`}>
                        <div className="msg-bubble">
                          <div className="msg-body">{m.body}</div>
                          <div className="msg-time">{stamp(m.createdAt)}</div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {blocked && (
                <div className="msg-blocked" role="alert">
                  <Icon name="alert-circle" size={15} strokeWidth={1.9} />
                  <span>
                    That message contains language this system does not allow. Please reword it and send
                    again.
                  </span>
                </div>
              )}

              <form className="msg-composer" onSubmit={send}>
                <textarea
                  className={blocked ? 'is-blocked' : undefined}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    // Clear the warning as soon as they start rewriting, rather
                    // than leaving it up to accuse text that no longer exists.
                    if (blocked) setBlocked(false);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder={`Message ${peer.displayName}…`}
                  rows={2}
                  maxLength={4000}
                  aria-label={`Message ${peer.displayName}`}
                />
                <button type="submit" disabled={!draft.trim() || sending}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
