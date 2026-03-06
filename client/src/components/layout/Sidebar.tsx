import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  LayoutDashboard,
  Settings,
  Bell,
  Users,
  FolderTree,
  Plus,
  UserCircle,
  LogOut,
  Cpu,
  Server,
  ArrowLeftRight,
  PackageOpen,
  ShieldCheck,
  ChevronDown,
  CalendarClock,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import { useMonitorStore } from '@/store/monitorStore';
import { useGroupStore } from '@/store/groupStore';
import { useUiStore } from '@/store/uiStore';
import { GroupTree } from '@/components/groups/GroupTree';
import { agentApi } from '@/api/agent.api';
import { getSocket } from '@/socket/socketClient';
import type { AgentDevice, MonitorStatus } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import toast from 'react-hot-toast';

// ── localStorage helpers ─────────────────────────────────────────────────────

function usePersisted<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      localStorage.setItem(key, JSON.stringify(next));
      return next;
    });
  }, [key]);
  return [value, set];
}

// ── Status badge (dot + label) ────────────────────────────────────────────────

function AgentStatusBadge({ status }: { status: MonitorStatus | 'suspended' | undefined }) {
  const cfg: Record<string, { dot: string; text: string; label: string }> = {
    up:          { dot: 'bg-green-500',  text: 'text-green-400',  label: 'UP'       },
    down:        { dot: 'bg-red-500',    text: 'text-red-400',    label: 'DOWN'     },
    alert:       { dot: 'bg-orange-500', text: 'text-orange-400', label: 'ALERT'    },
    inactive:    { dot: 'bg-gray-400',   text: 'text-gray-400',   label: 'OFFLINE'  },
    suspended:   { dot: 'bg-gray-500',   text: 'text-gray-500',   label: 'PAUSED'   },
    paused:      { dot: 'bg-gray-500',   text: 'text-gray-500',   label: 'PAUSED'   },
    pending:     { dot: 'bg-yellow-500', text: 'text-yellow-400', label: 'PENDING'  },
    ssl_warning: { dot: 'bg-yellow-400', text: 'text-yellow-400', label: 'WARN'     },
    ssl_expired: { dot: 'bg-red-500',    text: 'text-red-400',    label: 'EXPIRED'  },
  };
  const s = cfg[status ?? ''] ?? { dot: 'bg-gray-400', text: 'text-gray-400', label: '···' };
  return (
    <span className="flex items-center gap-1 shrink-0">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
      <span className={`text-[9px] font-semibold leading-none ${s.text}`}>{s.label}</span>
    </span>
  );
}

// ── Draggable Agent Device Item ───────────────────────────────────────────────

function DraggableDeviceItem({
  device,
  monitorStatus,
  indent = false,
}: {
  device: AgentDevice;
  monitorStatus: MonitorStatus | undefined;
  indent?: boolean;
}) {
  const location = useLocation();
  const isActive = location.pathname === `/agents/${device.id}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `agent-device-${device.id}`,
    data: { type: 'agent-device', device },
  });

  const displayName = device.name ?? device.hostname;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ opacity: isDragging ? 0.4 : 1, paddingLeft: indent ? '24px' : undefined }}
    >
      <Link
        to={`/agents/${device.id}`}
        className={cn(
          'flex items-center gap-2 rounded-md py-1 text-sm transition-colors',
          indent ? '' : 'px-2',
          isActive
            ? 'bg-bg-active text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        )}
        onClick={e => {
          // Prevent navigation when dragging
          if (isDragging) e.preventDefault();
        }}
      >
        <AgentStatusBadge status={device.status === 'suspended' ? 'suspended' : monitorStatus} />
        <span className="truncate flex-1 text-xs">{displayName}</span>
      </Link>
    </div>
  );
}

// ── Droppable Group Header ─────────────────────────────────────────────────────

function DroppableGroupHeader({
  groupId,
  children,
}: {
  groupId: number | null;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: groupId === null ? 'drop-agent-ungrouped' : `drop-agent-group-${groupId}`,
    data: { type: 'agent-group', groupId },
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-md transition-colors',
        isOver && 'ring-1 ring-accent bg-accent/10',
      )}
    >
      {children}
    </div>
  );
}

// ── Nav items ────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const { user, isAdmin, canCreate } = useAuthStore();

  const topNavItems: NavItem[] = [
    { label: t('nav.dashboard'), path: '/', icon: <LayoutDashboard size={18} /> },
  ];

  const adminNavItems: NavItem[] = [
    { label: t('nav.groups'),        path: '/groups',               icon: <FolderTree size={18} />,    adminOnly: true },
    { label: t('nav.notifications'), path: '/notifications',        icon: <Bell size={18} />,          adminOnly: true },
    { label: t('nav.users'),         path: '/admin/users',          icon: <Users size={18} />,         adminOnly: true },
    { label: t('nav.agents'),        path: '/admin/agents',         icon: <Cpu size={18} />,           adminOnly: true },
    { label: t('nav.remediations'),  path: '/admin/remediations',   icon: <ShieldCheck size={18} />,   adminOnly: true },
    { label: t('nav.maintenance'),   path: '/admin/maintenance',    icon: <CalendarClock size={18} />, adminOnly: true },
    { label: t('nav.importExport'),  path: '/admin/import-export',  icon: <PackageOpen size={18} />,   adminOnly: true },
    { label: t('nav.settings'),      path: '/settings',             icon: <Settings size={18} />,      adminOnly: true },
  ];
  const { openAddAgentModal } = useUiStore();
  const { fetchMonitors, monitors } = useMonitorStore();
  const { tree } = useGroupStore();

  const [approvedDevices, setApprovedDevices] = useState<AgentDevice[]>([]);
  // Real-time UP/ALERT/DOWN/INACTIVE status received via AGENT_STATUS_CHANGED events.
  // Keyed by deviceId. Overrides the monitorStore lookup (which requires agentDeviceId
  // to be populated in the store — not always reliable).
  const [deviceStatuses, setDeviceStatuses] = useState<Map<number, string>>(new Map());

  const [search, setSearch] = useState('');

  // Layout preferences
  const [sidebarLayout, setSidebarLayout] = usePersisted<'stacked' | 'side-by-side'>('sidebar-layout', 'stacked');
  const [showMonitors, setShowMonitors] = usePersisted<boolean>('sidebar-show-monitors', true);
  const [showAgents, setShowAgents] = usePersisted<boolean>('sidebar-show-agents', true);
  // Split column width: percent of the split container assigned to the Monitors column (20–80)
  const [splitPercent, setSplitPercent] = usePersisted<number>('sidebar-split-percent', 50);
  const [adminMenuOpen, setAdminMenuOpen] = usePersisted<boolean>('sidebar:admin-open', true);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // Agent groups (kind='agent')
  const agentGroups = tree.filter(n => n.kind === 'agent');
  const admin = isAdmin();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  useEffect(() => {
    fetchMonitors();
  }, [fetchMonitors]);

  // Fetch approved+suspended devices for sidebar (admin only)
  const loadDevices = useCallback(() => {
    if (!admin) return;
    Promise.all([
      agentApi.listDevices('approved'),
      agentApi.listDevices('suspended'),
    ])
      .then(([approved, suspended]) => setApprovedDevices([...approved, ...suspended]))
      .catch(() => {});
  }, [admin]);

  useEffect(() => {
    loadDevices();
    const id = setInterval(loadDevices, 30000);
    return () => clearInterval(id);
  }, [loadDevices]);

  // Real-time sidebar updates: name/status/group changes without polling delay
  useEffect(() => {
    if (!admin) return;
    const socket = getSocket();
    if (!socket) return;

    const onDeviceUpdated = (data: {
      deviceId: number;
      name: string | null;
      hostname: string;
      status: AgentDevice['status'];
      groupId: number | null;
    }) => {
      setApprovedDevices(prev => {
        const isTracked = prev.some(d => d.id === data.deviceId);
        if (!isTracked) {
          // Newly approved device — trigger a full refresh to get all fields
          loadDevices();
          return prev;
        }
        // Filter out devices that are no longer approved/suspended
        if (data.status !== 'approved' && data.status !== 'suspended') {
          return prev.filter(d => d.id !== data.deviceId);
        }
        // Update in-place: name, hostname, status, group
        return prev.map(d =>
          d.id === data.deviceId
            ? { ...d, name: data.name, hostname: data.hostname, status: data.status, groupId: data.groupId }
            : d,
        );
      });
    };

    const onStatusChanged = (data: { deviceId: number; status: string }) => {
      setDeviceStatuses(prev => new Map(prev).set(data.deviceId, data.status));
    };

    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onStatusChanged);
    return () => {
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onStatusChanged);
    };
  }, [admin, loadDevices]);

  /** Get the real-time monitor status for an agent device.
   *  Prefers the AGENT_STATUS_CHANGED socket Map (always up-to-date),
   *  falls back to monitorStore lookup (populated on initial load). */
  const getMonitorStatus = useCallback(
    (deviceId: number): MonitorStatus | undefined => {
      // Direct socket-pushed status (most reliable, no agentDeviceId dependency)
      const live = deviceStatuses.get(deviceId);
      if (live) return live as MonitorStatus;
      // Fallback: scan monitorStore for a monitor with matching agentDeviceId
      for (const m of monitors.values()) {
        if (m.agentDeviceId === deviceId) return m.status;
      }
      return undefined;
    },
    [deviceStatuses, monitors],
  );

  const handleAgentDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const dragData = active.data.current;
      const dropData = over.data.current;

      if (dragData?.type !== 'agent-device' || dropData?.type !== 'agent-group') return;

      const device = dragData.device as AgentDevice;
      const targetGroupId = dropData.groupId as number | null;

      if (device.groupId === targetGroupId) return;

      try {
        await agentApi.updateDevice(device.id, { groupId: targetGroupId });
        loadDevices();
        toast.success('Agent moved');
      } catch {
        toast.error('Failed to move agent');
      }
    },
    [loadDevices],
  );

  // ── Split column resize ───────────────────────────────────────────────────
  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const handleMouseMove = (ev: MouseEvent) => {
      if (!splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = Math.round(((ev.clientX - rect.left) / rect.width) * 100);
      setSplitPercent(Math.max(20, Math.min(80, pct)));
    };
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [setSplitPercent]);

  // ── Agent section render helper ──────────────────────────────────────────
  // hideHeader=true when used as a split column (the column title acts as header)
  const renderAgentContent = (hideHeader = false) => !admin ? null : (
    <DndContext sensors={sensors} onDragEnd={handleAgentDragEnd}>
      <div className={hideHeader ? '' : 'mt-2 pt-2 border-t border-border'}>
        {!hideHeader && (
        <div className="px-2 py-1 flex items-center gap-1.5 text-xs font-medium text-text-muted uppercase tracking-wider">
          <Server size={12} />
          {t('groups.agentGroup')}
        </div>)}

        {/* Grouped devices */}
        {agentGroups.map(group => {
          const isGroupActive = location.pathname === `/group/${group.id}`;
          const groupDevices = approvedDevices.filter(d => d.groupId === group.id);
          return (
            <DroppableGroupHeader key={group.id} groupId={group.id}>
              <Link
                to={`/group/${group.id}`}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors',
                  isGroupActive
                    ? 'bg-bg-active text-text-primary'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                <Server size={14} className="shrink-0 text-text-muted" />
                <span className="truncate flex-1">{group.name}</span>
                {groupDevices.length > 0 && (
                  <span className="text-xs text-text-muted">{groupDevices.length}</span>
                )}
              </Link>
              {groupDevices.map(device => (
                <DraggableDeviceItem
                  key={device.id}
                  device={device}
                  monitorStatus={getMonitorStatus(device.id)}
                  indent
                />
              ))}
            </DroppableGroupHeader>
          );
        })}

        {/* Ungrouped devices */}
        {approvedDevices.filter(d => d.groupId === null).length > 0 && (
          <DroppableGroupHeader groupId={null}>
            {approvedDevices.filter(d => d.groupId === null).map(device => (
              <DraggableDeviceItem
                key={device.id}
                device={device}
                monitorStatus={getMonitorStatus(device.id)}
              />
            ))}
          </DroppableGroupHeader>
        )}
      </div>
    </DndContext>
  );

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-bg-secondary">
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-border px-4">
        <Link to="/" className="flex items-center gap-2">
          <img src="/logo.webp" alt="Obliview" className="h-8 w-8 rounded-lg" />
          <span className="text-lg font-semibold text-text-primary">Obliview</span>
        </Link>
      </div>

      {/* Add Monitor / Add Agent buttons */}
      {canCreate() && (
        <div className="px-3 pt-3 flex gap-2">
          <Link
            to="/monitor/new"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <Plus size={14} />
            {t('common.monitor')}
          </Link>
          <button
            onClick={openAddAgentModal}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <Plus size={14} />
            {t('common.agent')}
          </button>
        </div>
      )}

      {/* Search */}
      <div className="px-3 py-3">
        <input
          type="text"
          placeholder={t('common.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Filter chips + layout toggle — stacked mode only */}
      {admin && agentGroups.length > 0 && sidebarLayout === 'stacked' && (
        <div className="flex items-center justify-between px-3 pb-1.5 gap-2">
          <div className="flex gap-1">
            <button
              onClick={() => setShowMonitors(v => !v)}
              className={cn(
                'text-xs px-2 py-0.5 rounded-full border transition-colors',
                showMonitors
                  ? 'bg-accent/20 border-accent text-accent'
                  : 'border-border text-text-muted hover:text-text-secondary',
              )}
            >
              {t('importExport.monitors')}
            </button>
            <button
              onClick={() => setShowAgents(v => !v)}
              className={cn(
                'text-xs px-2 py-0.5 rounded-full border transition-colors',
                showAgents
                  ? 'bg-accent/20 border-accent text-accent'
                  : 'border-border text-text-muted hover:text-text-secondary',
              )}
            >
              {t('nav.agents')}
            </button>
          </div>
          <button
            onClick={() => setSidebarLayout('side-by-side')}
            title="Switch to side-by-side"
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
          >
            <ArrowLeftRight size={13} />
          </button>
        </div>
      )}

      {/* Content area — stacked or side-by-side */}
      {sidebarLayout === 'side-by-side' && admin && agentGroups.length > 0 ? (
        <div ref={splitContainerRef} className="flex flex-row flex-1 overflow-hidden min-h-0">

          {/* ── Monitors column ── */}
          <div className="flex flex-col overflow-hidden min-w-0" style={{ width: `${splitPercent}%` }}>
            {/* Column header */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0">
              <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">{t('importExport.monitors')}</span>
            </div>
            <div className="flex-1 overflow-y-auto px-2 min-h-0">
              <GroupTree searchQuery={search} />
            </div>
          </div>

          {/* ── Resize handle ── */}
          <div
            onMouseDown={handleSplitMouseDown}
            className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-accent/50 active:bg-accent/70 transition-colors"
          />

          {/* ── Agents column ── */}
          <div className="flex flex-col flex-1 overflow-hidden min-w-0">
            {/* Column header */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
              <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">{t('nav.agents')}</span>
              <button
                onClick={() => setSidebarLayout('stacked')}
                title="Switch to stacked"
                className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
              >
                <ArrowLeftRight size={12} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 min-h-0">
              {renderAgentContent(true)}
            </div>
          </div>

        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2">
          {showMonitors && <GroupTree searchQuery={search} />}
          {showAgents && renderAgentContent(false)}
        </div>
      )}

      {/* Navigation */}
      <nav className="border-t border-border p-2 pb-0">
        {topNavItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Admin section collapsible divider */}
      {admin && (
        <>
          <button
            onClick={() => setAdminMenuOpen(v => !v)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-text-muted hover:text-text-secondary transition-colors"
          >
            <div className="flex-1 h-px bg-border" />
            <ChevronDown size={12} className={cn('transition-transform duration-200', !adminMenuOpen && '-rotate-90')} />
            <div className="flex-1 h-px bg-border" />
          </button>

          {adminMenuOpen && (
            <nav className="p-2 pt-0">
              {adminNavItems
                .filter((item) => !item.adminOnly || isAdmin())
                .map((item) => {
                  const isActive = location.pathname === item.path;
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                        isActive
                          ? 'bg-bg-active text-text-primary'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                      )}
                    >
                      {item.icon}
                      {item.label}
                    </Link>
                  );
                })}
            </nav>
          )}
        </>
      )}

      {/* User section */}
      <div className="border-t border-border p-2">
        <Link
          to="/profile"
          className={cn(
            'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
            location.pathname === '/profile'
              ? 'bg-bg-active text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          <UserCircle size={18} />
          <span className="truncate flex-1">{user?.displayName || user?.username}</span>
        </Link>
        <button
          onClick={() => {
            useAuthStore.getState().logout();
          }}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <LogOut size={18} />
          {t('nav.signOut')}
        </button>
      </div>
    </aside>
  );
}
