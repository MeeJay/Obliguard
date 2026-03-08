import { useRef, useState, useEffect } from 'react';
import type { Heartbeat, Monitor } from '@/store/monitorStore';

interface MiniSparklineProps {
  heartbeats: Heartbeat[];
  monitor?: Monitor;
  width?: number;
  height?: number;
}

export function MiniSparkline({ heartbeats, monitor, width: fixedWidth, height = 24 }: MiniSparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(fixedWidth ?? 80);

  useEffect(() => {
    if (fixedWidth !== undefined) return;
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        if (w > 0) setMeasuredWidth(w);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fixedWidth]);

  const width = fixedWidth ?? measuredWidth;

  const isValueWatcher = monitor?.type === 'value_watcher';

  // How many data points to show — scale with width (roughly 1 point per 4px)
  const maxPoints = Math.max(Math.floor(width / 4), 5);

  let values: number[];

  if (isValueWatcher) {
    values = heartbeats
      .filter((h) => h.value !== null && h.value !== undefined)
      .slice(-maxPoints)
      .map((h) => Number(h.value))
      .filter((v) => !isNaN(v));
  } else {
    values = heartbeats
      .filter((h) => h.responseTime !== null)
      .slice(-maxPoints)
      .map((h) => h.responseTime!);
  }

  if (values.length < 2) {
    // Still render an empty container so ResizeObserver can measure
    return fixedWidth !== undefined ? null : (
      <div ref={containerRef} className="flex-1 min-w-[60px] max-w-[200px]" />
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const pathPoints = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = `M${pathPoints.join(' L')}`;
  const strokeColor = isValueWatcher ? '#f0b429' : '#58a6ff';

  if (fixedWidth !== undefined) {
    return (
      <svg width={width} height={height} className="shrink-0">
        <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 min-w-[60px] max-w-[200px]">
      <svg width={width} height={height} className="block">
        <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
