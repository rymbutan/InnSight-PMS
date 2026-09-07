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

import { resolveTheme } from './themeMode';

export const DEFAULT_ACCENT = { primary: '#0a6b3d', secondary: '#22c55e', hover: '#075130' };

const CACHE_KEY = 'innsight_accent';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function valid(a) {
  return a && HEX_RE.test(a.primary || '') && HEX_RE.test(a.secondary || '') && HEX_RE.test(a.hover || '');
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

// The properties this module owns. Listed once so painting and clearing cannot
// disagree about which ones to touch.
const ACCENT_VARS = ['--accent', '--accent-hover', '--green', '--green-hover', '--on-accent', '--on-green'];

// The accent last handed to us, kept so a theme toggle can re-decide without
// re-fetching. Module-level rather than in React state because the very first
// paint happens before React mounts (see applyCachedAccent).
let current = null;

// Whether the accent overlay applies right now.
//
// It does NOT apply in dark mode. These are INLINE properties on <html>, so they
// outrank every stylesheet rule — including the dark block — and the stored
// accent is a light-theme value: this hotel's #0a6b3d measures 2.0:1 against the
// dark card, an accent you cannot see. Dark mode therefore keeps the palette
// defined in styles.css, and the hotel's colour owns light mode as before.
function accentApplies() {
  const stamped = document.documentElement.dataset.theme;
  // Before React mounts, data-theme is not on <html> yet — ask the same resolver
  // ThemeProvider will use, so the first frame is not painted with the wrong one.
  return (stamped || resolveTheme()) !== 'dark';
}

function paint() {
  const root = document.documentElement;
  if (!current || !accentApplies()) {
    for (const v of ACCENT_VARS) root.style.removeProperty(v);
    return;
  }
  root.style.setProperty('--accent', current.primary);
  root.style.setProperty('--accent-hover', current.hover);
  root.style.setProperty('--green', current.secondary);
  root.style.setProperty('--green-hover', current.hover);
  root.style.setProperty('--on-accent', onColorFor(current.primary));
  root.style.setProperty('--on-green', onColorFor(current.secondary));
}

export function applyAccent(accent) {
  if (!valid(accent)) return;
  current = accent;
  paint();
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(accent));
  } catch {
    /* private mode — the accent just re-fetches each load */
  }
}

// Called by ThemeProvider whenever the theme changes. Re-runs the decision above
// so switching to dark strips the overlay and switching back restores it.
export function refreshAccentForTheme() {
  paint();
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
