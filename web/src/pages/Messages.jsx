import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import RoleBadge from '../components/RoleBadge';
import Transcript from '../components/Transcript';
import TypingIndicator from '../components/TypingIndicator';
import RecordChip from '../components/RecordChip';
import RecordPicker from '../components/RecordPicker';
import { primaryRole } from '../lib/roles';
import { useMessageSound } from '../lib/sound';
import { avatarColorOf, groupMessages, initialsOf, previewOf } from '../lib/messageGroups';
import { allowedRecordTypes } from '../lib/recordRefs';
import { useContacts, useConversation, useRetentionPolicy } from '../lib/useMessaging';
import { openChat } from '../components/ChatDock';

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
  const { user, hasRole } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState('');
  // A record to go with the next message — a reservation, folio or guest,
  // shown as a removable chip above the box until Send. See lib/recordRefs.js.
  const [pending, setPending] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const attachTypes = useMemo(() => allowedRecordTypes(hasRole), [hasRole]);
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
  const { messages, sending, blocked, peerTyping, notifyTyping, clearBlocked, send, scrollRef } =
    useConversation(peerId, user?.id);
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

  // Two sections rather than one flat list — who is reachable right now is
  // worth seeing at a glance before you scroll past them looking for someone
  // who is not.
  const onlineContacts = useMemo(() => visibleContacts.filter((c) => c.online), [visibleContacts]);
  const offlineContacts = useMemo(() => visibleContacts.filter((c) => !c.online), [visibleContacts]);

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
    setPending(null);
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
    if (!body && !pending) return;
    notifyTyping(false);
    const res = await send(body, pending);
    if (res.ok) {
      setDraft('');
      setPending(null);
    } else if (res.error) {
      // A refusal leaves the draft alone on purpose — the sender edits the part
      // that offended instead of retyping the part that was fine. `blocked` from
      // the hook renders the notice.
      toast.error(errMsg(res.error));
      // Except a record that vanished between picking and sending: re-sending
      // the same dead reference cannot succeed, so the chip is dropped for them.
      if (res.error?.response?.data?.code === 'REF_MISSING') setPending(null);
    }
  }

  // Opening a record from a chip. Navigating away would close the conversation
  // the reader just clicked out of, so it is handed to the dock first — the
  // same move the "Open in dock" button makes — and follows them to the record.
  function openRecord(record) {
    if (peer) openChat(peer.id);
    navigate(record.path);
  }

  // Enter sends, Shift+Enter breaks the line — the convention every chat client
  // shares, and the reason the composer is a textarea rather than an input.
  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  // One row, shared by the online and offline sections, so the two cannot
  // render a contact differently.
  function renderContact(c) {
    return (
      <button
        key={c.id}
        type="button"
        className={`msg-contact${c.id === peerId ? ' active' : ''}`}
        onClick={() => openPeer(c.id)}
        aria-current={c.id === peerId ? 'true' : undefined}
      >
        <span
          className="msg-avatar"
          aria-hidden="true"
          style={{ background: avatarColorOf(c.id), borderColor: 'transparent', color: '#fff' }}
        >
          {initialsOf(c.displayName)}
          <span className={`msg-dot${c.online ? ' is-online' : ''}`} title={c.online ? 'Online' : 'Offline'} />
        </span>
        <span className="msg-contact-text">
          <span className="msg-contact-top">
            <span className="msg-contact-name">{c.displayName}</span>
            {c.unreadCount > 0 && <span className="msg-unread">{c.unreadCount}</span>}
          </span>
          <span className="msg-contact-sub">
            {c.lastMessagePreview ? previewOf(c.lastMessagePreview, 46) : <RoleBadge code={primaryRole(c.roles)} />}
          </span>
        </span>
      </button>
    );
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
            data-tour="g-messages-sound"
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
        <aside className="msg-contacts" data-tour="g-messages-contacts">
          <div className="msg-search" data-tour="g-messages-search">
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
            {loadingContacts && contacts.length === 0 && <SkeletonList rows={7} label="Loading staff" />}

            {!loadingContacts && contacts.length === 0 && (
              <p className="msg-note muted">No other staff accounts yet.</p>
            )}

            {contacts.length > 0 && visibleContacts.length === 0 && (
              <p className="msg-note muted">No one matches “{filter}”.</p>
            )}

            {/* Online first, offline after — two labelled sections instead of
                one flat list, so who is reachable right now doesn't get lost
                among everyone who isn't. Only a section with someone in it
                gets a label; a staff of six online and none offline should
                not print an empty "Offline" heading. */}
            {onlineContacts.length > 0 && (
              <div className="msg-contact-section">
                <span className="msg-contact-section-label">Online</span>
                {onlineContacts.map((c) => renderContact(c))}
              </div>
            )}
            {offlineContacts.length > 0 && (
              <div className="msg-contact-section">
                <span className="msg-contact-section-label">Offline</span>
                {offlineContacts.map((c) => renderContact(c))}
              </div>
            )}
          </div>
        </aside>

        {/* ── Conversation ── */}
        <section className="msg-thread" data-tour="g-messages-thread">
          {!peer ? (
            <EmptyState
              kind="inbox"
              title="No conversation open"
              hint="Pick someone from the list to start messaging."
            />
          ) : (
            <>
              <header className="msg-thread-head">
                <span
                  className="msg-avatar"
                  aria-hidden="true"
                  style={{ background: avatarColorOf(peer.id), borderColor: 'transparent', color: '#fff' }}
                >
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
                {/* Pops this conversation into the floating dock and leaves the
                    page. The dock deliberately does not render on /messages
                    (two live views of one thread), so staying here would open a
                    window nobody can see — leaving is the feature, not a side
                    effect: it is how you keep the thread while you go back to
                    work. Back rather than a fixed route, so you land where you
                    came from. */}
                <button
                  data-tour="g-messages-dock"
                  type="button"
                  className="btn-ghost msg-dock-btn"
                  title="Keep this conversation in a floating window while you work"
                  onClick={() => {
                    openChat(peer.id);
                    if (window.history.length > 1) navigate(-1);
                    else navigate('/');
                  }}
                >
                  <Icon name="minimize" size={14} strokeWidth={2} />
                  <span>Open in dock</span>
                </button>
              </header>

              <div className="msg-scroll" ref={scrollRef}>
                {rows.length === 0 ? (
                  <p className="msg-note muted">
                    No messages yet — say hello to {peer.displayName.split(' ')[0]}.
                  </p>
                ) : (
                  <Transcript rows={rows} onOpenRecord={openRecord} peerName={peer.displayName} />
                )}
                {peerTyping && <TypingIndicator name={peer.displayName.split(' ')[0]} />}
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

              {pending && (
                <div className="composer-attach">
                  <RecordChip record={pending} onRemove={() => setPending(null)} />
                </div>
              )}

              <form className="msg-composer" onSubmit={submit}>
                {attachTypes.length > 0 && (
                  <button
                    data-tour="g-messages-attach"
                    type="button"
                    className={`chat-attach-btn${pending ? ' is-on' : ''}`}
                    onClick={() => setPickerOpen(true)}
                    title="Attach a record"
                    aria-label="Attach a reservation, folio or guest"
                  >
                    <Icon name="paperclip" size={17} strokeWidth={1.9} />
                  </button>
                )}
                <div data-tour="g-messages-composer" className={`msg-composer-field${blocked ? ' is-blocked' : ''}`}>
                  <textarea
                    ref={taRef}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      notifyTyping(e.target.value.trim().length > 0);
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
                  disabled={(!draft.trim() && !pending) || sending}
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

      <RecordPicker
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          taRef.current?.focus();
        }}
        onPick={setPending}
        types={attachTypes}
      />
    </div>
  );
}
