import type { ReactNode } from 'react';
import { Inbox, SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';

export interface EmptyStateProps {
  /**
   * 'empty' = there is no data yet; 'filtered' = data exists but the current
   * filters match nothing (offers "Clear filters" when onClearFilters is set).
   */
  variant?: 'empty' | 'filtered';
  /** Overrides the variant's default icon. */
  icon?: ReactNode;
  /** Overrides the variant's default title (already translated). */
  title?: ReactNode;
  description?: ReactNode;
  /** Extra action (e.g. "Add a whitelist entry"), shown after Clear filters. */
  action?: ReactNode;
  /** 'filtered' variant: resets the page's filters. */
  onClearFilters?: () => void;
  /** Render as a full-width table row (<tr><td colSpan>) inside a <tbody>. */
  colSpan?: number;
  /** Tighter padding (inside cards / drawers). */
  compact?: boolean;
  className?: string;
}

/**
 * The shared "nothing to show" block. Tell "no data yet" apart from "your
 * filters match nothing":
 *
 *   {rows.length === 0 && (hasFilters
 *     ? <EmptyState variant="filtered" onClearFilters={resetFilters} colSpan={6} />
 *     : <EmptyState title={t('bans.empty', { defaultValue: 'No active bans' })} colSpan={6} />)}
 */
export function EmptyState({
  variant = 'empty',
  icon,
  title,
  description,
  action,
  onClearFilters,
  colSpan,
  compact = false,
  className,
}: EmptyStateProps) {
  const { t } = useTranslation();
  const filtered = variant === 'filtered';
  const DefaultIcon = filtered ? SearchX : Inbox;
  const heading = title ?? (filtered
    ? t('common.emptyState.filteredTitle', { defaultValue: 'No results match your filters' })
    : t('common.emptyState.emptyTitle', { defaultValue: 'Nothing here yet' }));
  const text = description ?? (filtered
    ? t('common.emptyState.filteredDescription', { defaultValue: 'Try another search or clear the filters.' })
    : undefined);

  const content = (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'px-4 py-6' : 'px-6 py-12',
        className,
      )}
    >
      <span className="text-text-muted" aria-hidden="true">
        {icon ?? <DefaultIcon size={compact ? 24 : 32} strokeWidth={1.5} />}
      </span>
      <p className="text-sm font-medium text-text-primary">{heading}</p>
      {text && <p className="max-w-md text-sm text-text-muted">{text}</p>}
      {((filtered && onClearFilters) || action) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {filtered && onClearFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              className="rounded-lg bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t('common.emptyState.clearFilters', { defaultValue: 'Clear filters' })}
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );

  if (colSpan !== undefined) {
    return (
      <tr>
        <td colSpan={colSpan}>{content}</td>
      </tr>
    );
  }
  return content;
}
