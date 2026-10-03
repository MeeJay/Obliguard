import { useEffect, useState } from 'react';
import type { AppTheme } from '@/utils/theme';

/** Fallback when <html> carries no data-theme yet (same default as utils/theme). */
const DEFAULT_THEME: AppTheme = 'obli-operator';

/** Light themes (every other theme is dark for light/dark decisions). */
const LIGHT_THEMES: ReadonlySet<AppTheme> = new Set<AppTheme>(['obli-daylight']);

/** True when the theme is a light one (Obli Daylight). */
export function isLightTheme(theme: AppTheme): boolean {
  return LIGHT_THEMES.has(theme);
}

/**
 * Reactively track the active theme by observing `data-theme` on <html>.
 *
 * The theme is applied imperatively via `applyTheme()` (it just sets the
 * attribute + localStorage) — there is no store or event to subscribe to.
 * A MutationObserver keeps this decoupled: any caller that flips the theme
 * (ProfilePage live-preview, login sync, enrollment) is picked up without
 * wiring, so theme-dependent UI (e.g. the light/dark logo, canvas colours)
 * updates instantly.
 */
export function useCurrentTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(
    () => (document.documentElement.dataset.theme as AppTheme) || DEFAULT_THEME,
  );

  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setTheme((el.dataset.theme as AppTheme) || DEFAULT_THEME);
    sync(); // catch any change between initial render and effect mount
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return theme;
}
