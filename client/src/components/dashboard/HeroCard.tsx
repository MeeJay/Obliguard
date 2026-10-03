import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/utils/cn';
import { Sparkline } from './Sparkline';

export interface HeroCardProps {
  label: string;
  /** Headline value; null renders '—' (no data yet). */
  value: ReactNode;
  /** Tailwind text colour of the value. */
  valueClass?: string;
  icon?: ReactNode;
  /** Signed change behind the delta arrow (null = no reference, the arrow is hidden). */
  delta?: number | null;
  /** Whether an increase is good news (agents) or bad news (bans, attacks). Default true. */
  upIsGood?: boolean;
  /** Text after the arrow ("12 vs yesterday", "stable"…). */
  deltaText?: string;
  /** Trend under the value (oldest first). */
  series?: number[];
  /** Sparkline colour (CSS colour). */
  seriesColor?: string;
  /** Compact breakdown under the trend ("3 evaluate-only · 1 outdated"). */
  subStats?: Array<{ label: string; value: ReactNode; className?: string }>;
  /** Drill-down target: the card becomes a Link (Obliance hero tiles). */
  to?: string;
  loading?: boolean;
  /** data-status hook for the theme (up / down / alert / events). */
  status?: string;
}

/**
 * Hero KPI card on the Obliance model (DashboardPage HeroCard /
 * HeroFeatured): mono uppercase label, large display value, delta arrow vs
 * yesterday, optional sparkline and sub-stats. The whole card links to the
 * filtered view behind the number when `to` is set.
 */
export function HeroCard({
  label, value, valueClass = 'text-text-primary', icon, delta = null, upIsGood = true, deltaText,
  series, seriesColor = 'rgb(var(--c-accent))', subStats, to, loading = false, status,
}: HeroCardProps) {
  const good = delta != null && delta !== 0 && (delta > 0) === upIsGood;
  const deltaClass = delta == null || delta === 0 ? 'text-text-muted' : good ? 'text-status-up' : 'text-status-down';
  const arrow = delta == null || delta === 0 ? '—' : delta > 0 ? '↑' : '↓';

  const body = (
    <div
      data-status={status}
      className="h-full flex flex-col rounded-xl p-5 bg-bg-secondary shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)] max-sm:p-4"
    >
      <div className="mb-3 flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
        {icon && <span className="shrink-0" aria-hidden="true">{icon}</span>}
        <span className="truncate">{label}</span>
      </div>
      {loading ? (
        <div className="h-9 w-24 animate-pulse rounded bg-bg-tertiary" />
      ) : (
        <div className={cn('font-display text-[36px] font-semibold leading-none', valueClass)}>{value ?? '—'}</div>
      )}
      {!loading && (delta != null || deltaText) && (
        <div className={cn('mt-3 text-[12px] font-mono', deltaClass)}>
          <span className="mr-1" aria-hidden="true">{arrow}</span>{deltaText}
        </div>
      )}
      {series && (
        <div className="mt-3">
          <Sparkline data={series} color={seriesColor} height={32} />
        </div>
      )}
      {!loading && subStats && subStats.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-mono text-text-muted">
          {subStats.map((s) => (
            <span key={s.label} className="flex items-center gap-1">
              <span className={s.className ?? 'text-text-secondary'}>{s.value}</span>
              <span>{s.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return to
    ? <Link to={to} className="block h-full rounded-xl transition-opacity hover:opacity-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{body}</Link>
    : body;
}
