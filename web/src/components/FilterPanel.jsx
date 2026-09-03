import { useState } from 'react';
import Icon from './Icon';

// Cloudbeds-style collapsible filter panel.
// Children render the filter inputs in a responsive grid.
export default function FilterPanel({ children, defaultOpen = true, onApply, onClear, applying }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="filter-panel">
      <button type="button" className="filter-header" onClick={() => setOpen((o) => !o)}>
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={14}
          color="var(--muted)"
          className="filter-caret"
        />
        <Icon name="filter" size={14} color="var(--muted)" />
        <span>Filter</span>
      </button>
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

export function FilterField({ label, children }) {
  return (
    <div className="filter-field">
      <label>{label}</label>
      {children}
    </div>
  );
}
