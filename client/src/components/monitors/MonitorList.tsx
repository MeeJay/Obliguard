import type { Monitor } from '@/store/monitorStore';
import { MonitorCard } from './MonitorCard';
import { useMonitorStore } from '@/store/monitorStore';

interface MonitorListProps {
  monitors: Monitor[];
  selectionMode?: boolean;
  selectedIds?: Set<number>;
  onSelectionChange?: (ids: Set<number>) => void;
}

export function MonitorList({
  monitors,
  selectionMode = false,
  selectedIds = new Set(),
  onSelectionChange,
}: MonitorListProps) {
  const { getRecentHeartbeats } = useMonitorStore();

  const handleSelect = (id: number) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    onSelectionChange?.(newSet);
  };

  if (monitors.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-text-muted">No monitors found</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {monitors.map((monitor) => (
        <MonitorCard
          key={monitor.id}
          monitor={monitor}
          heartbeats={getRecentHeartbeats(monitor.id)}
          selectionMode={selectionMode}
          selected={selectedIds.has(monitor.id)}
          onSelect={handleSelect}
        />
      ))}
    </div>
  );
}
