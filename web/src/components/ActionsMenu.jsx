import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

// Dropdown button used across reservation detail, folio rows, etc.
// `items`: [{ label, onClick, disabled?, danger?, divider? }]
export default function ActionsMenu({
  label = 'Actions',
  items = [],
  variant = 'primary',
  align = 'right',
  disabled,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const visible = items.filter(Boolean);

  return (
    <div className={`actions-menu ${variant}`} ref={ref}>
      <button
        type="button"
        className={`actions-trigger ${variant}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {label} <Icon name="chevron-down" size={12} className="caret" />
      </button>
      {open && (
        <div className={`actions-pop ${align}`}>
          {visible.map((it, i) =>
            it.divider ? (
              <div key={`d${i}`} className="actions-divider" />
            ) : (
              <button
                key={i}
                type="button"
                className={`actions-item ${it.danger ? 'danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick?.();
                }}
              >
                {it.icon && <span className="actions-icon">{it.icon}</span>}
                {it.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
