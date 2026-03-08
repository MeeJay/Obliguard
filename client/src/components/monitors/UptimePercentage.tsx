import type { Heartbeat } from '@/store/monitorStore';
import { cn } from '@/utils/cn';

interface UptimePercentageProps {
  heartbeats: Heartbeat[];
  label?: string;
}

export function UptimePercentage({ heartbeats, label }: UptimePercentageProps) {
  if (heartbeats.length === 0) {
    return (
      <div className="text-sm text-text-muted">
        {label && <span className="mr-1">{label}:</span>}
        N/A
      </div>
    );
  }

  const NON_UP_STATUSES = new Set(['down', 'alert', 'ssl_expired']);
  const up = heartbeats.filter((h) => h.status === 'up').length;
  const total = heartbeats.filter((h) => h.status === 'up' || NON_UP_STATUSES.has(h.status)).length;
  const pct = total > 0 ? (up / total) * 100 : 0;

  return (
    <div className="text-sm">
      {label && <span className="mr-1 text-text-secondary">{label}:</span>}
      <span
        className={cn(
          'font-mono font-semibold',
          pct >= 99 ? 'text-status-up' :
          pct >= 95 ? 'text-status-pending' :
          'text-status-down',
        )}
      >
        {pct.toFixed(2)}%
      </span>
    </div>
  );
}
