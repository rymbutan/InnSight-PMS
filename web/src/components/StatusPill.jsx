// Cloudbeds-style status pill — solid color capsule.
// Maps backend status enums to a consistent visual vocabulary.

const STYLES = {
  CONFIRMED: { bg: '#3b82f6', label: 'Confirmed' },
  PENDING: { bg: '#94a3b8', label: 'Confirmation Pending' },
  IN_HOUSE: { bg: '#22c55e', label: 'In-House Guest' },
  CHECKED_IN: { bg: '#22c55e', label: 'In-House Guest' },
  CHECKED_OUT: { bg: '#64748b', label: 'Checked Out' },
  DEPARTED: { bg: '#64748b', label: 'Checked Out' },
  CANCELLED: { bg: '#ef4444', label: 'Cancelled' },
  NO_SHOW: { bg: '#ef4444', label: 'No-Show' },
  ARRIVAL: { bg: '#3b82f6', label: 'Arrival' },
  PRE_ARRIVAL: { bg: '#fbbf24', label: 'Pre-Arrival' },
};

export default function StatusPill({ status, size = 'md' }) {
  const key = String(status || '')
    .toUpperCase()
    .replace(/[\s-]/g, '_');
  const style = STYLES[key] || { bg: '#94a3b8', label: status || '—' };
  const padding = size === 'sm' ? '3px 10px' : '6px 16px';
  const fontSize = size === 'sm' ? 11 : 12;
  return (
    <span
      className="status-pill"
      style={{
        background: style.bg,
        color: '#fff',
        padding,
        fontSize,
        fontWeight: 600,
        borderRadius: 999,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        display: 'inline-block',
        whiteSpace: 'nowrap',
      }}
    >
      {style.label}
    </span>
  );
}
