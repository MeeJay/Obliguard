import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export interface BreakdownItem {
  key: string;
  label: ReactNode;
  count: number;
  /** Secondary figure printed after the count (e.g. "12 IPs"). */
  sub?: string;
  /** Drill-down link of the row. */
  to?: string;
}

export interface BreakdownCardProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  items: BreakdownItem[];
  loading?: boolean;
  /** Text when there is nothing to rank. */
  emptyText: string;
  /** Bar colour (one hue: the bars encode magnitude only). */
  barColor?: string;
}

/**
 * Ranked horizontal bars (Obliance AgentVersionsCard / OS connectivity bars):
 * one row per item, the bar length relative to the first (largest) one, the
 * value in text ink next to it. Rows with a `to` link to the filtered view.
 */
export function BreakdownCard({
  title, subtitle, icon, items, loading = false, emptyText, barColor = 'rgb(var(--c-accent))',
}: BreakdownCardProps) {
  const { t } = useTranslation();
  const max = Math.max(1, ...items.map((i) => i.count));

  return (
    <div className="flex flex-col rounded-xl bg-bg-secondary p-5 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)] max-sm:p-4">
      <div className="mb-4 flex items-center gap-2">
        {icon && <span className="shrink-0 text-accent" aria-hidden="true">{icon}</span>}
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-text-primary">{title}</div>
          {subtitle && <div className="truncate text-[11px] font-mono tracking-wider text-text-muted">{subtitle}</div>}
        </div>
      </div>
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-5 animate-pulse rounded bg-bg-tertiary" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="py-6 text-center text-sm text-text-muted">{emptyText}</div>
      ) : (
        <ul className="space-y-2.5" aria-label={title}>
          {items.map((item) => {
            const pct = Math.max(2, Math.round((item.count / max) * 100));
            const row = (
              <>
                <div className="flex items-baseline justify-between gap-3 text-[12px]">
                  <span className="min-w-0 truncate text-text-secondary">{item.label}</span>
                  <span className="shrink-0 font-mono text-text-primary">
                    {item.count}
                    {item.sub && <span className="ml-1.5 text-text-muted">{item.sub}</span>}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-bg-tertiary">
                  <div className="h-full rounded" style={{ width: `${pct}%`, background: barColor }} />
                </div>
              </>
            );
            return (
              <li key={item.key}>
                {item.to
                  ? <Link to={item.to} className="block rounded transition-opacity hover:opacity-80" title={t('dashboard.openFiltered', { defaultValue: 'Open the filtered view' })}>{row}</Link>
                  : row}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
