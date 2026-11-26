import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { themeWipe } from '../themeWipe';

/**
 * The theme: one component, beside the wipe it drives.
 *
 * Both selectors are stamped: `base.css` binds the light palette to
 * `[data-theme="light"], .light-mode`, so setting one and not the other leaves
 * half the rules unmatched depending on which the consumer happened to write.
 */

export type Theme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'ns-theme';
const DEFAULT_THEME: Theme = 'dark';

const getInitialTheme = (): Theme => {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : DEFAULT_THEME;
};

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  toggleTheme: () => {},
});

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  const isWiping = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.body.classList.toggle('light-mode', theme === 'light');
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  /**
   * A theme lands in one frame, so the change is covered rather than
   * transitioned — `themeWipe` fills the viewport with the incoming ground on a
   * diagonal front, commits the swap while the screen is covered, then clears
   * the same front away.
   *
   * The guard is not cosmetic: a second toggle mid-wipe would leave two
   * canvases racing and could commit the themes out of order.
   */
  const applyTheme = useCallback(
    (next: Theme) => {
      // Deliberately not inside a state updater: React may invoke an updater
      // twice in StrictMode, and starting the wipe from there would run it twice.
      if (next === theme || isWiping.current) return;
      isWiping.current = true;
      themeWipe(next, () => {
        setThemeState(next);
        isWiping.current = false;
      });
    },
    [theme],
  );

  const value = useMemo(
    () => ({
      theme,
      setTheme: applyTheme,
      toggleTheme: () => applyTheme(theme === 'dark' ? 'light' : 'dark'),
    }),
    [theme, applyTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);
