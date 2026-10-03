import { useCallback, useMemo, useState } from 'react';

export type RowKey = string | number;

/** State of a "select all" header checkbox. */
export type SelectionHeaderState = 'checked' | 'indeterminate' | 'unchecked';

/** Header checkbox state computed on the VISIBLE rows only. */
export function selectionHeaderState<K extends RowKey>(selected: ReadonlySet<K>, visibleIds: ReadonlyArray<K>): SelectionHeaderState {
  if (visibleIds.length === 0) return 'unchecked';
  let hit = 0;
  for (const id of visibleIds) if (selected.has(id)) hit++;
  if (hit === 0) return 'unchecked';
  return hit === visibleIds.length ? 'checked' : 'indeterminate';
}

/**
 * "Select all" toggle on the visible rows: when every visible row is
 * selected they are all deselected, otherwise they are all selected. Rows
 * selected elsewhere (not visible) are left alone.
 */
export function toggleVisibleSelection<K extends RowKey>(selected: ReadonlySet<K>, visibleIds: ReadonlyArray<K>): Set<K> {
  const next = new Set(selected);
  if (selectionHeaderState(selected, visibleIds) === 'checked') {
    for (const id of visibleIds) next.delete(id);
  } else {
    for (const id of visibleIds) next.add(id);
  }
  return next;
}

export interface RowSelection<K extends RowKey> {
  selected: ReadonlySet<K>;
  /** Number of selected rows. */
  count: number;
  /** Selected ids, in the order of the visible rows first, then the rest. */
  ids: K[];
  isSelected: (id: K) => boolean;
  toggle: (id: K) => void;
  /** Select / deselect every visible row (or the given ids). */
  toggleAllVisible: (ids?: ReadonlyArray<K>) => void;
  /** Header checkbox state on the visible rows. */
  headerState: SelectionHeaderState;
  /** Replace the selection. */
  setSelected: (ids: Iterable<K>) => void;
  clear: () => void;
}

/**
 * Bulk-selection state for a data table. Bulk actions apply only to rows the
 * user explicitly ticked: pass a `resetKey` built from the filters and the
 * page (e.g. `[filters, page]`) and the selection is cleared whenever it
 * changes (no stale ids from another filter or page).
 *
 *   const sel = useRowSelection(rows.map((r) => r.ip), [filters, page]);
 *   <input type="checkbox" checked={sel.headerState === 'checked'}
 *     ref={(el) => { if (el) el.indeterminate = sel.headerState === 'indeterminate'; }}
 *     onChange={() => sel.toggleAllVisible()} />
 */
/**
 * Serialise a reset key for comparison. Sets and Maps (common in filter
 * state, see useSessionState) are expanded: plain JSON.stringify turns every
 * Set into "{}", so a Set-based filter change would never clear the selection.
 */
export function selectionResetKey(resetKey: unknown): string {
  try {
    return JSON.stringify(resetKey ?? null, (_k, v: unknown) => {
      if (v instanceof Set) return { __set: Array.from(v).map(String).sort() };
      if (v instanceof Map) return { __map: Array.from(v.entries()).map(([k, val]) => [String(k), val]) };
      return v;
    }) ?? 'null';
  } catch {
    // Unserialisable key (cycle, BigInt): fall back to a string form.
    return String(resetKey);
  }
}

export function useRowSelection<K extends RowKey>(visibleIds: ReadonlyArray<K>, resetKey?: unknown): RowSelection<K> {
  const [selected, setSelectedState] = useState<Set<K>>(() => new Set());
  const keyString = selectionResetKey(resetKey);
  const [lastKey, setLastKey] = useState(keyString);

  // Reset during render (not in an effect) so a filter / page change never
  // renders one frame with the previous selection.
  let current = selected;
  if (keyString !== lastKey) {
    current = new Set();
    setLastKey(keyString);
    setSelectedState(current);
  }

  const toggle = useCallback((id: K) => {
    setSelectedState((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback((ids?: ReadonlyArray<K>) => {
    const target = ids ?? visibleIds;
    setSelectedState((prev) => toggleVisibleSelection(prev, target));
  }, [visibleIds]);

  const setSelected = useCallback((ids: Iterable<K>) => setSelectedState(new Set(ids)), []);
  const clear = useCallback(() => setSelectedState(new Set()), []);
  const isSelected = useCallback((id: K) => current.has(id), [current]);

  const headerState = useMemo(() => selectionHeaderState(current, visibleIds), [current, visibleIds]);
  const ids = useMemo(() => {
    const ordered = visibleIds.filter((id) => current.has(id));
    const seen = new Set<K>(ordered);
    for (const id of current) if (!seen.has(id)) ordered.push(id);
    return ordered;
  }, [current, visibleIds]);

  return {
    selected: current,
    count: current.size,
    ids,
    isSelected,
    toggle,
    toggleAllVisible,
    headerState,
    setSelected,
    clear,
  };
}
