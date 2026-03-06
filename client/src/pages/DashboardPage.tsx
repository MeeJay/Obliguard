import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, CheckSquare, Activity, Clock, AlertTriangle, ShieldOff, Folder, Server, Bell } from 'lucide-react';
import type { Monitor, GroupTreeNode } from '@obliview/shared';
import { useMonitorStore } from '@/store/monitorStore';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';
import { useSocket } from '@/hooks/useSocket';
import { monitorsApi } from '@/api/monitors.api';
import { MonitorCard } from '@/components/monitors/MonitorCard';
import { BulkEditModal } from '@/components/monitors/BulkEditModal';
import { estimateMaxBars } from '@/components/monitors/HeartbeatBar';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';


/** Count all monitors inside a group tree node (recursively) */
function countMonitors(
  node: GroupTreeNode,
  getMonitorsByGroup: (groupId: number | null) => Monitor[],
): number {
  let count = getMonitorsByGroup(node.id).length;
  for (const child of node.children) {
    count += countMonitors(child, getMonitorsByGroup);
  }
  return count;
}

/** Check recursively if a group tree node has any monitors */
function hasAnyMonitors(
  node: GroupTreeNode,
  getMonitorsByGroup: (groupId: number | null) => Monitor[],
): boolean {
  if (getMonitorsByGroup(node.id).length > 0) return true;
  return node.children.some((child) => hasAnyMonitors(child, getMonitorsByGroup));
}

/**
 * Distribute items into 2 columns using a "shortest column first" algorithm.
 * Each item has a weight (estimated height). Returns [leftItems, rightItems].
 */
function distributeColumns<T>(items: T[], getWeight: (item: T) => number): [T[], T[]] {
  const left: T[] = [];
  const right: T[] = [];
  let leftWeight = 0;
  let rightWeight = 0;

  for (const item of items) {
    const w = getWeight(item);
    if (leftWeight <= rightWeight) {
      left.push(item);
      leftWeight += w;
    } else {
      right.push(item);
      rightWeight += w;
    }
  }
  return [left, right];
}

export function DashboardPage() {
  useSocket();

  const { t } = useTranslation();
  const { canCreate } = useAuthStore();
  const { openAddAgentModal } = useUiStore();
  const { fetchMonitors, fetchAllHeartbeats, getMonitorList, getMonitorsByGroup, getRecentHeartbeats, isLoading } = useMonitorStore();
  const { tree, fetchTree } = useGroupStore();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectionKind, setSelectionKind] = useState<'monitor' | 'agent' | null>(null);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [overallUptime, setOverallUptime] = useState<number | null>(null);
  const [overallAvgRt, setOverallAvgRt] = useState<number | null>(null);

  useEffect(() => {
    fetchMonitors();
    fetchAllHeartbeats(estimateMaxBars());
    fetchTree();
    monitorsApi.getSummary().then((summary) => {
      const entries = Object.values(summary);
      if (entries.length > 0) {
        const totalUptime = entries.reduce((sum, e) => sum + e.uptimePct, 0);
        setOverallUptime(Math.round((totalUptime / entries.length) * 100) / 100);
        const rtEntries = entries.filter((e) => e.avgResponseTime !== null);
        if (rtEntries.length > 0) {
          const totalRt = rtEntries.reduce((sum, e) => sum + e.avgResponseTime!, 0);
          setOverallAvgRt(Math.round(totalRt / rtEntries.length));
        }
      }
    }).catch(() => {});
  }, [fetchMonitors, fetchAllHeartbeats, fetchTree]);

  const monitors = getMonitorList();
  const showCreate = canCreate();

  const upCount = monitors.filter((m) => m.status === 'up').length;
  const downCount = monitors.filter((m) => m.status === 'down').length;
  const alertCount = monitors.filter((m) => m.status === 'alert').length;
  const pendingCount = monitors.filter((m) => m.status === 'pending').length;
  const pausedCount = monitors.filter((m) => m.status === 'paused').length;
  const sslWarnCount = monitors.filter((m) => m.status === 'ssl_warning').length;
  const sslExpiredCount = monitors.filter((m) => m.status === 'ssl_expired').length;

  // Problem monitors (shown in dedicated sections above the column layout)
  const downMonitors = monitors
    .filter((m) => m.status === 'down')
    .sort((a, b) => a.name.localeCompare(b.name));
  const alertMonitors = monitors
    .filter((m) => m.status === 'alert')
    .sort((a, b) => a.name.localeCompare(b.name));
  const sslExpiredMonitors = monitors
    .filter((m) => m.status === 'ssl_expired')
    .sort((a, b) => a.name.localeCompare(b.name));

  // Ungrouped monitors
  const ungroupedMonitors = getMonitorsByGroup(null)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Build column items: each root group and ungrouped form a "block"
  type ColumnBlock =
    | { type: 'group'; node: GroupTreeNode }
    | { type: 'ungrouped'; monitors: Monitor[] };

  const columnBlocks = useMemo(() => {
    const blocks: ColumnBlock[] = [];

    // Root groups that have at least one monitor (anywhere in subtree)
    for (const node of tree) {
      if (hasAnyMonitors(node, getMonitorsByGroup)) {
        blocks.push({ type: 'group', node });
      }
    }

    // Ungrouped monitors
    if (ungroupedMonitors.length > 0) {
      blocks.push({ type: 'ungrouped', monitors: ungroupedMonitors });
    }

    return blocks;
  }, [tree, ungroupedMonitors, getMonitorsByGroup]);

  const [leftBlocks, rightBlocks] = useMemo(() => {
    return distributeColumns(columnBlocks, (block) => {
      if (block.type === 'ungrouped') return block.monitors.length + 1; // +1 for header
      return countMonitors(block.node, getMonitorsByGroup) + 1;
    });
  }, [columnBlocks, getMonitorsByGroup]);

  const handleSelect = (id: number) => {
    const monitor = getMonitorList().find((m) => m.id === id);
    if (!monitor) return;
    const isAgent = monitor.type === 'agent';
    const kind = isAgent ? 'agent' : 'monitor';

    // Block cross-kind selection
    if (selectionKind !== null && selectionKind !== kind && !selectedIds.has(id)) return;

    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
    setSelectionKind(newSet.size === 0 ? null : kind);
  };

  const renderBlock = (block: ColumnBlock) => {
    if (block.type === 'ungrouped') {
      return (
        <DashboardSection
          key="ungrouped"
          title={t('dashboard.sectionUngrouped')}
          borderColor="border-border"
        >
          {block.monitors.map((m) => (
            <MonitorCard
              key={m.id}
              monitor={m}
              heartbeats={getRecentHeartbeats(m.id)}
              selectionMode={selectionMode}
              selected={selectedIds.has(m.id)}
              selectionDisabled={selectionKind !== null && (m.type === 'agent') !== (selectionKind === 'agent')}
              onSelect={handleSelect}
            />
          ))}
        </DashboardSection>
      );
    }

    return (
      <GroupSection
        key={block.node.id}
        node={block.node}
        depth={0}
        getMonitorsByGroup={getMonitorsByGroup}
        getRecentHeartbeats={getRecentHeartbeats}
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        selectionKind={selectionKind}
        onSelect={handleSelect}
      />
    );
  };

  if (isLoading && monitors.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('dashboard.title')}</h1>
        {showCreate && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectionMode(!selectionMode);
                setSelectedIds(new Set());
                setSelectionKind(null);
              }}
            >
              <CheckSquare size={16} className="mr-1.5" />
              {selectionMode ? t('dashboard.cancelSelection') : t('dashboard.select')}
            </Button>
            <Button variant="secondary" size="sm" onClick={openAddAgentModal}>
              <Plus size={16} className="mr-1.5" />
              {t('dashboard.addAgent')}
            </Button>
            <Link to="/monitor/new">
              <Button variant="secondary" size="sm">
                <Plus size={16} className="mr-1.5" />
                {t('dashboard.addMonitor')}
              </Button>
            </Link>
          </div>
        )}
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-4 mb-6">
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="text-2xl font-bold text-status-up">{upCount}</div>
          <div className="text-sm text-text-secondary">{t('dashboard.statsUp')}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="text-2xl font-bold text-status-down">{downCount}</div>
          <div className="text-sm text-text-secondary">{t('dashboard.statsDown')}</div>
        </div>
        {alertCount > 0 && (
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-2xl font-bold text-orange-500">{alertCount}</div>
            <div className="text-sm text-text-secondary">{t('dashboard.statsAlert')}</div>
          </div>
        )}
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="text-2xl font-bold text-status-pending">{pendingCount}</div>
          <div className="text-sm text-text-secondary">{t('dashboard.statsPending')}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="text-2xl font-bold text-status-paused">{pausedCount}</div>
          <div className="text-sm text-text-secondary">{t('dashboard.statsPaused')}</div>
        </div>
        {(sslWarnCount > 0 || sslExpiredCount > 0) && (
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-2xl font-bold text-status-ssl-warning">{sslWarnCount}</div>
            <div className="text-sm text-text-secondary">{t('dashboard.statsSslWarn')}</div>
          </div>
        )}
        {sslExpiredCount > 0 && (
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-2xl font-bold text-status-ssl-expired">{sslExpiredCount}</div>
            <div className="text-sm text-text-secondary">{t('dashboard.statsSslExpired')}</div>
          </div>
        )}
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="flex items-center gap-1.5 text-2xl font-bold text-accent">
            <Activity size={20} />
            {overallUptime !== null ? `${overallUptime}%` : '-'}
          </div>
          <div className="text-sm text-text-secondary">{t('dashboard.statsUptime')}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="flex items-center gap-1.5 text-2xl font-bold text-text-primary">
            <Clock size={20} />
            {overallAvgRt !== null ? `${overallAvgRt}ms` : '-'}
          </div>
          <div className="text-sm text-text-secondary">{t('dashboard.statsAvgResponse')}</div>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectionMode && selectedIds.size > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-accent/30 bg-bg-tertiary p-3">
          <span className="text-sm text-text-secondary">
            {selectionKind === 'agent'
              ? t(selectedIds.size === 1 ? 'dashboard.selectedCountAgent_one' : 'dashboard.selectedCountAgent_other', { count: selectedIds.size })
              : t(selectedIds.size === 1 ? 'dashboard.selectedCount_one' : 'dashboard.selectedCount_other', { count: selectedIds.size })}
          </span>
          <Button variant="secondary" size="sm" onClick={() => setBulkEditOpen(true)}>
            {t('dashboard.editSelected')}
          </Button>
          <Button variant="secondary" size="sm">
            {t('dashboard.pause')}
          </Button>
          <Button variant="danger" size="sm">
            {t('dashboard.bulkDelete')}
          </Button>
        </div>
      )}

      {/* ── Down monitors (full width, above columns) ── */}
      {downMonitors.length > 0 && (
        <DashboardSection
          icon={<AlertTriangle size={16} className="text-status-down" />}
          title={t('dashboard.sectionDown')}
          badge={<span className="text-xs font-semibold text-status-down">{downMonitors.length}</span>}
          borderColor="border-status-down/30"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {downMonitors.map((m) => (
              <MonitorCard
                key={m.id}
                monitor={m}
                heartbeats={getRecentHeartbeats(m.id)}
                selectionMode={selectionMode}
                selected={selectedIds.has(m.id)}
                selectionDisabled={selectionKind !== null && (m.type === 'agent') !== (selectionKind === 'agent')}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </DashboardSection>
      )}

      {/* ── Alert monitors — agent threshold violations (full width, above columns) ── */}
      {alertMonitors.length > 0 && (
        <DashboardSection
          icon={<Bell size={16} className="text-orange-500" />}
          title={t('dashboard.sectionAlert')}
          badge={<span className="text-xs font-semibold text-orange-500">{alertMonitors.length}</span>}
          borderColor="border-orange-500/30"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {alertMonitors.map((m) => (
              <MonitorCard
                key={m.id}
                monitor={m}
                heartbeats={getRecentHeartbeats(m.id)}
                selectionMode={selectionMode}
                selected={selectedIds.has(m.id)}
                selectionDisabled={selectionKind !== null && (m.type === 'agent') !== (selectionKind === 'agent')}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </DashboardSection>
      )}

      {/* ── SSL Expired monitors (full width, above columns) ── */}
      {sslExpiredMonitors.length > 0 && (
        <DashboardSection
          icon={<ShieldOff size={16} className="text-status-ssl-expired" />}
          title={t('dashboard.sectionSslExpired')}
          badge={<span className="text-xs font-semibold text-status-ssl-expired">{sslExpiredMonitors.length}</span>}
          borderColor="border-status-ssl-expired/30"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {sslExpiredMonitors.map((m) => (
              <MonitorCard
                key={m.id}
                monitor={m}
                heartbeats={getRecentHeartbeats(m.id)}
                selectionMode={selectionMode}
                selected={selectedIds.has(m.id)}
                selectionDisabled={selectionKind !== null && (m.type === 'agent') !== (selectionKind === 'agent')}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </DashboardSection>
      )}

      {/* ── Two-column layout for groups ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6">
        <div>
          {leftBlocks.map(renderBlock)}
        </div>
        <div>
          {rightBlocks.map(renderBlock)}
        </div>
      </div>

      {/* Empty state */}
      {monitors.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-text-muted">{t('dashboard.noMonitors')}</p>
        </div>
      )}

      {/* Bulk edit modal */}
      {bulkEditOpen && (
        <BulkEditModal
          monitorIds={Array.from(selectedIds)}
          isAgentSelection={selectionKind === 'agent'}
          onClose={() => setBulkEditOpen(false)}
        />
      )}
    </div>
  );
}

/** Renders a group and its subgroups recursively */
function GroupSection({
  node,
  depth,
  getMonitorsByGroup,
  getRecentHeartbeats,
  selectionMode,
  selectedIds,
  selectionKind,
  onSelect,
}: {
  node: GroupTreeNode;
  depth: number;
  getMonitorsByGroup: (groupId: number | null) => Monitor[];
  getRecentHeartbeats: (id: number) => import('@obliview/shared').Heartbeat[];
  selectionMode: boolean;
  selectedIds: Set<number>;
  selectionKind: 'monitor' | 'agent' | null;
  onSelect: (id: number) => void;
}) {
  const groupMonitors = getMonitorsByGroup(node.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Skip entirely empty groups (no monitors at any level)
  if (!hasAnyMonitors(node, getMonitorsByGroup)) return null;

  const groupIcon = node.kind === 'agent'
    ? <Server size={16} className="text-accent" />
    : <Folder size={16} className="text-accent" />;

  return (
    <DashboardSection
      icon={groupIcon}
      title={node.name}
      depth={depth}
      borderColor="border-accent/20"
    >
      {/* Direct monitors */}
      {groupMonitors.map((m) => (
        <MonitorCard
          key={m.id}
          monitor={m}
          heartbeats={getRecentHeartbeats(m.id)}
          selectionMode={selectionMode}
          selected={selectedIds.has(m.id)}
          selectionDisabled={selectionKind !== null && (m.type === 'agent') !== (selectionKind === 'agent')}
          onSelect={onSelect}
        />
      ))}

      {/* Child groups */}
      {node.children.map((child) => (
        <GroupSection
          key={child.id}
          node={child}
          depth={depth + 1}
          getMonitorsByGroup={getMonitorsByGroup}
          getRecentHeartbeats={getRecentHeartbeats}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          selectionKind={selectionKind}
          onSelect={onSelect}
        />
      ))}
    </DashboardSection>
  );
}

/** Reusable section wrapper with a title header */
function DashboardSection({
  icon,
  title,
  badge,
  borderColor = 'border-border',
  depth = 0,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  borderColor?: string;
  depth?: number;
  children: React.ReactNode;
}) {
  return (
    <div className={`mb-4 ${depth > 0 ? 'ml-4' : ''}`}>
      <div className={`flex items-center gap-2 mb-2 pb-1 border-b ${borderColor}`}>
        {icon}
        <span className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
          {title}
        </span>
        {badge}
      </div>
      <div className="space-y-2">
        {children}
      </div>
    </div>
  );
}
