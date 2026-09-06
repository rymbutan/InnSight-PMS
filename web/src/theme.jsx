// Lightweight theme provider — toggles `data-theme="dark"` on <html>.
// Persists to localStorage, defaults to system preference.

import { createContext, useContext, useEffect, useState } from 'react';
import { refreshAccentForTheme } from './lib/accent';
import { THEME_KEY, resolveTheme } from './lib/themeMode';

const ThemeCtx = createContext({ theme: 'light', toggle: () => {} });

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(resolveTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode — the theme just resets next session */
    }
    // The hotel accent is painted as INLINE custom properties on <html>, which
    // outrank any stylesheet rule including the dark block. Re-evaluate it on
    // every theme change or dark mode would keep wearing the light accent.
    refreshAccentForTheme();
  }, [theme]);

  return (
    <ThemeCtx.Provider value={{ theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeCtx);
}
