import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';

export interface TableSkeletonProps {
  /** Placeholder rows (use the page size so the table keeps its height). */
  rows?: number;
  /** Placeholder columns (the table's column count). */
  cols: number;
  /**
   * Render bare <tr> rows, to drop inside an existing <tbody> under the real
   * <thead> (default). false renders a standalone <table>.
   */
  asRows?: boolean;
  /** Row height class, matching the real rows (default h-11). */
  rowClassName?: string;
  className?: string;
}

/** Deterministic, slightly varied bar widths so the skeleton does not look like a grid. */
const WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-2/5', 'w-3/5'];

/**
 * Loading placeholder for a data table: `rows` × `cols` pulsing bars at the
 * real row height, so the first load does not collapse the layout. For a
 * refresh, keep the stale rows on screen (dimmed) instead of swapping back
 * to the skeleton.
 *
 *   <tbody>{loading && rows.length === 0 ? <TableSkeleton rows={pageSize} cols={6} /> : rows.map(…)}</tbody>
 */
export function TableSkeleton({ rows = 8, cols, asRows = true, rowClassName = 'h-11', className }: TableSkeletonProps) {
  const { t } = useTranslation();
  const body = Array.from({ length: Math.max(0, rows) }, (_, r) => (
    <tr key={r} className={cn('border-b border-border/50 last:border-0', rowClassName)} aria-hidden="true">
      {Array.from({ length: Math.max(1, cols) }, (_, c) => (
        <td key={c} className="px-4 py-2">
          <div className={cn('h-3 animate-pulse rounded bg-bg-tertiary', WIDTHS[(r + c * 2) % WIDTHS.length])} />
        </td>
      ))}
    </tr>
  ));

  if (asRows) return <>{body}</>;
  return (
    <table
      className={cn('w-full', className)}
      aria-busy="true"
      aria-label={t('common.loading', { defaultValue: 'Loading…' })}
    >
      <tbody>{body}</tbody>
    </table>
  );
}
