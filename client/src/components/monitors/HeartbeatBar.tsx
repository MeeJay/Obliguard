import { useRef, useState, useEffect } from 'react';
import type { MonitorStatus } from '@obliview/shared';
import type { Heartbeat } from '@/store/monitorStore';
import { cn } from '@/utils/cn';

interface HeartbeatBarProps {
  heartbeats: Heartbeat[];
  maxBars?: number;
}

const BAR_WIDTH = 6;
const GAP_WIDTH = 2;
const UNIT = BAR_WIDTH + GAP_WIDTH; // 8px per bar

/**
 * Estimate the number of heartbeat bars that fit on the widest card
 * on the current screen. Uses conservative estimate so we always
 * fetch enough data (a few extra are fine, gray bars are avoided).
 */
export function estimateMaxBars(): number {
  const screenWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  // Dashboard uses 2-column layout on lg+ (≥1024px).
  // Approximate usable width for one column:
  // (screenWidth - sidebar(~280) - padding(~48) - columnGap(~24)) / 2 - cardPadding(~160)
  const isLg = screenWidth >= 1024;
  const contentWidth = screenWidth - 330;
  const columnWidth = isLg ? (contentWidth - 24) / 2 : contentWidth;
  const usable = Math.max(columnWidth - 160, 100);
  return Math.min(Math.ceil((usable + GAP_WIDTH) / UNIT), 300);
}

const statusColors: Record<MonitorStatus, string> = {
  up:          'bg-status-up',
  down:        'bg-status-down',
  pending:     'bg-status-pending',
  maintenance: 'bg-status-maintenance',
  paused:      'bg-status-paused',
  ssl_warning: 'bg-status-ssl-warning',
  ssl_expired: 'bg-status-ssl-expired',
  alert:       'bg-orange-500',
  inactive:    'bg-gray-400',
  updating:    'bg-blue-500',
};

export function HeartbeatBar({ heartbeats, maxBars }: HeartbeatBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [calculatedBars, setCalculatedBars] = useState(maxBars ?? 45);

  useEffect(() => {
    if (maxBars !== undefined) return; // explicit maxBars takes priority
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const bars = Math.max(Math.floor((width + GAP_WIDTH) / UNIT), 1);
        setCalculatedBars(bars);
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [maxBars]);

  const effectiveBars = maxBars ?? calculatedBars;

  // Pad with empty slots if not enough heartbeats
  const bars: (Heartbeat | null)[] = [];
  const start = Math.max(0, heartbeats.length - effectiveBars);
  const visible = heartbeats.slice(start);

  for (let i = 0; i < effectiveBars - visible.length; i++) {
    bars.push(null);
  }
  bars.push(...visible);

  return (
    <div ref={containerRef} className="w-full">
      <div className="flex items-center gap-[2px]">
        {bars.map((hb, i) => {
          // Determine bar color: maintenance down/pending → maintenance color (blue)
          let barColor = 'bg-bg-tertiary';
          if (hb) {
            if (hb.inMaintenance && hb.status !== 'up') {
              barColor = 'bg-status-maintenance';
            } else if (hb.isRetrying) {
              barColor = 'bg-orange-500';
            } else {
              barColor = statusColors[hb.status as MonitorStatus] || 'bg-border';
            }
          }
          const maintenanceLabel = hb?.inMaintenance && hb.status !== 'up' ? ' · In maintenance' : '';
          return (
            <div
              key={i}
              className={cn(
                'h-6 w-[6px] rounded-sm transition-all',
                barColor,
                hb && 'hover:opacity-80 cursor-default',
              )}
              title={
                hb
                  ? `${hb.status.toUpperCase()}${hb.isRetrying ? ' (Retrying)' : ''}${maintenanceLabel} - ${hb.responseTime ? `${hb.responseTime}ms` : 'N/A'}${hb.createdAt ? ` - ${new Date(hb.createdAt).toLocaleString()}` : ''}`
                  : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}
