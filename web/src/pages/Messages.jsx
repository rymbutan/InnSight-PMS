import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import RoleBadge from '../components/RoleBadge';
import Transcript from '../components/Transcript';
import { primaryRole } from '../lib/roles';
import { useMessageSound } from '../lib/sound';
import { groupMessages, initialsOf, previewOf } from '../lib/messageGroups';
import { useContacts, useConversation, useRetentionPolicy } from '../lib/useMessaging';

// Staff direct messages, full-screen.
//
// The polling, the send path and the transcript grouping all moved out of this
// file: lib/useMessaging.js and lib/messageGroups.js, shared with the docked
// chat windows in components/ChatDock.jsx. There are two surfaces onto one
// conversation now, and the parts that must not disagree between them — where a
// day starts, what counts as one person's turn, what happens when the server
// refuses a message — belong in one place. What is left here is this page's own
// layout.

export default function Messages() {
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState('');
  const [soundOn, setSoundOn] = useMessageSound();
  const taRef = useRef(null);

  // ?peer=<id> is how the notification bell, the pop-up cards and the chat
  // dock's "open in Messages" button all hand a conversation to this page.
  //
  // Reading it is new. lib/notifications.js has been generating
  // `/messages?peer=<senderId>` links since messaging shipped and this page
  // never looked at the query string, so every one of those links landed on the
  // Messages page with NO conversation open — the reader arrived at a contact
  // list and had to find the person who had just messaged them.
  const peerId = params.get('peer');

  const { contacts, loading: loadingContacts, error: contactsError } = useContacts();
  const { messages, sending, blocked, clearBlocked, send, scrollRef } = useConversation(peerId, user?.id);
  const retention = useRetentionPolicy();

  // Only the FIRST contact-list failure is worth a toast. One every four
  // seconds while the service is down would bury the screen it is complaining
  // about.
  const toldAboutError = useRef(false);
  useEffect(() => {
    if (contactsError && !toldAboutError.current) {
      toldAboutError.current = true;
      toast.error(errMsg(contactsError));
    }
    if (!contactsError) toldAboutError.current = false;
  }, [contactsError, toast]);

  const peer = useMemo(() => contacts.find((c) => c.id === peerId) || null, [contacts, peerId]);
  const rows = useMemo(() => groupMessages(messages, user?.id), [messages, user?.id]);

  const visibleContacts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) => (c.displayName || '').toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q)
    );
  }, [contacts, filter]);

  // Staff are told how long what they type will last. A retention rule nobody
  // can see is one people only discover by losing something.
  const policyNote = useMemo(() => {
    if (!retention || retention.mode === 'never') return null;
    if (retention.mode === 'logout') return 'Cleared when you sign out';
    return retention.label.replace(/^Clear\b/, 'Cleared');
  }, [retention]);

  // Switching conversation empties the box rather than carrying a half-written
  // line to the next person — which is how a draft gets sent to the wrong one.
  useEffect(() => {
    setDraft('');
  }, [peerId]);

  // Grow the composer with its content up to a few lines, then scroll inside
  // it. The old fixed two-row box wasted half its height on a one-word reply
  // and hid the beginning of a long one.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft, peerId]);

  function openPeer(id) {
    // `replace` so the back button leaves the Messages page rather than walking
    // back through every conversation opened while here.
    setParams(id ? { peer: id } : {}, { replace: true });
  }

  async function submit(e) {
    e?.preventDefault?.();
    const body = draft.trim();
    if (!body) return;
    const res = await send(body);
    if (res.ok) setDraft('');
    // A refusal leaves the draft alone on purpose — the sender edits the part
    // that offended instead of retyping the part that was fine. `blocked` from
    // the hook renders the notice.
    else if (res.error) toast.error(errMsg(res.error));
  }

  // Enter sends, Shift+Enter breaks the line — the convention every chat client
  // shares, and the reason the composer is a textarea rather than an input.
  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="msg-page">
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
        {/* ── Staff list ── */}
        <aside className="msg-contacts">
          <div className="msg-search">
            <Icon name="search" size={15} strokeWidth={1.9} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search staff"
              aria-label="Search staff"
            />
            {filter && (
              <button
                type="button"
                className="msg-search-clear"
                onClick={() => setFilter('')}
                aria-label="Clear search"
              >
                <Icon name="x" size={13} strokeWidth={2.2} />
              </button>
            )}
          </div>

          <div className="msg-contact-list">
            {loadingContacts && contacts.length === 0 && <p className="msg-note muted">Loading…</p>}

            {!loadingContacts && contacts.length === 0 && (
              <p className="msg-note muted">No other staff accounts yet.</p>
            )}

            {contacts.length > 0 && visibleContacts.length === 0 && (
              <p className="msg-note muted">No one matches “{filter}”.</p>
            )}

            {visibleContacts.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`msg-contact${c.id === peerId ? ' active' : ''}`}
                onClick={() => openPeer(c.id)}
                aria-current={c.id === peerId ? 'true' : undefined}
              >
                <span className="msg-avatar" aria-hidden="true">
                  {initialsOf(c.displayName)}
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
                    {c.lastMessagePreview ? (
                      previewOf(c.lastMessagePreview, 46)
                    ) : (
                      <RoleBadge code={primaryRole(c.roles)} />
                    )}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        {/* ── Conversation ── */}
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
                <span className="msg-avatar" aria-hidden="true">
                  {initialsOf(peer.displayName)}
                  <span className={`msg-dot${peer.online ? ' is-online' : ''}`} />
                </span>
                <div className="msg-thread-id">
                  <div className="msg-thread-name">{peer.displayName}</div>
                  <div className="msg-thread-sub">
                    <RoleBadge code={primaryRole(peer.roles)} />
                    <span className={`msg-presence${peer.online ? ' is-online' : ''}`}>
                      {peer.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                </div>
              </header>

              <div className="msg-scroll" ref={scrollRef}>
                {rows.length === 0 ? (
                  <p className="msg-note muted">
                    No messages yet — say hello to {peer.displayName.split(' ')[0]}.
                  </p>
                ) : (
                  <Transcript rows={rows} />
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

              <form className="msg-composer" onSubmit={submit}>
                <div className={`msg-composer-field${blocked ? ' is-blocked' : ''}`}>
                  <textarea
                    ref={taRef}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      // Clear the warning as soon as they start rewriting,
                      // rather than leaving it up to accuse text that no longer
                      // exists.
                      if (blocked) clearBlocked();
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={`Message ${peer.displayName.split(' ')[0]}…`}
                    rows={1}
                    maxLength={4000}
                    aria-label={`Message ${peer.displayName}`}
                  />
                </div>
                <button
                  type="submit"
                  className="msg-send"
                  disabled={!draft.trim() || sending}
                  aria-label="Send message"
                  title="Send  ·  Shift+Enter for a new line"
                >
                  <Icon name="send" size={16} strokeWidth={2} />
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
