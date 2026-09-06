// Vertical timeline component — used by ReservationDetail to render the
// activity log as a visual lifecycle. Each entry has an icon + colored dot.

import Icon from './Icon';

// Dot colour plus the ink of the glyph inside it. The glyph was always white,
// which on the four light fills below sat at 2.2-2.6:1 — under WCAG 1.4.11's
// 3:1 floor for a meaningful non-text graphic, so the icon that distinguishes
// "Confirmed" from "Modified" was the part you could not see. Dark ink on the
// light fills, white on the dark ones. Fills are unchanged, so the timeline's
// colour language is exactly as it was.
const INK_DARK = '#0f172a';
const ACTION_META = {
  create: { color: '#3b82f6', ink: '#fff', icon: 'plus-circle', label: 'Created' },
  confirm: { color: '#22c55e', ink: INK_DARK, icon: 'check-circle', label: 'Confirmed' },
  modify: { color: '#f59e0b', ink: INK_DARK, icon: 'pencil', label: 'Modified' },
  check_in: { color: '#06b6d4', ink: INK_DARK, icon: 'log-in', label: 'Checked in' },
  check_out: { color: '#64748b', ink: '#fff', icon: 'log-out', label: 'Checked out' },
  cancel: { color: '#ef4444', ink: '#fff', icon: 'ban', label: 'Cancelled' },
  no_show: { color: '#ef4444', ink: '#fff', icon: 'alert-circle', label: 'No-show' },
  charge: { color: '#8b5cf6', ink: '#fff', icon: 'plus', label: 'Charge' },
  payment: { color: '#22c55e', ink: INK_DARK, icon: 'dollar-sign', label: 'Payment' },
  refund: { color: '#f59e0b', ink: INK_DARK, icon: 'arrow-left', label: 'Refund' },
  note: { color: '#94a3b8', ink: INK_DARK, icon: 'file-text', label: 'Note' },
};

export default function Timeline({ items }) {
  if (!items || !items.length) {
    return (
      <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
        No activity yet.
      </div>
    );
  }
  return (
    <div className="timeline">
      {items.map((it, i) => {
        const meta = ACTION_META[it.action] || ACTION_META.note;
        return (
          <div key={it.id || i} className="timeline-row">
            <div className="timeline-rail">
              <span className="timeline-dot" style={{ background: meta.color }}>
                <Icon name={meta.icon} size={11} color={meta.ink} />
              </span>
              {i < items.length - 1 && <span className="timeline-line" />}
            </div>
            <div className="timeline-card">
              <div className="timeline-head">
                <strong>{meta.label}</strong>
                <span className="muted" style={{ fontSize: 11 }}>
                  {new Date(it.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="timeline-body">{it.summary || it.action}</div>
              {it.userName && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  by {it.userName}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
