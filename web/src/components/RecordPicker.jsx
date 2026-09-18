import { useEffect, useRef, useState } from 'react';
import api from '../api';
import Icon from './Icon';
import Modal from './Modal';
import { errMsg } from './Toast';
import { RECORD_TYPES, refFromRow, resolveRef } from '../lib/recordRefs';

// ─────────────────────────────────────────────────────────────────────────────
// "Attach a record" — the picker behind the paperclip in both composers.
//
// One tab per record type the signed-in user may look up (the caller works
// that out from their roles — see lib/recordRefs.js allowedRecordTypes), a
// search box, and the matches as rows. Picking one hands a resolved reference
// back to the composer, which shows it as a pending chip above the text box
// until the message is sent.
//
// The search goes to the SAME endpoints the record pages themselves use, so
// "what can I find here" is exactly "what can I find on the Folios page". A
// dedicated search API for the picker would be a second definition of the
// same thing that drifts the first time one of them changes.
// ─────────────────────────────────────────────────────────────────────────────

// Long enough not to fire a request per keystroke, short enough to feel live —
// the figure the Guests and Folios pages settled on.
const DEBOUNCE_MS = 220;

export default function RecordPicker({ open, onClose, onPick, types = [] }) {
  const [tab, setTab] = useState(types[0] || null);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  // idle: nothing to show yet (a type that needs a term, before one is typed)
  // loading / done / forbidden / error
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const seq = useRef(0);
  const timer = useRef(null);
  const inputRef = useRef(null);

  // The tab list is derived per render by the caller; keyed on its contents so
  // a fresh array with the same types does not reset the dialog mid-search.
  const typesKey = types.join(',');

  // Opening starts clean. A picker that remembers last week's search for a
  // guest who has since checked out is not a shortcut, it is a wrong answer
  // waiting to be clicked.
  useEffect(() => {
    if (!open) return;
    setTab(types[0] || null);
    setQ('');
    setRows([]);
    setState('idle');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, typesKey]);

  useEffect(() => {
    if (!open || !tab) return undefined;
    const meta = RECORD_TYPES[tab];
    const term = q.trim();
    const url = meta.search(term);
    clearTimeout(timer.current);
    // A type that needs a term (reservations) shows its hint until it has one.
    if (!url) {
      setRows([]);
      setState('idle');
      return undefined;
    }
    setState('loading');
    // A blank term is the "recent" list and can go immediately; typing waits
    // for the pause. The monotonic `seq` drops a slow answer for "ann" that
    // lands after the fast one for "annie".
    timer.current = setTimeout(
      async () => {
        const mine = ++seq.current;
        try {
          const { data } = await api.get(url);
          if (mine !== seq.current) return;
          const list = (Array.isArray(data) ? data : [])
            .map((r) => resolveRef(refFromRow(tab, r)))
            .filter(Boolean);
          setRows(list);
          setState('done');
        } catch (err) {
          if (mine !== seq.current) return;
          if (err?.response?.status === 403) {
            setState('forbidden');
          } else {
            setError(errMsg(err));
            setState('error');
          }
        }
      },
      term ? DEBOUNCE_MS : 0
    );
    return () => clearTimeout(timer.current);
  }, [open, tab, q]);

  // The search box takes focus as the dialog opens and again on a tab change —
  // the reason you switched tabs is to type a different kind of thing.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, tab]);

  if (!open) return null;
  const meta = tab ? RECORD_TYPES[tab] : null;

  function pick(record) {
    onPick?.(record);
    onClose?.();
  }

  return (
    <Modal open={open} onClose={onClose} title="Attach a record" width={520}>
      {types.length > 1 && (
        <div className="seg rec-pick-tabs" role="tablist" aria-label="Record type">
          {types.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              className={t === tab ? 'is-on' : undefined}
              onClick={() => {
                setTab(t);
                setQ('');
              }}
            >
              <Icon name={RECORD_TYPES[t].icon} size={13} strokeWidth={1.9} />
              {RECORD_TYPES[t].label}
            </button>
          ))}
        </div>
      )}

      {meta && (
        <div className="rec-pick-search">
          <Icon name="search" size={14} strokeWidth={1.9} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={meta.searchHint}
            aria-label={`Search ${meta.noun}s`}
          />
          {q && (
            <button
              type="button"
              className="chat-icon-btn"
              onClick={() => setQ('')}
              aria-label="Clear search"
            >
              <Icon name="x" size={13} strokeWidth={2.2} />
            </button>
          )}
        </div>
      )}

      <div className="rec-pick-list" role="listbox" aria-label={meta ? `Matching ${meta.noun}s` : 'Matches'}>
        {!meta && <p className="rec-pick-empty muted">Your role cannot look up records.</p>}
        {meta && state === 'idle' && <p className="rec-pick-empty muted">{meta.searchHint}.</p>}
        {meta && state === 'loading' && rows.length === 0 && (
          <p className="rec-pick-empty muted">Searching…</p>
        )}
        {meta && state === 'forbidden' && (
          <p className="rec-pick-empty muted">Your role cannot look up {meta.noun}s.</p>
        )}
        {meta && state === 'error' && <p className="rec-pick-empty muted">{error}</p>}
        {meta && state === 'done' && rows.length === 0 && (
          <p className="rec-pick-empty muted">
            {q.trim() ? `No ${meta.noun} matches “${q.trim()}”.` : `No ${meta.noun}s yet.`}
          </p>
        )}
        {rows.map((r) => (
          <button
            key={`${r.type}-${r.id}`}
            type="button"
            role="option"
            aria-selected="false"
            className="rec-pick-row"
            onClick={() => pick(r)}
          >
            <span className="rec-chip-icon" aria-hidden="true">
              <Icon name={r.icon} size={15} strokeWidth={1.9} />
            </span>
            <span className="rec-chip-text">
              <span className="rec-chip-label">{r.label}</span>
              {r.sub && <span className="rec-chip-sub">{r.sub}</span>}
            </span>
            <Icon name="plus" size={14} strokeWidth={2} className="rec-chip-go" />
          </button>
        ))}
      </div>
    </Modal>
  );
}
