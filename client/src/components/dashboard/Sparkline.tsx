import { useId } from 'react';

export interface SparklineProps {
  data: number[];
  /** Stroke / gradient colour (any CSS colour, e.g. 'rgb(var(--c-status-down))'). */
  color: string;
  height?: number;
}

/**
 * Filled-area sparkline (Obliance DashboardPage Sparkline): a 2px line over a
 * fading gradient, stretched to the container width. Decorative: the value it
 * illustrates is always printed next to it. Fewer than two points render an
 * empty box of the same height so the cards keep their layout.
 */
export function Sparkline({ data, color, height = 36 }: SparklineProps) {
  const gradientId = `spark-${useId().replace(/[^a-z0-9]/gi, '')}`;
  if (data.length < 2) return <div style={{ height }} aria-hidden="true" />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 200;
  const h = height;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y] as const;
  });
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      className="block"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
