// Cloudbeds-style status pill — solid color capsule.
// Maps backend status enums to a consistent visual vocabulary.

// The status vocabulary. Fixed hex rather than theme tokens, for the same
// reason the role palette is fixed: a status colour is an identifier, and one
// that shifted between themes would stop being learnable.
//
// Each entry now names its own INK. Every pill used to be white-on-fill, which
// failed badly on the light fills and was never a dark-mode-only problem:
// white on #fbbf24 (Pre-Arrival) measured 1.79:1, on #94a3b8 (Pending) 2.42:1
// and on #22c55e (In-House) 2.19:1 — three of the most common pills in the app,
// unreadable in BOTH themes. Where white was genuinely close (blue-500 at
// 3.68:1, red-500 at 3.76:1) the fill is darkened one step instead of the ink
// being flipped, so the colour still reads as blue and red.
//
// `fg` is chosen per fill: dark ink on the light fills, white on the dark ones.
const INK_DARK = '#0f172a';
const STYLES = {
  CONFIRMED: { bg: '#2563eb', fg: '#fff', label: 'Confirmed' }, // was #3b82f6 — 3.68:1
  PENDING: { bg: '#94a3b8', fg: INK_DARK, label: 'Confirmation Pending' },
  IN_HOUSE: { bg: '#22c55e', fg: INK_DARK, label: 'In-House Guest' },
  CHECKED_IN: { bg: '#22c55e', fg: INK_DARK, label: 'In-House Guest' },
  CHECKED_OUT: { bg: '#64748b', fg: '#fff', label: 'Checked Out' },
  DEPARTED: { bg: '#64748b', fg: '#fff', label: 'Checked Out' },
  CANCELLED: { bg: '#dc2626', fg: '#fff', label: 'Cancelled' }, // was #ef4444 — 3.76:1
  NO_SHOW: { bg: '#dc2626', fg: '#fff', label: 'No-Show' },
  ARRIVAL: { bg: '#2563eb', fg: '#fff', label: 'Arrival' },
  PRE_ARRIVAL: { bg: '#fbbf24', fg: INK_DARK, label: 'Pre-Arrival' },
};

export default function StatusPill({ status, size = 'md' }) {
  const key = String(status || '')
    .toUpperCase()
    .replace(/[\s-]/g, '_');
  const style = STYLES[key] || { bg: '#94a3b8', fg: INK_DARK, label: status || '—' };
  const padding = size === 'sm' ? '3px 10px' : '6px 16px';
  const fontSize = size === 'sm' ? 11 : 12;
  return (
    <span
      className="status-pill"
      style={{
        background: style.bg,
        color: style.fg,
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
