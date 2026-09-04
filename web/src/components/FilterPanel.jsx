import { useState } from 'react';
import Icon from './Icon';

// Cloudbeds-style collapsible filter panel.
// Children render the filter inputs in a responsive grid.
//
// Open state is uncontrolled by default (`defaultOpen`), which is how the folio
// tab uses it. Pass `open` + `onOpenChange` to drive it from outside — that is
// what lets the Reservations header own the trigger. With `hideHeader` the
// panel drops its own toggle row entirely and renders nothing while closed, so
// a caller supplying its own trigger does not get two of them, nor an empty
// bordered strip sitting under the title.
export default function FilterPanel({
  children,
  defaultOpen = true,
  onApply,
  onClear,
  applying,
  open: openProp,
  onOpenChange,
  hideHeader = false,
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const setOpen = (next) => (controlled ? onOpenChange?.(next) : setOpenState(next));

  if (hideHeader && !open) return null;

  return (
    <div className={`filter-panel${hideHeader ? ' is-headless' : ''}`}>
      {!hideHeader && (
        <button type="button" className="filter-header" onClick={() => setOpen(!open)}>
          <Icon
            name={open ? 'chevron-down' : 'chevron-right'}
            size={14}
            color="var(--muted)"
            className="filter-caret"
          />
          <Icon name="filter" size={14} color="var(--muted)" />
          <span>Filter</span>
        </button>
      )}
      {open && (
        <div className="filter-body">
          <div className="filter-grid">{children}</div>
          {(onApply || onClear) && (
            <div className="filter-actions">
              {onClear && (
                <button type="button" className="btn-ghost" onClick={onClear}>
                  CLEAR
                </button>
              )}
              {onApply && (
                <button type="button" className="btn-primary" onClick={onApply} disabled={applying}>
                  {applying ? '…' : 'APPLY'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The header trigger: filter icon, the word, and a caret that flips with the
// panel. No capsule and no chrome — it borrows the switcher's type size and
// weight so it sits at the same visual level beside a page title, but it draws
// no box of its own.
export function FilterPill({ open, onClick, label = 'Filter' }) {
  // No wrapper element. The capsule is gone, so a container around a single
  // button would only be a box with nothing left to draw.
  //
  // The class is unconditional, never `undefined` at rest: a bare <button>
  // matches the global `button:not([class])` rule further down styles.css,
  // which wins the specificity tie on source order and would paint this a solid
  // accent button.
  return (
    <button
      type="button"
      className={`filter-trigger${open ? ' is-open' : ''}`}
      onClick={onClick}
      aria-expanded={open}
    >
      <Icon name="filter" size={13} strokeWidth={2} />
      {label}
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} strokeWidth={2} />
    </button>
  );
}

export function FilterField({ label, children }) {
  return (
    <div className="filter-field">
      <label>{label}</label>
      {children}
    </div>
  );
}
