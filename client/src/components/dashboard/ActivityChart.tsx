import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMediaQuery, MEDIA } from '@/hooks/useMediaQuery';

/** One bucket of the chart (the parent maps daily and hourly points to it). */
export interface ActivityPoint {
  /** Axis label (MM-DD or HHh). */
  label: string;
  /** Tooltip title (full date / hour). */
  title: string;
  failures: number;
  events: number;
  uniqueIps: number;
  bans: number;
}

const FAILURES = 'rgb(var(--c-status-down))';
const EVENTS = 'rgb(var(--c-text-muted))';

/**
 * Attack activity over time (Obliance ActivityChart, plain SVG): auth
 * failures as a filled area, all events as a dashed line, one shared y axis
 * (same unit). Hovering (or touching) shows a crosshair and a tooltip with
 * the bucket's failures, events, hostile IPs and bans. Desktop stretches an
 * 800x240 viewBox to the card; below lg the viewBox follows the measured
 * width so axis labels keep a real 10px.
 */
export function ActivityChart({ data }: { data: ActivityPoint[] }) {
  const { t } = useTranslation();
  const isDesktop = useMediaQuery(MEDIA.lg);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (isDesktop) return;
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setMeasured(Math.round(el.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop, data.length]);

  if (data.length < 2) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm text-text-muted">
        {t('dashboard.notEnoughHistory', { defaultValue: 'Not enough history yet' })}
      </div>
    );
  }

  const yMax = Math.max(...data.map((d) => Math.max(d.events, d.failures)), 1);
  const narrow = !isDesktop && measured > 0;
  const w = narrow ? Math.max(measured, 240) : 800;
  const h = narrow ? 200 : 240;
  const pad = { l: 40, r: 12, t: 16, b: 28 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  const xOf = (i: number) => pad.l + (i / (data.length - 1)) * cw;
  const yOf = (v: number) => pad.t + (1 - v / yMax) * ch;
  const line = (pick: (d: ActivityPoint) => number) =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(pick(d)).toFixed(1)}`).join(' ');
  const failuresPath = line((d) => d.failures);
  const eventsPath = line((d) => d.events);
  const failuresArea = `${failuresPath} L${xOf(data.length - 1)},${pad.t + ch} L${xOf(0)},${pad.t + ch} Z`;
  const ticks = [0, 0.5, 1].map((f) => yMax * f);
  const fmt = (v: number) => (v >= 10_000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.round(((x - pad.l) / cw) * (data.length - 1));
    setHover(Math.min(data.length - 1, Math.max(0, i)));
  };

  const hovered = hover != null ? data[hover] : null;
  const leftPct = hover != null ? (xOf(hover) / w) * 100 : 0;

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="block w-full touch-pan-y"
        preserveAspectRatio="none"
        style={narrow ? { height: h } : undefined}
        role="img"
        aria-label={t('dashboard.activityChartLabel', { defaultValue: 'Auth failures and events over time' })}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="ips-activity-failures" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={FAILURES} stopOpacity="0.28" />
            <stop offset="100%" stopColor={FAILURES} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={yOf(v)} y2={yOf(v)} stroke="rgb(var(--c-text-muted) / 0.12)" strokeWidth="1" />
            <text x={pad.l - 6} y={yOf(v) + 3} fontSize="10" fontFamily="JetBrains Mono" fill="rgb(var(--c-text-muted))" textAnchor="end">
              {fmt(v)}
            </text>
          </g>
        ))}
        <path d={failuresArea} fill="url(#ips-activity-failures)" />
        <path d={eventsPath} fill="none" stroke={EVENTS} strokeWidth="1.5" strokeDasharray="4 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <path d={failuresPath} fill="none" stroke={FAILURES} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {hover != null && (
          <g pointerEvents="none">
            <line x1={xOf(hover)} x2={xOf(hover)} y1={pad.t} y2={pad.t + ch} stroke="rgb(var(--c-text-muted) / 0.5)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <circle cx={xOf(hover)} cy={yOf(data[hover].failures)} r="4" fill={FAILURES} stroke="rgb(var(--c-bg-secondary))" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </g>
        )}
        {[0, Math.floor(data.length / 2), data.length - 1].map((i) => (
          <text key={i} x={xOf(i)} y={h - 8} fontSize="10" fontFamily="JetBrains Mono" fill="rgb(var(--c-text-muted))" textAnchor="middle">
            {data[i].label}
          </text>
        ))}
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[150px] rounded-md border border-border bg-bg-primary px-3 py-2 text-[11px] font-mono shadow-lg"
          style={leftPct > 60 ? { right: `${100 - leftPct + 2}%` } : { left: `${leftPct + 2}%` }}
        >
          <div className="mb-1 text-text-primary">{hovered.title}</div>
          <div className="flex justify-between gap-3 text-text-secondary">
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-3" style={{ background: FAILURES }} />{t('dashboard.seriesFailures', { defaultValue: 'Failures' })}</span>
            <span className="text-text-primary">{hovered.failures}</span>
          </div>
          <div className="flex justify-between gap-3 text-text-secondary">
            <span className="flex items-center gap-1.5"><span className="w-3 border-t border-dashed border-text-muted" />{t('dashboard.seriesEvents', { defaultValue: 'Events' })}</span>
            <span className="text-text-primary">{hovered.events}</span>
          </div>
          <div className="flex justify-between gap-3 text-text-muted">
            <span>{t('dashboard.seriesHostileIps', { defaultValue: 'Hostile IPs' })}</span>
            <span className="text-text-primary">{hovered.uniqueIps}</span>
          </div>
          <div className="flex justify-between gap-3 text-text-muted">
            <span>{t('dashboard.seriesBans', { defaultValue: 'Bans' })}</span>
            <span className="text-text-primary">{hovered.bans}</span>
          </div>
        </div>
      )}
    </div>
  );
}
