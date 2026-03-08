import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useGroupStore } from '@/store/groupStore';
import { useMonitorStore } from '@/store/monitorStore';
import { useAuthStore } from '@/store/authStore';
import { GroupNode } from './GroupNode';
import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';
import { cn } from '@/utils/cn';
import { estimateMaxBars } from '@/components/monitors/HeartbeatBar';
import { monitorsApi } from '@/api/monitors.api';
import toast from 'react-hot-toast';
import type { Monitor } from '@/store/monitorStore';

interface GroupTreeProps {
  selectedGroupId?: number | null;
  onSelectGroup?: (groupId: number | null) => void;
  searchQuery?: string;
}

export function GroupTree({ selectedGroupId, onSelectGroup, searchQuery = '' }: GroupTreeProps) {
  const { tree, fetchTree, fetchGroupStats } = useGroupStore();
  const { getMonitorsByGroup, fetchSummary, fetchAllHeartbeats, getMonitorSummary, updateMonitor } = useMonitorStore();
  const { canCreate: canCreateCheck } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();

  const canMove = canCreateCheck();

  // DnD state
  const [draggingMonitor, setDraggingMonitor] = useState<Monitor | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const { expandAncestors } = useGroupStore();

  useEffect(() => {
    fetchTree();
    fetchGroupStats();
    fetchSummary();
    fetchAllHeartbeats(estimateMaxBars());
    const interval = setInterval(() => {
      fetchGroupStats();
      fetchSummary();
    }, 60000);
    return () => clearInterval(interval);
  }, [fetchTree, fetchGroupStats, fetchSummary, fetchAllHeartbeats]);

  // Auto-expand ancestors when navigating to a group detail page
  useEffect(() => {
    const match = location.pathname.match(/^\/group\/(\d+)$/);
    if (match) {
      const groupId = Number(match[1]);
      expandAncestors(groupId);
    }
  }, [location.pathname, expandAncestors]);

  const ungroupedMonitors = getMonitorsByGroup(null);

  const handleDragStart = (event: DragStartEvent) => {
    const monitorData = event.active.data.current;
    if (monitorData?.type === 'monitor') {
      setDraggingMonitor(monitorData.monitor as Monitor);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setDraggingMonitor(null);
    const { active, over } = event;
    if (!over) return;

    const monitorData = active.data.current;
    const dropData = over.data.current;
    if (monitorData?.type !== 'monitor' || !dropData) return;

    const monitorId = monitorData.monitor.id as number;
    const targetGroupId = dropData.groupId as number | null;

    // Don't move if same group
    if (monitorData.monitor.groupId === targetGroupId) return;

    try {
      await monitorsApi.update(monitorId, { groupId: targetGroupId });
      updateMonitor(monitorId, { groupId: targetGroupId });
      fetchTree();
      toast.success('Monitor moved');
    } catch {
      toast.error('Failed to move monitor');
    }
  };

  // Only show monitor-kind groups (not agent groups — those appear in the Agent Groups sidebar section)
  const monitorTree = tree.filter(n => n.kind !== 'agent');

  // When searching, filter root nodes to those that have at least one matching monitor in their subtree
  const hasMatchingMonitor = (node: import('@obliview/shared').GroupTreeNode): boolean => {
    if (getMonitorsByGroup(node.id).some(m => m.name.toLowerCase().includes(searchQuery.toLowerCase()))) return true;
    return node.children.some(hasMatchingMonitor);
  };

  const visibleMonitorTree = searchQuery
    ? monitorTree.filter(hasMatchingMonitor)
    : monitorTree;

  const filteredUngrouped = searchQuery
    ? ungroupedMonitors.filter(m => m.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : ungroupedMonitors;

  const content = (
    <div className="space-y-0.5">
      {/* Group tree (monitor groups only) */}
      {visibleMonitorTree.map((node) => (
        <GroupNode
          key={node.id}
          node={node}
          selectedGroupId={selectedGroupId}
          onSelectGroup={onSelectGroup}
          dndEnabled={canMove}
          searchQuery={searchQuery}
        />
      ))}

      {/* Ungrouped monitors */}
      {filteredUngrouped.length > 0 && (
        <UngroupedSection
          monitors={filteredUngrouped}
          dndEnabled={canMove}
          navigate={navigate}
          location={location}
          getMonitorSummary={getMonitorSummary}
          treeLength={visibleMonitorTree.length}
        />
      )}

      {/* Empty state */}
      {visibleMonitorTree.length === 0 && filteredUngrouped.length === 0 && (
        <div className="py-4 text-center text-sm text-text-muted">
          {searchQuery ? 'No matching monitors' : 'No monitors yet'}
        </div>
      )}
    </div>
  );

  if (!canMove) return content;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {content}
      <DragOverlay dropAnimation={null}>
        {draggingMonitor && (
          <div className="flex items-center gap-2 rounded-md bg-bg-secondary border border-accent px-3 py-1.5 text-sm shadow-lg">
            <MonitorStatusBadge status={draggingMonitor.status as import('@obliview/shared').MonitorStatus} size="sm" inMaintenance={draggingMonitor.inMaintenance as boolean} />
            <span className="text-text-primary">{draggingMonitor.name}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/** Ungrouped section — acts as a drop target (groupId = null) */
function UngroupedSection({
  monitors,
  dndEnabled,
  navigate,
  location,
  getMonitorSummary,
  treeLength,
}: {
  monitors: Monitor[];
  dndEnabled: boolean;
  navigate: ReturnType<typeof import('react-router-dom').useNavigate>;
  location: ReturnType<typeof import('react-router-dom').useLocation>;
  getMonitorSummary: (id: number) => { uptimePct: number; avgResponseTime: number | null } | undefined;
  treeLength: number;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'drop-ungrouped',
    data: { groupId: null },
  });

  return (
    <div
      ref={dndEnabled ? setNodeRef : undefined}
      className={cn(
        'transition-colors rounded-md',
        isOver && 'bg-accent/10 ring-1 ring-accent/30',
      )}
    >
      {treeLength > 0 && (
        <div className="my-2 border-t border-border" />
      )}
      <div className="px-2 py-1 text-xs font-medium text-text-muted uppercase tracking-wider">
        Ungrouped
      </div>
      {monitors.map((monitor) => (
        <DraggableMonitor
          key={monitor.id}
          monitor={monitor}
          depth={0}
          dndEnabled={dndEnabled}
          navigate={navigate}
          location={location}
          getMonitorSummary={getMonitorSummary}
        />
      ))}
    </div>
  );
}

/** Format a numeric-looking value with locale grouping */
function formatVal(v: string): string {
  const n = Number(v);
  if (!isNaN(n) && isFinite(n)) return n.toLocaleString();
  return v;
}

/** A single monitor item that is draggable (admin only) */
export function DraggableMonitor({
  monitor,
  depth,
  dndEnabled,
  navigate,
  location,
  getMonitorSummary,
}: {
  monitor: Monitor;
  depth: number;
  dndEnabled: boolean;
  navigate: ReturnType<typeof import('react-router-dom').useNavigate>;
  location: ReturnType<typeof import('react-router-dom').useLocation>;
  getMonitorSummary: (id: number) => { uptimePct: number; avgResponseTime: number | null } | undefined;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggableMonitor(
    monitor,
    dndEnabled,
  );
  const { getRecentHeartbeats } = useMonitorStore();

  const isActive = location.pathname === `/monitor/${monitor.id}`;
  const mSummary = getMonitorSummary(monitor.id);
  const isValueWatcher = monitor.type === 'value_watcher';

  // For value_watcher: get the current value from latest heartbeat, and previous from monitor field
  let currentValue: string | null = null;
  let previousValue: string | null = null;
  if (isValueWatcher) {
    const hbs = getRecentHeartbeats(monitor.id);
    const latest = hbs.length > 0 ? hbs[hbs.length - 1] : null;
    currentValue = latest?.value ?? null;
    previousValue = monitor.valueWatcherPreviousValue ?? null;
  }

  return (
    <button
      ref={dndEnabled ? setNodeRef : undefined}
      {...(dndEnabled ? { ...attributes, ...listeners } : {})}
      onClick={() => navigate(`/monitor/${monitor.id}`)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors',
        isActive
          ? 'bg-bg-active text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        isDragging && 'opacity-40',
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <MonitorStatusBadge status={monitor.status as import('@obliview/shared').MonitorStatus} size="sm" inMaintenance={monitor.inMaintenance as boolean} />
      <span className="truncate flex-1 text-left">{monitor.name}</span>

      {isValueWatcher ? (
        <>
          {/* Previous value → Current value badges for value_watcher */}
          {previousValue != null && currentValue != null && previousValue !== currentValue && (
            <span className="shrink-0 inline-flex items-center rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-semibold text-text-muted line-through">
              {formatVal(previousValue)}
            </span>
          )}
          {currentValue != null && (
            <span className="shrink-0 inline-flex items-center rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              {formatVal(currentValue)}
            </span>
          )}
        </>
      ) : (
        <>
          {/* Default: uptime % + response time badges */}
          {mSummary && (
            <span
              className={cn(
                'shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                mSummary.uptimePct >= 99
                  ? 'bg-status-up-bg text-status-up'
                  : mSummary.uptimePct >= 95
                    ? 'bg-yellow-500/10 text-yellow-500'
                    : 'bg-status-down-bg text-status-down',
              )}
            >
              {mSummary.uptimePct}%
            </span>
          )}
          {mSummary?.avgResponseTime != null && (
            <span className="shrink-0 inline-flex items-center rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-semibold text-text-muted">
              {Math.round(mSummary.avgResponseTime)}ms
            </span>
          )}
        </>
      )}
    </button>
  );
}

/** Hook wrapper for useDraggable to avoid conditional hook calls */
import { useDraggable } from '@dnd-kit/core';

function useDraggableMonitor(monitor: Monitor, enabled: boolean) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `monitor-${monitor.id}`,
    data: { type: 'monitor', monitor },
    disabled: !enabled,
  });
  return { attributes, listeners, setNodeRef, isDragging };
}
