import { useCallback, useEffect, useId, useRef, useState } from 'react';
import api from '../api';

// A search box that predicts as you type.
//
// Every search input in the app used to be submit-then-wait: type, press a
// button, read a table. This replaces that with suggestions while typing, and
// is written once so the behaviour is identical everywhere — the debounce, the
// stale-response guard, the keyboard model and the outside-click handling are
// easy to get subtly wrong per page.
//
// Props:
//   value / onChange   controlled text, so the page can still use it as a filter
//   endpoint(q)        -> request path; returning null/'' skips the request
//   mapItem(row)       -> { id, title, meta, avatar? } for rendering.
//                         `avatar` is an optional node drawn at the leading
//                         edge — pass the same <Avatar> the results table uses
//                         so a suggestion looks like the row it will become.
//   onPick(row)        selection handler; omit to use it as a plain filter box
//   onSubmit()         Enter with no suggestion highlighted
//   minChars           default 1
export default function Autocomplete({
  value,
  onChange,
  endpoint,
  mapItem,
  onPick,
  onSubmit,
  placeholder,
  minChars = 1,
  autoFocus,
  className = '',
}) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);
  const timer = useRef(null);
  // Monotonic request id. Without it a slow response for "ma" can land after a
  // fast one for "maria" and replace the newer suggestions with older ones.
  const seq = useRef(0);
  const listId = useId();

  useEffect(() => {
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const fetchSuggestions = useCallback(
    (q) => {
      clearTimeout(timer.current);
      if (!q || q.trim().length < minChars) {
        setItems([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      // 220ms: long enough that a fast typist does not fire a request per
      // keystroke, short enough to feel immediate.
      timer.current = setTimeout(async () => {
        const mine = ++seq.current;
        try {
          const path = endpoint(q.trim());
          if (!path) return;
          const { data } = await api.get(path);
          if (mine !== seq.current) return;
          setItems(Array.isArray(data) ? data.slice(0, 8) : []);
          setActive(-1);
          setOpen(true);
        } catch {
          if (mine !== seq.current) return;
          // A failed lookup should not pop an error toast on every keystroke;
          // showing no suggestions is the honest, quiet outcome.
          setItems([]);
        } finally {
          if (mine === seq.current) setLoading(false);
        }
      }, 220);
    },
    [endpoint, minChars]
  );

  function handleChange(v) {
    onChange(v);
    fetchSuggestions(v);
  }

  function choose(row) {
    setOpen(false);
    setActive(-1);
    onPick?.(row);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'Enter') {
      if (open && active >= 0 && items[active]) {
        e.preventDefault();
        choose(items[active]);
      } else if (onSubmit) {
        e.preventDefault();
        setOpen(false);
        onSubmit();
      }
      return;
    }
    if (!open || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    }
  }

  const showPanel = open && (loading || items.length > 0);

  return (
    <div className={`ac-wrap ${className}`} ref={wrapRef}>
      <input
        className="ac-input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => items.length && setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {showPanel && (
        <ul className="ac-pop" id={listId} role="listbox">
          {loading && items.length === 0 ? (
            <li className="ac-empty">Searching…</li>
          ) : (
            items.map((row, i) => {
              const m = mapItem(row);
              return (
                <li key={m.id ?? i}>
                  <button
                    type="button"
                    className={`ac-item${i === active ? ' is-active' : ''}`}
                    role="option"
                    aria-selected={i === active}
                    // mousedown, not click: the input's blur would close the
                    // panel before a click ever landed.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(row);
                    }}
                    onMouseEnter={() => setActive(i)}
                  >
                    {m.avatar ? <span className="ac-item-avatar">{m.avatar}</span> : null}
                    <span className="ac-item-title">{m.title}</span>
                    {m.meta ? <span className="ac-item-meta">{m.meta}</span> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
