import type { AppTheme } from '@obliview/shared';

export { type AppTheme };

const STORAGE_KEY = 'og-theme';

/** Apply a theme by setting data-theme on <html> and persisting it. */
export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable
  }
}

/** Load the theme from localStorage (used before session check to avoid flash). */
export function loadSavedTheme(): AppTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'neon' || saved === 'modern') return saved;
  } catch {
    // ignore
  }
  return 'modern';
}

/** Apply theme immediately on module import to prevent flash of unstyled content. */
export function initTheme(): void {
  applyTheme(loadSavedTheme());
}
