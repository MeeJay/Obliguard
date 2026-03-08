import { Link } from 'react-router-dom';
import type { Monitor, Heartbeat } from '@/store/monitorStore';
import { MONITOR_TYPE_LABELS } from '@obliview/shared';
import type { MonitorStatus } from '@obliview/shared';
import { MonitorStatusBadge } from './MonitorStatusBadge';
import { HeartbeatBar } from './HeartbeatBar';
import { MiniSparkline } from './MiniSparkline';
import { cn } from '@/utils/cn';

interface MonitorCardProps {
  monitor: Monitor;
  heartbeats: Heartbeat[];
  selected?: boolean;
  onSelect?: (id: number) => void;
  selectionMode?: boolean;
  /** Greyed out because a conflicting selection kind is active */
  selectionDisabled?: boolean;
}

export function MonitorCard({
  monitor,
  heartbeats,
  selected,
  onSelect,
  selectionMode,
  selectionDisabled,
}: MonitorCardProps) {
  const lastHeartbeat = heartbeats[heartbeats.length - 1];
  const responseTime = lastHeartbeat?.responseTime;
  const isValueWatcher = monitor.type === 'value_watcher';
  const isAgent = monitor.type === 'agent';
  const watchedValue = lastHeartbeat?.value;

  // Agent monitor: parse the JSON value snapshot for metric summary
  const agentMetricSummary = (() => {
    if (!isAgent || !lastHeartbeat?.value) return null;
    try {
      const v = JSON.parse(lastHeartbeat.value) as {
        cpu?: number; memory?: number;
        disks?: Array<{ mount: string; percent: number }>;
      };
      const parts: string[] = [];
      if (v.cpu !== undefined) parts.push(`CPU ${v.cpu.toFixed(0)}%`);
      if (v.memory !== undefined) parts.push(`RAM ${v.memory.toFixed(0)}%`);
      if (v.disks?.[0]) parts.push(`Disk ${v.disks[0].percent.toFixed(0)}%`);
      return parts.join(' · ') || null;
    } catch { return null; }
  })();

  // Link target: agent monitors go to /agents/:deviceId, others to /monitor/:id
  const linkTo = isAgent && monitor.agentDeviceId
    ? `/agents/${monitor.agentDeviceId}`
    : `/monitor/${monitor.id}`;

  /** Format a numeric string with locale grouping (e.g. 1000000 → 1,000,000) */
  const formatValue = (val: string) => {
    const num = Number(val);
    if (!isNaN(num)) return num.toLocaleString();
    return val;
  };

  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-lg border border-border p-3 transition-colors',
        'hover:bg-bg-hover hover:border-border-light',
        selected && 'border-accent bg-bg-tertiary',
        selectionMode && !selectionDisabled && 'cursor-pointer',
        selectionDisabled && 'opacity-35 pointer-events-none',
      )}
      onClick={selectionMode && !selectionDisabled ? () => onSelect?.(monitor.id) : undefined}
    >
      {selectionMode && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onSelect?.(monitor.id)}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 rounded border-border bg-bg-tertiary text-accent focus:ring-accent"
        />
      )}

      <Link
        to={linkTo}
        className="flex flex-1 items-center gap-3 min-w-0"
        onClick={selectionMode ? (e) => e.preventDefault() : undefined}
      >
        <MonitorStatusBadge status={monitor.status as MonitorStatus} size="sm" inMaintenance={monitor.inMaintenance as boolean} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-text-primary text-sm">
              {isAgent ? ((monitor.agentDeviceName as string | null) || monitor.name) : monitor.name}
            </span>
            <span className="text-xs text-text-muted">
              {MONITOR_TYPE_LABELS[monitor.type as keyof typeof MONITOR_TYPE_LABELS]}
            </span>
            {/* Agent metric summary inline */}
            {isAgent && agentMetricSummary && monitor.status !== 'down' && monitor.status !== 'alert' && (
              <span className="hidden sm:inline text-xs text-text-muted truncate">
                {agentMetricSummary}
              </span>
            )}
          </div>

          {/* Agent ALERT/DOWN: show violation message in appropriate color */}
          {isAgent && (monitor.status === 'alert' || monitor.status === 'down') && lastHeartbeat?.message && lastHeartbeat.message !== 'All metrics OK' ? (
            <div className={`mt-0.5 text-xs truncate ${monitor.status === 'alert' ? 'text-orange-500 dark:text-orange-400' : 'text-red-600 dark:text-red-400'}`}>
              {lastHeartbeat.message}
            </div>
          ) : (
            <div className="mt-1">
              <HeartbeatBar heartbeats={heartbeats} />
            </div>
          )}
        </div>

        {!isAgent && (
          <div className="flex items-center gap-3 shrink-0 sm:shrink sm:flex-1 sm:max-w-[280px]">
            <MiniSparkline heartbeats={heartbeats} monitor={monitor} />
            {isValueWatcher ? (
              watchedValue != null && (
                <div className="text-right">
                  <span className="text-sm font-mono font-semibold text-accent">
                    {formatValue(watchedValue)}
                  </span>
                </div>
              )
            ) : (
              responseTime !== undefined && responseTime !== null && (
                <div className="text-right">
                  <span className="text-sm font-mono text-text-secondary">
                    {responseTime}ms
                  </span>
                </div>
              )
            )}
          </div>
        )}
      </Link>
    </div>
  );
}
