import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';

export interface PaginationProps {
  /** Current page, 1-based. */
  page: number;
  pageSize: number;
  /** Total row count when the server knows it (page mode). */
  total?: number;
  /** Keyset / "limit + 1" mode: is there a next page? Ignored when `total` is set. */
  hasMore?: boolean;
  /** Rows actually shown on this page (keyset mode: the last page may be short). */
  count?: number;
  onChange: (page: number) => void;
  /** Shows a page-size select when both are given. */
  pageSizeOptions?: ReadonlyArray<number>;
  onPageSizeChange?: (pageSize: number) => void;
  /** Disable the controls while a page is loading. */
  disabled?: boolean;
  className?: string;
}

export interface PaginationRange {
  /** 1-based index of the first row shown (0 when nothing is shown). */
  from: number;
  /** 1-based index of the last row shown. */
  to: number;
  /** Last page number, or null when the total is unknown. */
  pageCount: number | null;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Pure range maths behind <Pagination> (exported for tests and custom footers). */
export function paginationRange(
  page: number,
  pageSize: number,
  total?: number,
  hasMore?: boolean,
  count?: number,
): PaginationRange {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const current = Math.max(1, Math.floor(page) || 1);
  const start = (current - 1) * size;
  if (typeof total === 'number') {
    const safeTotal = Math.max(0, total);
    const pageCount = Math.max(1, Math.ceil(safeTotal / size));
    const end = Math.min(safeTotal, start + size);
    // A page past the end (rows deleted meanwhile) shows nothing: 0–0, not "0–n".
    const shownAny = end > start;
    return {
      from: shownAny ? start + 1 : 0,
      to: shownAny ? end : 0,
      pageCount,
      hasPrev: current > 1,
      hasNext: current < pageCount,
    };
  }
  const shown = typeof count === 'number' ? Math.max(0, Math.min(count, size)) : size;
  return {
    from: shown > 0 ? start + 1 : 0,
    to: shown > 0 ? start + shown : 0,
    pageCount: null,
    hasPrev: current > 1,
    hasNext: !!hasMore,
  };
}

/**
 * Table footer: "x–y of n" + previous / next (and an optional page-size
 * select). Works with a known total (page mode) or with `hasMore` (keyset
 * mode, "x–y" only). Renders nothing when no row is shown, there is no other
 * page and no page-size select.
 *
 *   <Pagination page={page} pageSize={50} total={total} onChange={setPage} />
 *   <Pagination page={page} pageSize={50} hasMore={hasMore} count={rows.length} onChange={setPage} />
 */
export function Pagination({
  page,
  pageSize,
  total,
  hasMore,
  count,
  onChange,
  pageSizeOptions,
  onPageSizeChange,
  disabled = false,
  className,
}: PaginationProps) {
  const { t } = useTranslation();
  const range = paginationRange(page, pageSize, total, hasMore, count);
  const showSize = !!onPageSizeChange && !!pageSizeOptions && pageSizeOptions.length > 0;
  if (!range.hasPrev && !range.hasNext && !showSize && range.from === 0) return null;

  const label = typeof total === 'number'
    ? t('common.pagination.rangeOfTotal', {
        defaultValue: '{{from}}–{{to}} of {{total}}',
        from: range.from.toLocaleString(),
        to: range.to.toLocaleString(),
        total: Math.max(0, total).toLocaleString(),
      })
    : t('common.pagination.range', {
        defaultValue: '{{from}}–{{to}}',
        from: range.from.toLocaleString(),
        to: range.to.toLocaleString(),
      });

  const btn = cn(
    'flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors',
    'hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
  );

  return (
    <nav
      aria-label={t('common.pagination.label', { defaultValue: 'Pagination' })}
      className={cn('flex flex-wrap items-center justify-between gap-3 text-sm text-text-muted', className)}
    >
      <span aria-live="polite" className="tabular-nums">{label}</span>
      <div className="flex items-center gap-3">
        {showSize && (
          <label className="flex items-center gap-2 text-xs">
            <span>{t('common.pagination.pageSize', { defaultValue: 'Rows per page' })}</span>
            <select
              value={pageSize}
              disabled={disabled}
              onChange={(e) => onPageSizeChange!(Number(e.target.value))}
              className="rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60"
            >
              {pageSizeOptions!.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        {range.pageCount !== null && range.pageCount > 1 && (
          <span className="text-xs tabular-nums">
            {t('common.pagination.pageOf', {
              defaultValue: 'Page {{page}} of {{pages}}',
              page: Math.max(1, Math.floor(page) || 1),
              pages: range.pageCount,
            })}
          </span>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={btn}
            disabled={disabled || !range.hasPrev}
            onClick={() => onChange(Math.max(1, page - 1))}
            aria-label={t('common.pagination.previous', { defaultValue: 'Previous page' })}
            title={t('common.pagination.previous', { defaultValue: 'Previous page' })}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className={btn}
            disabled={disabled || !range.hasNext}
            onClick={() => onChange(page + 1)}
            aria-label={t('common.pagination.next', { defaultValue: 'Next page' })}
            title={t('common.pagination.next', { defaultValue: 'Next page' })}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </nav>
  );
}
