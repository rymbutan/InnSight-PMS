import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import Icon from './Icon';
import Modal from './Modal';
import RecordChip from './RecordChip';
import RoleBadge from './RoleBadge';
import { useToast, errMsg } from './Toast';
import { openChat } from './ChatDock';
import { primaryRole } from '../lib/roles';
import { initialsOf } from '../lib/messageGroups';
import { refPayload, resolveRef } from '../lib/recordRefs';
import { refreshContacts, useContacts } from '../lib/useMessaging';

// ─────────────────────────────────────────────────────────────────────────────
// "Send to a colleague" — share the record you are looking at.
//
// The other half of attaching a record from inside a conversation: here the
// RECORD is already open and the question is who to send it to. Pick a
// colleague, add a line if you want, send. The message lands in their thread
// as a chip that opens this record, and the conversation opens in the sender's
// dock so the reply arrives where they can see it without leaving the page.
//
// The reference is built by the page from the record it is already showing
// (lib/recordRefs.js reservationRef / folioRef / guestRef), which is why this
// dialog never has to look anything up — the page knows exactly what it has.
// ─────────────────────────────────────────────────────────────────────────────

export default function ShareRecordDialog({ open, onClose, record }) {
  const toast = useToast();
  // The contact list is the same single poller the dock and the Messages page
  // share; enabling it only while the dialog is open keeps a page with a Share
  // button from polling contacts for as long as it is on screen.
  const { contacts, loading } = useContacts({ enabled: open });
  const [filter, setFilter] = useState('');
  const [to, setTo] = useState(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  // A refusal the sender has to act on (moderation, or a record that vanished)
  // is shown in the dialog, not toasted — a toast fades while the dialog sits
  // there looking like it is still waiting to be sent.
  const [problem, setProblem] = useState('');

  const resolved = useMemo(() => resolveRef(record), [record]);

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setTo(null);
    setNote('');
    setProblem('');
  }, [open]);

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = q
      ? contacts.filter(
          (c) =>
            (c.displayName || '').toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q)
        )
      : contacts;
    // Online first, then alphabetically — a record you are sharing is usually
    // something you want acted on now, by someone who is here.
    return [...rows].sort(
      (a, b) =>
        Number(!!b.online) - Number(!!a.online) || (a.displayName || '').localeCompare(b.displayName || '')
    );
  }, [contacts, filter]);

  async function send() {
    if (!to || !resolved || sending) return;
    setSending(true);
    setProblem('');
    try {
      await api.post('/api/messages', { recipientId: to.id, body: note.trim(), ref: refPayload(resolved) });
      toast.success(`Sent to ${to.displayName}.`);
      // The row's preview and ordering are stale now; and the thread opens in
      // the dock so the reply comes to the sender rather than the sender going
      // to find it.
      refreshContacts();
      openChat(to.id);
      onClose?.();
    } catch (err) {
      const code = err?.response?.data?.code;
      if (code === 'PROFANITY') {
        setProblem('That note contains language this system does not allow. Please reword it.');
      } else if (code === 'REF_MISSING') {
        setProblem(err.response.data.error || 'That record no longer exists.');
      } else {
        toast.error(errMsg(err));
      }
    } finally {
      setSending(false);
    }
  }

  function onNoteKeyDown(e) {
    // Enter sends, Shift+Enter breaks the line — the convention the composers
    // already follow, so the note box does not behave differently from them.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!open || !resolved) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send to a colleague"
      width={480}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="button" className="btn-cta" onClick={send} disabled={!to || sending}>
            <Icon name="send" size={14} strokeWidth={2} />
            {sending ? 'Sending…' : to ? `Send to ${to.displayName.split(' ')[0]}` : 'Send'}
          </button>
        </>
      }
    >
      <RecordChip record={resolved} />

      <div className="rec-pick-search">
        <Icon name="search" size={14} strokeWidth={1.9} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search staff"
          aria-label="Search staff"
          autoFocus
        />
      </div>

      <div className="rec-pick-list share-list" role="listbox" aria-label="Colleagues">
        {loading && contacts.length === 0 && <p className="rec-pick-empty muted">Loading…</p>}
        {!loading && contacts.length === 0 && (
          <p className="rec-pick-empty muted">No other staff accounts yet.</p>
        )}
        {contacts.length > 0 && list.length === 0 && (
          <p className="rec-pick-empty muted">No one matches “{filter.trim()}”.</p>
        )}
        {list.map((c) => (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={to?.id === c.id}
            className={`rec-pick-row${to?.id === c.id ? ' is-on' : ''}`}
            onClick={() => setTo(c)}
          >
            <span className="chat-avatar share-avatar" aria-hidden="true">
              {initialsOf(c.displayName)}
              <span className={`chat-dot${c.online ? ' is-online' : ''}`} />
            </span>
            <span className="rec-chip-text">
              <span className="rec-chip-label">{c.displayName}</span>
              <span className="rec-chip-sub">
                <RoleBadge code={primaryRole(c.roles)} />
              </span>
            </span>
            {to?.id === c.id && <Icon name="check" size={15} strokeWidth={2.2} className="share-check" />}
          </button>
        ))}
      </div>

      <textarea
        className="share-note"
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          if (problem) setProblem('');
        }}
        onKeyDown={onNoteKeyDown}
        placeholder="Add a note (optional)"
        rows={2}
        maxLength={4000}
        aria-label="Note"
      />

      {problem && (
        <p className="share-problem" role="alert">
          <Icon name="alert-circle" size={14} strokeWidth={1.9} />
          {problem}
        </p>
      )}
    </Modal>
  );
}
