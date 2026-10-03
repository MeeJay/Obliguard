import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface UseTabParamOptions {
  /** Query parameter name (default 'tab'). */
  param?: string;
  /**
   * Replace the history entry on a tab change (default true: switching tabs
   * does not pile up Back steps). false pushes a new entry.
   */
  replace?: boolean;
}

/** The tab to show for a raw ?tab= value: allowed values only, else the default. */
export function resolveTab<T extends string>(raw: string | null, allowed: ReadonlyArray<T>, fallback: T): T {
  return raw !== null && (allowed as ReadonlyArray<string>).includes(raw) ? (raw as T) : fallback;
}

/**
 * Active tab synced to the URL (?tab=…), so a reload, a shared link or Back
 * lands on the same tab. Unknown values (and tabs the user may not see:
 * leave them out of `allowed`) fall back to `defaultTab`. The default tab is
 * written as "no parameter" to keep URLs clean; other query parameters are
 * preserved.
 *
 *   const tabs = ['activity', 'bans', 'whitelist', 'remote'] as const;
 *   const [tab, setTab] = useTabParam(tabs, 'activity');
 *   <SegmentedTabs tabs={…} value={tab} onChange={setTab} />
 */
export function useTabParam<T extends string>(
  allowed: ReadonlyArray<T>,
  defaultTab: T,
  options: UseTabParamOptions = {},
): [T, (tab: T) => void] {
  const { param = 'tab', replace = true } = options;
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = resolveTab(searchParams.get(param), allowed, defaultTab);

  const setTab = useCallback((next: T) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next === defaultTab) params.delete(param);
      else params.set(param, next);
      return params;
    }, { replace });
  }, [setSearchParams, param, defaultTab, replace]);

  return [tab, setTab];
}
