// The system accent colours, pushed onto the document as CSS custom properties.
//
// Everything in styles.css already draws its accent from var(--accent),
// var(--green) and var(--accent-hover), so overriding those three on <html> is
// enough to recolour every button, active nav row, focus ring and highlight in
// the app — no per-component work and no rebuild.
//
// The values are hosted server-side (GET /api/settings/theme, backed by the
// AppSetting table) because the accent belongs to the hotel, not to a device.
// A copy is cached in localStorage purely so a reload paints the right colour on
// the FIRST frame instead of flashing the shipped green and then correcting
// itself once the request lands.

export const DEFAULT_ACCENT = { primary: '#0a6b3d', secondary: '#22c55e', hover: '#075130' };

const CACHE_KEY = 'innsight_accent';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function valid(a) {
  return (
    a && HEX_RE.test(a.primary || '') && HEX_RE.test(a.secondary || '') && HEX_RE.test(a.hover || '')
  );
}

// Relative luminance per WCAG 2.1, used only to decide black-vs-white text.
function luminance(hex) {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// White text on a pale accent is unreadable, and an admin picking a light colour
// should not silently produce buttons nobody can read. So the text colour that
// sits ON each accent is derived rather than assumed — the same reason
// --on-green is dark while --on-accent is white in the shipped palette.
function onColorFor(hex) {
  return luminance(hex) > 0.45 ? '#0f172a' : '#ffffff';
}

export function applyAccent(accent) {
  if (!valid(accent)) return;
  const root = document.documentElement;
  root.style.setProperty('--accent', accent.primary);
  root.style.setProperty('--accent-hover', accent.hover);
  root.style.setProperty('--green', accent.secondary);
  root.style.setProperty('--green-hover', accent.hover);
  root.style.setProperty('--on-accent', onColorFor(accent.primary));
  root.style.setProperty('--on-green', onColorFor(accent.secondary));
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(accent));
  } catch {
    /* private mode — the accent just re-fetches each load */
  }
}

// Call before the first paint so a customised accent does not flash green.
export function applyCachedAccent() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) applyAccent(JSON.parse(raw));
  } catch {
    /* ignore a corrupt cache — the server value follows shortly */
  }
}
