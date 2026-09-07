// Minimalist empty-state illustrations — inline SVG, no external dependencies.
// Pick one of the built-in kinds, or pass your own `icon` element.

const ILLUSTRATIONS = {
  inbox: (
    <svg width="120" height="90" viewBox="0 0 120 90" fill="none">
      <rect
        x="18"
        y="22"
        width="84"
        height="50"
        rx="6"
        stroke="var(--art-line)"
        strokeWidth="2"
        fill="var(--art-fill)"
      />
      <path d="M18 52h24l6 8h24l6-8h24" stroke="var(--art-line)" strokeWidth="2" fill="var(--art-fill-2)" />
      <circle cx="60" cy="16" r="3" fill="var(--art-shape)" />
      <circle cx="44" cy="12" r="2" fill="var(--art-shape)" />
      <circle cx="76" cy="12" r="2" fill="var(--art-shape)" />
    </svg>
  ),
  calendar: (
    <svg width="120" height="90" viewBox="0 0 120 90" fill="none">
      <rect
        x="20"
        y="20"
        width="80"
        height="56"
        rx="6"
        stroke="var(--art-line)"
        strokeWidth="2"
        fill="var(--art-fill)"
      />
      <rect x="20" y="20" width="80" height="14" rx="6" fill="var(--art-shape)" />
      <line
        x1="40"
        y1="14"
        x2="40"
        y2="28"
        stroke="var(--art-line-strong)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <line
        x1="80"
        y1="14"
        x2="80"
        y2="28"
        stroke="var(--art-line-strong)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <rect x="32" y="44" width="10" height="8" rx="2" fill="var(--art-shape)" />
      <rect x="48" y="44" width="10" height="8" rx="2" fill="var(--art-shape)" />
      <rect x="64" y="44" width="10" height="8" rx="2" fill="var(--accent)" opacity="0.5" />
      <rect x="80" y="44" width="10" height="8" rx="2" fill="var(--art-shape)" />
      <rect x="32" y="58" width="10" height="8" rx="2" fill="var(--art-shape)" />
      <rect x="48" y="58" width="10" height="8" rx="2" fill="var(--art-shape)" />
    </svg>
  ),
  guests: (
    <svg width="120" height="90" viewBox="0 0 120 90" fill="none">
      <circle cx="44" cy="36" r="12" fill="var(--art-shape)" />
      <path
        d="M24 72c0-11 9-20 20-20s20 9 20 20"
        fill="var(--art-fill-2)"
        stroke="var(--art-line)"
        strokeWidth="2"
      />
      <circle cx="78" cy="42" r="10" fill="var(--art-line)" />
      <path
        d="M62 74c0-9 7-16 16-16s16 7 16 16"
        fill="var(--art-shape)"
        stroke="var(--art-line-strong)"
        strokeWidth="2"
      />
    </svg>
  ),
  chart: (
    <svg width="120" height="90" viewBox="0 0 120 90" fill="none">
      <rect
        x="18"
        y="18"
        width="84"
        height="54"
        rx="4"
        stroke="var(--art-line)"
        strokeWidth="2"
        fill="var(--art-fill)"
      />
      <rect x="30" y="52" width="10" height="16" fill="var(--art-shape)" />
      <rect x="46" y="42" width="10" height="26" fill="var(--art-line)" />
      <rect x="62" y="34" width="10" height="34" fill="var(--accent)" opacity="0.6" />
      <rect x="78" y="46" width="10" height="22" fill="var(--art-shape)" />
    </svg>
  ),
  search: (
    <svg width="120" height="90" viewBox="0 0 120 90" fill="none">
      <circle cx="50" cy="42" r="22" stroke="var(--art-line)" strokeWidth="3" fill="var(--art-fill)" />
      <line
        x1="66"
        y1="58"
        x2="84"
        y2="76"
        stroke="var(--art-line-strong)"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  ),
};

export default function EmptyState({ kind = 'inbox', title, hint, action, icon }) {
  return (
    <div className="empty-state">
      <div className="empty-art">{icon || ILLUSTRATIONS[kind] || ILLUSTRATIONS.inbox}</div>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
