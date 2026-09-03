// Vertical timeline component — used by ReservationDetail to render the
// activity log as a visual lifecycle. Each entry has an icon + colored dot.

import Icon from './Icon';

const ACTION_META = {
  create: { color: '#3b82f6', icon: 'plus-circle', label: 'Created' },
  confirm: { color: '#22c55e', icon: 'check-circle', label: 'Confirmed' },
  modify: { color: '#f59e0b', icon: 'pencil', label: 'Modified' },
  check_in: { color: '#06b6d4', icon: 'log-in', label: 'Checked in' },
  check_out: { color: '#64748b', icon: 'log-out', label: 'Checked out' },
  cancel: { color: '#ef4444', icon: 'ban', label: 'Cancelled' },
  no_show: { color: '#ef4444', icon: 'alert-circle', label: 'No-show' },
  charge: { color: '#8b5cf6', icon: 'plus', label: 'Charge' },
  payment: { color: '#22c55e', icon: 'dollar-sign', label: 'Payment' },
  refund: { color: '#f59e0b', icon: 'arrow-left', label: 'Refund' },
  note: { color: '#94a3b8', icon: 'file-text', label: 'Note' },
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
                <Icon name={meta.icon} size={11} color="#fff" />
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
