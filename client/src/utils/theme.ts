import type { AppTheme } from '@obliview/shared';

export { type AppTheme };

const STORAGE_KEY = 'og-theme';

const DEFAULT_THEME: AppTheme = 'obli-operator';
const KNOWN = new Set<AppTheme>(['obli-operator', 'obli-daylight', 'modern', 'neon']);

/**
 * Apply a theme by setting data-theme on <html> and persisting it.
 * Accepts a raw string and falls back to the default on any unknown id, so a
 * new theme added upstream in Obligate (and pushed via SSO) can never brick us.
 */
export function applyTheme(theme: string): void {
  const safe = KNOWN.has(theme as AppTheme) ? (theme as AppTheme) : DEFAULT_THEME;
  document.documentElement.dataset.theme = safe;
  try {
    localStorage.setItem(STORAGE_KEY, safe);
  } catch {
    // localStorage unavailable
  }
}

/** Load the theme from localStorage (used before session check to avoid flash). */
export function loadSavedTheme(): AppTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && KNOWN.has(saved as AppTheme)) return saved as AppTheme;
  } catch {
    // ignore
  }
  return DEFAULT_THEME;
}

/** Apply theme immediately on module import to prevent flash of unstyled content. */
export function initTheme(): void {
  applyTheme(loadSavedTheme());
}
