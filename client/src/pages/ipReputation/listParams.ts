import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { SortState } from '@/components/common/SortableTh';

/**
 * URL state shared by the Bans / Whitelist / Remote tabs of the IP
 * Reputation hub. Every tab keeps its filters in the query string under its
 * own prefix (b_ / w_ / r_), so a reload, a shared link or Back restores the
 * tab exactly and the tabs never clobber each other (nor the Activity tab's
 * unprefixed ?status= / ?search= deep-link contract).
 */

/** Ban changes pushed by the server (shared SOCKET_EVENTS.BAN_*). */
export const BAN_SOCKET_EVENTS = [
  SOCKET_EVENTS.BAN_CREATED,
  SOCKET_EVENTS.BAN_UPDATED,
  SOCKET_EVENTS.BAN_LIFTED,
  SOCKET_EVENTS.BAN_AUTO,
  SOCKET_EVENTS.BAN_EXCLUDED,
  SOCKET_EVENTS.BAN_EXCLUSION_REMOVED,
  SOCKET_EVENTS.BAN_BULK_LIFTED,
] as const;

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

/** A 1-based page number from the URL (anything else: 1). */
export function parsePage(v: string | null): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

/** One of `allowed` from the URL, else `fallback`. */
export function parseEnum<T extends string>(v: string | null, allowed: readonly T[], fallback: T): T {
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** `1,2,3` → sorted unique positive ids. */
export function parseIdList(v: string | null): number[] {
  if (!v) return [];
  const ids = new Set<number>();
  for (const part of v.split(',')) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return [...ids].sort((a, b) => a - b);
}

export interface PrefixedParams {
  /** Raw value of `<prefix><name>`. */
  get: (name: string) => string | null;
  /**
   * One URL write (history replace). `set(name, value)` inside `mutate`
   * writes `<prefix><name>` (null / '' removes it). Filter changes go back
   * to page 1 unless `resetPage` is false.
   */
  update: (mutate: (set: (name: string, value: string | null) => void) => void, resetPage?: boolean) => void;
}

/** Read / write the query parameters of one tab (`prefix` = 'b_', 'w_' or 'r_'). */
export function usePrefixedParams(prefix: string): PrefixedParams {
  const [searchParams, setSearchParams] = useSearchParams();
  const get = useCallback((name: string) => searchParams.get(prefix + name), [searchParams, prefix]);
  const update = useCallback<PrefixedParams['update']>((mutate, resetPage = true) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      mutate((name, value) => {
        if (value === null || value === '') p.delete(prefix + name);
        else p.set(prefix + name, value);
      });
      if (resetPage) p.delete(`${prefix}page`);
      return p;
    }, { replace: true });
  }, [setSearchParams, prefix]);
  return { get, update };
}

/**
 * The search box of a tab: local state, debounced (300 ms) into
 * `<prefix>search`, and re-synced when the URL changes from outside (Back,
 * a link). Returns the input value, its setter and the committed URL value.
 */
export function useDebouncedSearch(params: PrefixedParams): [string, (v: string) => void, string] {
  const urlSearch = (params.get('search') ?? '').trim();
  const [search, setSearch] = useState(urlSearch);
  const lastWritten = useRef(urlSearch);
  useEffect(() => {
    if (urlSearch === lastWritten.current) return;
    lastWritten.current = urlSearch;
    setSearch(urlSearch);
  }, [urlSearch]);
  const { update } = params;
  useEffect(() => {
    const q = search.trim();
    if (q === lastWritten.current) return;
    const timer = setTimeout(() => {
      lastWritten.current = q;
      update((set) => set('search', q || null));
    }, 300);
    return () => clearTimeout(timer);
  }, [search, update]);
  const setNow = useCallback((v: string) => {
    // Clearing is immediate (Clear filters / the x button).
    if (v === '') lastWritten.current = '';
    setSearch(v);
  }, []);
  return [search, setNow, urlSearch];
}

/** Sort state from `<prefix>sortBy` / `<prefix>sortOrder` (null = server default). */
export function useSortParam<F extends string>(params: PrefixedParams, allowed: readonly F[]): [SortState<F>, (next: SortState<F>) => void] {
  const by = params.get('sortBy');
  const order = params.get('sortOrder');
  const sort = useMemo<SortState<F>>(() => {
    if (by === null || !(allowed as readonly string[]).includes(by)) return null;
    return { field: by as F, dir: order === 'asc' ? 'asc' : 'desc' };
  }, [by, order, allowed]);
  const { update } = params;
  const setSort = useCallback((next: SortState<F>) => update((set) => {
    set('sortBy', next ? next.field : null);
    set('sortOrder', next ? next.dir : null);
  }), [update]);
  return [sort, setSort];
}

/** Short local date + time ('—' when absent or invalid). */
export function formatWhen(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
