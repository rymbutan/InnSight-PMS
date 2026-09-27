import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import RoleBadge from './RoleBadge';
import { useAuth } from '../auth';
import { primaryRole } from '../lib/roles';
import Transcript from './Transcript';
import TypingIndicator from './TypingIndicator';
import RecordChip from './RecordChip';
import RecordPicker from './RecordPicker';
import { groupMessages, initialsOf, previewOf } from '../lib/messageGroups';
import { allowedRecordTypes } from '../lib/recordRefs';
import { useContacts, useConversation } from '../lib/useMessaging';
import { chatDockStoreKey } from '../lib/messageStorageKeys';

// ─────────────────────────────────────────────────────────────────────────────
// Docked chat windows, bottom-right — the Facebook-style chat bar.
//
// WHY THIS EXISTS ALONGSIDE THE MESSAGES PAGE
// -------------------------------------------
// /messages is a place you GO. It takes the whole screen, which means replying
// to a colleague costs you the arrivals list you were working through, and you
// have to navigate back. A docked window is the other half: the conversation
// comes to you and sits in the corner of whatever page you are on, so a
// housekeeper can answer the desk without losing their room list.
//
// Mounted once in Layout, so the windows survive navigation — that is the whole
// point. Routing between pages must not close a conversation mid-sentence.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
// The dock does not render on /messages. Two live views of one thread would
// double the poll rate against the gateway for a conversation the page is
// already showing at full size, and a floating copy of the thread you are
// already reading is just something in the way.
// ─────────────────────────────────────────────────────────────────────────────

// Three is what fits at 1280px beside a 264px rail without the windows
// overlapping the page's own content, and it is also about the number of
// conversations anyone actually holds at once. A fourth arrival pushes out the
// oldest MINIMISED window — never an open one, and never the one you just
// received a message in.
const MAX_WINDOWS = 3;
// Below this the windows are as wide as the screen, so only one can be shown.
const NARROW_PX = 700;

// Keyed PER USER, for the same reason lib/notifications.js keys its feed that
// way: a shared front-desk browser would otherwise restore the PREVIOUS user's
// open conversations for whoever signs in next, showing one person's contacts —
// and, on open, one person's threads — to another. The machines most likely to
// be shared are exactly the ones this runs on.
//
// Lives in lib/messageStorageKeys.js (not here) so auth.jsx's logout() can
// purge THIS user's entry without importing this component: being keyed per
// user stops it leaking to the NEXT signed-in account, but sign-out itself
// never removed it, so it sat in localStorage indefinitely after "Sign out".
const storeKey = chatDockStoreKey;

// The un-scoped key this used to write. Removed on mount so terminals that
// already have one stop handing it around; without this the leak survives the
// fix on every browser that was signed into before today.
const LEGACY_OPEN_KEY = 'innsight_chat_dock';

function readStoredWindows(userId) {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(userId)) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((w) => w && typeof w.peerId === 'string')
      .slice(0, MAX_WINDOWS)
      .map((w) => ({ peerId: w.peerId, minimized: true }));
  } catch {
    return [];
  }
}

// ── Imperative open, as a module-level channel ───────────────────────────────
// Layout receives the live `messaging:message_sent` event and needs to say
// "open a window for this sender". Threading a ref down through Layout's render
// would couple the two components for one call; a channel keeps ChatDock's
// internals its own. Buffered, because the event can land in the same tick as
// the dock mounting after a sign-in.
const listeners = new Set();
let pending = [];

/** Open (or un-minimise, and focus) the conversation with this person. */
export function openChat(peerId) {
  if (!peerId) return;
  if (listeners.size === 0) {
    // Nobody is listening yet — hold it rather than dropping the message the
    // user was told about. Capped so a burst while signed out cannot grow
    // without bound.
    pending = [...pending.filter((p) => p !== peerId), peerId].slice(-MAX_WINDOWS);
    return;
  }
  for (const fn of listeners) fn(peerId);
}

function useOpenChatChannel(onOpen) {
  useEffect(() => {
    listeners.add(onOpen);
    if (pending.length) {
      const queued = pending;
      pending = [];
      for (const id of queued) onOpen(id);
    }
    return () => listeners.delete(onOpen);
  }, [onOpen]);
}

function useIsNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < NARROW_PX);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NARROW_PX - 1}px)`);
    const on = (e) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export default function ChatDock({ suppressed = false }) {
  const { user, hasRole } = useAuth();
  const navigate = useNavigate();
  const narrow = useIsNarrow();
  // Which records this person may attach — the picker's tabs. Empty for a role
  // that can look nothing up, in which case the window shows no paperclip.
  const attachTypes = useMemo(() => allowedRecordTypes(hasRole), [hasRole]);
  // Restored from the last session, so a reload does not silently close the
  // conversations someone was holding. Minimised on restore whatever they were
  // before: reappearing as three open windows over the page after a refresh is
  // startling, and un-minimising is one click.
  const meId = user?.id || null;
  const [windows, setWindows] = useState(() => readStoredWindows(meId));
  // Which account `windows` currently belongs to. Signing out unmounts this
  // component today, so the common path is a fresh mount — but if that ever
  // stops being true, this stops one account's open windows being written into
  // another's key in the render between the id changing and the reload below.
  const owner = useRef(meId);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherFilter, setLauncherFilter] = useState('');
  const launcherRef = useRef(null);

  // The dock needs the contact list for names, presence and unread counts. It
  // is the same single poller the Messages page uses — see useMessaging.js.
  const { contacts } = useContacts({ enabled: !!user });

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_OPEN_KEY);
    } catch {
      /* nothing to clean up, or site data blocked */
    }
  }, []);

  useEffect(() => {
    if (owner.current === meId) return;
    owner.current = meId;
    setWindows(readStoredWindows(meId));
  }, [meId]);

  useEffect(() => {
    if (owner.current !== meId) return; // mid-switch; the reload above lands next
    try {
      localStorage.setItem(storeKey(meId), JSON.stringify(windows.map((w) => ({ peerId: w.peerId }))));
    } catch {
      /* private mode, or site data blocked — the dock works, it just will not
         be restored next time */
    }
  }, [windows, meId]);

  const open = useCallback(
    (peerId) => {
      setWindows((prev) => {
        const found = prev.find((w) => w.peerId === peerId);
        // Already there: make sure it is not minimised, and leave it where it
        // is. Re-ordering the bar under someone's pointer as they reply is how
        // you get a message sent to the wrong person.
        if (found) return prev.map((w) => (w.peerId === peerId ? { ...w, minimized: false } : w));

        const next = [{ peerId, minimized: false }, ...prev];
        if (next.length <= MAX_WINDOWS) return next;
        // Over the cap. Drop the OLDEST MINIMISED window; if every one is open,
        // drop the oldest of those. Either way never the new arrival.
        const victim =
          [...next].reverse().find((w) => w.minimized && w.peerId !== peerId) ||
          [...next].reverse().find((w) => w.peerId !== peerId);
        return next.filter((w) => w !== victim);
      });
      setLauncherOpen(false);
    },
    [setWindows]
  );

  useOpenChatChannel(open);

  const close = useCallback((peerId) => {
    setWindows((prev) => prev.filter((w) => w.peerId !== peerId));
  }, []);

  const toggleMinimized = useCallback((peerId) => {
    setWindows((prev) => prev.map((w) => (w.peerId === peerId ? { ...w, minimized: !w.minimized } : w)));
  }, []);

  // Close the launcher on an outside click, matching the topbar menus.
  useEffect(() => {
    if (!launcherOpen) return undefined;
    const onDown = (e) => {
      if (launcherRef.current && !launcherRef.current.contains(e.target)) setLauncherOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setLauncherOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [launcherOpen]);

  const byId = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const totalUnread = useMemo(() => contacts.reduce((s, c) => s + (c.unreadCount || 0), 0), [contacts]);

  const launcherList = useMemo(() => {
    const q = launcherFilter.trim().toLowerCase();
    const list = q
      ? contacts.filter(
          (c) =>
            (c.displayName || '').toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q)
        )
      : contacts;
    // Unread first, then whoever is online, then alphabetically — the order in
    // which you are likely to want them.
    return [...list].sort(
      (a, b) =>
        (b.unreadCount || 0) - (a.unreadCount || 0) ||
        Number(!!b.online) - Number(!!a.online) ||
        (a.displayName || '').localeCompare(b.displayName || '')
    );
  }, [contacts, launcherFilter]);

  // On a phone a window is nearly the full width, so only one can be EXPANDED.
  // The rest are force-collapsed to their header bars rather than dropped:
  // filtering them out would make a conversation someone had open silently
  // disappear on rotation, with no way to get it back but to be messaged again.
  const shown = useMemo(() => {
    if (!narrow) return windows;
    let expandedAlready = false;
    return windows.map((w) => {
      if (w.minimized) return w;
      if (expandedAlready) return { ...w, minimized: true };
      expandedAlready = true;
      return w;
    });
  }, [narrow, windows]);

  // Every hook above this line, unconditionally — the dock is suppressed on
  // /messages and renders nothing until somebody is signed in, and an early
  // return placed above a hook changes the hook order between renders.
  if (!user || suppressed) return null;

  return (
    <div className="chat-dock" role="complementary" aria-label="Chat">
      {shown.map((w) => {
        const peer = byId.get(w.peerId);
        return (
          <ChatWindow
            key={w.peerId}
            peerId={w.peerId}
            peer={peer}
            meId={user.id}
            minimized={w.minimized}
            unread={peer?.unreadCount || 0}
            attachTypes={attachTypes}
            onToggle={() => toggleMinimized(w.peerId)}
            onClose={() => close(w.peerId)}
            onExpandFull={() => {
              close(w.peerId);
              navigate(`/messages?peer=${w.peerId}`);
            }}
          />
        );
      })}

      {/* The launcher: start a conversation without leaving the page. Its badge
          counts everything unread, including threads with no window open. */}
      <div className="chat-launcher-wrap" ref={launcherRef}>
        {launcherOpen && (
          <div className="chat-launcher-pop" role="dialog" aria-label="Start a conversation">
            <div className="chat-launcher-head">
              <span>Chats</span>
              <button
                type="button"
                className="chat-icon-btn"
                onClick={() => {
                  // Closed explicitly, not left to the dock unmounting on
                  // /messages: the state would survive and the picker would be
                  // hanging open again the moment you navigated back.
                  setLauncherOpen(false);
                  navigate('/messages');
                }}
                title="Open the Messages page"
                aria-label="Open the Messages page"
              >
                <Icon name="maximize" size={14} strokeWidth={1.9} />
              </button>
            </div>
            <div className="chat-launcher-search">
              <Icon name="search" size={14} strokeWidth={1.9} />
              <input
                value={launcherFilter}
                onChange={(e) => setLauncherFilter(e.target.value)}
                placeholder="Search staff"
                aria-label="Search staff"
                autoFocus
              />
            </div>
            <div className="chat-launcher-list">
              {launcherList.length === 0 ? (
                <div className="chat-launcher-empty muted">
                  {contacts.length === 0 ? 'No other staff accounts yet.' : 'No one matches that.'}
                </div>
              ) : (
                launcherList.map((c) => (
                  <button key={c.id} type="button" className="chat-launcher-row" onClick={() => open(c.id)}>
                    <Avatar name={c.displayName} online={c.online} size={32} />
                    <span className="chat-launcher-text">
                      <span className="chat-launcher-name">{c.displayName}</span>
                      <span className="chat-launcher-sub">
                        {c.lastMessagePreview ? (
                          previewOf(c.lastMessagePreview, 38)
                        ) : (
                          <RoleBadge code={primaryRole(c.roles)} />
                        )}
                      </span>
                    </span>
                    {c.unreadCount > 0 && <span className="chat-pill">{c.unreadCount}</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        <button
          type="button"
          className={`chat-launcher-btn${launcherOpen ? ' is-open' : ''}`}
          onClick={() => setLauncherOpen((v) => !v)}
          aria-expanded={launcherOpen}
          aria-label={totalUnread > 0 ? `Chat — ${totalUnread} unread` : 'Chat'}
          title="Chat"
        >
          <Icon name="message-circle" size={18} strokeWidth={1.9} />
          <span className="chat-launcher-label">Chat</span>
          {totalUnread > 0 && <span className="chat-pill chat-pill-on-btn">{totalUnread}</span>}
        </button>
      </div>
    </div>
  );
}

function Avatar({ name, online, size = 34 }) {
  return (
    <span className="chat-avatar" style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {initialsOf(name)}
      <span className={`chat-dot${online ? ' is-online' : ''}`} title={online ? 'Online' : 'Offline'} />
    </span>
  );
}

function ChatWindow({ peerId, peer, meId, minimized, unread, attachTypes, onToggle, onClose, onExpandFull }) {
  const [draft, setDraft] = useState('');
  // A record waiting to go with the next message — see lib/recordRefs.js. It
  // sits above the text box as a removable chip until Send, and survives a
  // moderation refusal along with the draft.
  const [pending, setPending] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // A send failure the sender has to act on, other than moderation (which
  // `blocked` covers): the attached record no longer exists, or the request
  // itself failed. Shown inline for the same reason `blocked` is — a toast
  // fades while the unsent message sits there looking sent.
  const [problem, setProblem] = useState('');
  const taRef = useRef(null);
  // Minimised means NOT polling — see useConversation's `active`. A collapsed
  // window shows no transcript, so fetching one every three seconds is cost for
  // nothing; the header's unread count comes off the contact list.
  const { messages, sending, blocked, peerTyping, notifyTyping, clearBlocked, send, scrollRef } =
    useConversation(peerId, meId, { active: !minimized });

  const rows = useMemo(() => groupMessages(messages, meId), [messages, meId]);
  const name = peer?.displayName || 'Conversation';

  // Grow the composer with the text, up to a few lines, then scroll inside it.
  // A fixed two-row box wastes half the window on a one-word reply and hides
  // the start of a long one.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [draft, minimized]);

  // Opening a window puts the cursor in it — the reason you opened it is to type.
  useEffect(() => {
    if (!minimized) taRef.current?.focus();
  }, [minimized]);

  async function submit(e) {
    e?.preventDefault?.();
    const body = draft.trim();
    if (!body && !pending) return;
    notifyTyping(false);
    setProblem('');
    const res = await send(body, pending);
    // The draft survives a refusal on purpose: the sender has to edit the part
    // that offended, and clearing it would make them retype the part that was fine.
    if (res.ok) {
      setDraft('');
      setPending(null);
    } else if (res.error) {
      const data = res.error?.response?.data;
      if (data?.code === 'REF_MISSING') {
        // The record went away between picking it and sending. The chip is
        // dropped for them — re-sending the same dead reference cannot succeed.
        setPending(null);
        setProblem(data.error || 'That record no longer exists.');
      } else {
        setProblem(data?.error || res.error?.message || 'Could not send. Try again.');
      }
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    // Escape collapses rather than closes. Closing on Escape loses the draft,
    // and Escape is the key people hit to get a floating thing out of the way.
    if (e.key === 'Escape') {
      e.stopPropagation();
      onToggle();
    }
  }

  return (
    <section className={`chat-win${minimized ? ' is-min' : ''}`} aria-label={`Chat with ${name}`}>
      <header className="chat-win-head">
        {/* The whole header bar is the collapse control, which is the gesture
            this pattern has everywhere it appears. The buttons beside it stop
            the click so they do not also toggle. */}
        <button
          type="button"
          className="chat-win-title"
          onClick={onToggle}
          aria-expanded={!minimized}
          title={minimized ? `Open chat with ${name}` : 'Collapse'}
        >
          <Avatar name={peer?.displayName} online={peer?.online} size={28} />
          <span className="chat-win-name">{name}</span>
          {minimized && unread > 0 && <span className="chat-pill">{unread}</span>}
        </button>
        <div className="chat-win-tools">
          <button
            type="button"
            className="chat-icon-btn"
            onClick={onExpandFull}
            title="Open in the Messages page"
            aria-label="Open in the Messages page"
          >
            <Icon name="maximize" size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="chat-icon-btn"
            onClick={onToggle}
            title={minimized ? 'Expand' : 'Collapse'}
            aria-label={minimized ? 'Expand chat' : 'Collapse chat'}
          >
            <Icon name={minimized ? 'chevron-up' : 'minus'} size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="chat-icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close chat"
          >
            <Icon name="x" size={14} strokeWidth={2.2} />
          </button>
        </div>
      </header>

      {/* Hidden rather than unmounted while collapsed, so reopening does not
          replay the mount: no refetch, no scroll jump, and the draft the sender
          had half-typed is still there. */}
      <div className="chat-win-body" hidden={minimized}>
        <div className="chat-scroll" ref={scrollRef}>
          {rows.length === 0 ? (
            <p className="chat-empty muted">No messages yet — say hello to {name.split(' ')[0]}.</p>
          ) : (
            <Transcript rows={rows} />
          )}
          {/* Inside the scroller, after the transcript, so it appears under the
              last message and the existing stick-to-bottom carries it into view
              instead of it being hidden below the fold. */}
          {peerTyping && <TypingIndicator name={name.split(' ')[0]} />}
        </div>

        {blocked && (
          <p className="chat-blocked" role="alert">
            <Icon name="alert-circle" size={13} strokeWidth={1.9} />
            That wording is not allowed. Please reword it.
          </p>
        )}
        {problem && !blocked && (
          <p className="chat-blocked" role="alert">
            <Icon name="alert-circle" size={13} strokeWidth={1.9} />
            {problem}
          </p>
        )}

        {pending && (
          <div className="composer-attach">
            <RecordChip record={pending} onRemove={() => setPending(null)} />
          </div>
        )}

        <form className="chat-composer" onSubmit={submit}>
          {attachTypes.length > 0 && (
            <button
              type="button"
              className={`chat-attach-btn${pending ? ' is-on' : ''}`}
              onClick={() => setPickerOpen(true)}
              title="Attach a record"
              aria-label="Attach a reservation, folio or guest"
            >
              <Icon name="paperclip" size={15} strokeWidth={1.9} />
            </button>
          )}
          <textarea
            ref={taRef}
            className={blocked ? 'is-blocked' : undefined}
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              if (blocked) clearBlocked();
              if (problem) setProblem('');
              // Throttled inside the hook, so calling it per keystroke is fine.
              // Emptying the box sends the explicit stop rather than letting the
              // indicator hang on for the rest of its TTL.
              notifyTyping(next.trim().length > 0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Aa"
            rows={1}
            maxLength={4000}
            aria-label={`Message ${name}`}
          />
          <button
            type="submit"
            className="chat-send"
            disabled={(!draft.trim() && !pending) || sending}
            title="Send"
            aria-label="Send"
          >
            <Icon name="send" size={15} strokeWidth={2} />
          </button>
        </form>
      </div>

      <RecordPicker
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          taRef.current?.focus();
        }}
        onPick={setPending}
        types={attachTypes}
      />
    </section>
  );
}
