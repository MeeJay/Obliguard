import type { ReactNode, ThHTMLAttributes } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';

export type SortDir = 'asc' | 'desc';

/** Current sort of a table: a field + direction, or null (unsorted / server default). */
export type SortState<F extends string = string> = { field: F; dir: SortDir } | null;

/**
 * Tri-state cycle on a column click: another column → asc; asc → desc;
 * desc → none (null). Pair it with usePersistedState / useSessionState:
 *
 *   const [sort, setSort] = useSessionState<SortState<'ip' | 'count'>>('og-bans-sort', null);
 *   const onSort = (f: 'ip' | 'count') => setSort((s) => nextSort(s, f));
 */
export function nextSort<F extends string>(current: SortState<F>, field: F): SortState<F> {
  if (!current || current.field !== field) return { field, dir: 'asc' };
  if (current.dir === 'asc') return { field, dir: 'desc' };
  return null;
}

export interface SortableThProps<F extends string = string>
  extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'onClick' | 'children'> {
  /** Field this column sorts on. */
  field: F;
  /** The table's current sort. */
  sort: SortState<F>;
  /** Called with this column's field; the parent applies nextSort(). */
  onSort: (field: F) => void;
  children: ReactNode;
  /** Content alignment (right for numeric columns). */
  align?: 'left' | 'right' | 'center';
}

/**
 * A sortable column header: the whole label is a button, the <th> carries
 * aria-sort (ascending / descending / none) and the icon shows the state
 * (dimmed up/down when unsorted).
 *
 *   <SortableTh field="count" sort={sort} onSort={onSort} align="right">
 *     {t('bans.count', { defaultValue: 'Count' })}
 *   </SortableTh>
 */
export function SortableTh<F extends string = string>({
  field,
  sort,
  onSort,
  children,
  align = 'left',
  className,
  ...rest
}: SortableThProps<F>) {
  const { t } = useTranslation();
  const dir = sort && sort.field === field ? sort.dir : null;
  const ariaSort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  const hint = dir === 'asc'
    ? t('common.sort.sortDescending', { defaultValue: 'Sort descending' })
    : dir === 'desc'
      ? t('common.sort.clearSort', { defaultValue: 'Clear sort' })
      : t('common.sort.sortAscending', { defaultValue: 'Sort ascending' });
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ChevronsUpDown;

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={cn(align === 'right' && 'text-right', align === 'center' && 'text-center', className)}
      {...rest}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        title={hint}
        className={cn(
          // Preflight resets text-transform on buttons: inherit the th look
          // (uppercase / tracking headers keep it).
          'inline-flex max-w-full items-center gap-1 rounded [letter-spacing:inherit] [text-transform:inherit] transition-colors',
          'hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          align === 'right' && 'flex-row-reverse',
          dir && 'text-text-primary',
        )}
      >
        <span className="truncate">{children}</span>
        <Icon size={12} aria-hidden="true" className={cn('shrink-0', !dir && 'opacity-40')} />
      </button>
    </th>
  );
}
