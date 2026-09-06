// Which theme is active, resolved WITHOUT React.
//
// This lives in its own module on purpose. Two things need the answer —
// ThemeProvider (to seed its state) and lib/accent.js (to decide whether the
// hotel's accent overlay applies) — and theme.jsx already imports accent.js, so
// putting the resolver there would make the pair circular. A leaf module both
// can import is the way out, and it keeps the storage key defined exactly once.

export const THEME_KEY = 'innsight_theme';

export function resolveTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    /* private mode — fall through to the OS preference */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
