import { useCallback, useEffect, useState } from 'react';
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
  UserCircle,
  LogOut,
  Cpu,
  Server,
  PackageOpen,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  GripVertical,
  Pin,
  PinOff,
  Network,
  Shield,
  ScanSearch,
  Building2,
  Plus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import { useGroupStore } from '@/store/groupStore';
import { useUiStore } from '@/store/uiStore';
import { agentApi } from '@/api/agent.api';
import { getSocket } from '@/socket/socketClient';
import type { AgentDevice, MonitorStatus, GroupTreeNode } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import { groupsApi } from '@/api/groups.api';
import { anonHostname, anonUsername } from '@/utils/anonymize';
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
    up:          { dot: 'bg-green-500',               text: 'text-green-400',  label: 'UP'       },
    down:        { dot: 'bg-red-500',                 text: 'text-red-400',    label: 'DOWN'     },
    alert:       { dot: 'bg-orange-500',              text: 'text-orange-400', label: 'ALERT'    },
    inactive:    { dot: 'bg-gray-400',                text: 'text-gray-400',   label: 'OFFLINE'  },
    suspended:   { dot: 'bg-gray-500',                text: 'text-gray-500',   label: 'PAUSED'   },
    paused:      { dot: 'bg-gray-500',                text: 'text-gray-500',   label: 'PAUSED'   },
    pending:     { dot: 'bg-yellow-500',              text: 'text-yellow-400', label: 'PENDING'  },
    ssl_warning: { dot: 'bg-yellow-400',              text: 'text-yellow-400', label: 'WARN'     },
    ssl_expired: { dot: 'bg-red-500',                 text: 'text-red-400',    label: 'EXPIRED'  },
    updating:    { dot: 'bg-blue-500 animate-pulse',  text: 'text-blue-400',   label: 'UPDATE'   },
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
  depth = 0,
}: {
  device: AgentDevice;
  monitorStatus: MonitorStatus | undefined;
  depth?: number;
}) {
  const location = useLocation();
  const isActive = location.pathname === `/agents/${device.id}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `agent-device-${device.id}`,
    data: { type: 'agent-device', device },
  });

  const displayName = device.name ?? device.hostname;
  const effectiveStatus = device.status === 'suspended' ? 'suspended' : monitorStatus;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ opacity: isDragging ? 0.4 : 1, paddingLeft: `${depth * 14}px` }}
    >
      <Link
        to={`/agents/${device.id}`}
        data-status={effectiveStatus ?? 'inactive'}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors',
          isActive
            ? 'bg-bg-active text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        )}
        onClick={e => {
          if (isDragging) e.preventDefault();
        }}
      >
        <AgentStatusBadge status={effectiveStatus} />
        <span className="truncate flex-1">{anonHostname(displayName)}</span>
      </Link>
    </div>
  );
}

// ── Recursive Agent Group Section ─────────────────────────────────────────────

function AgentGroupSection({
  group,
  devices,
  depth,
  getMonitorStatus,
}: {
  group: GroupTreeNode;
  devices: AgentDevice[];
  depth: number;
  getMonitorStatus: (id: number) => MonitorStatus | undefined;
}) {
  const location = useLocation();
  const [expanded, setExpanded] = usePersisted<boolean>(`sidebar:group-${group.id}-open`, true);

  const isGroupActive = location.pathname === `/group/${group.id}`;
  const groupDevices  = devices.filter(d => d.groupId === group.id);
  const hasContent    = group.children.length > 0 || groupDevices.length > 0;

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-agent-group-${group.id}`,
    data: { type: 'agent-group', groupId: group.id },
  });

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `drag-agent-group-${group.id}`,
    data: { type: 'agent-group-drag', group },
  });

  return (
    <div
      ref={setDropRef}
      className={cn(
        'rounded-md transition-colors',
        isOver && 'ring-1 ring-accent bg-accent/10',
        isDragging && 'opacity-40',
      )}
    >
      <div
        className="flex items-center gap-0.5 group/row"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        <div
          ref={setDragRef}
          {...attributes}
          {...listeners}
          className="cursor-grab p-1 text-text-muted opacity-0 group-hover/row:opacity-50 hover:!opacity-100 shrink-0 transition-opacity"
          title="Drag to reparent group"
        >
          <GripVertical size={10} />
        </div>

        <button
          onClick={() => setExpanded(v => !v)}
          className={cn(
            'p-0.5 text-text-muted hover:text-text-primary shrink-0 transition-colors',
            !hasContent && 'invisible pointer-events-none',
          )}
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>

        <Link
          to={`/group/${group.id}`}
          className={cn(
            'flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors',
            isGroupActive
              ? 'bg-bg-active text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          <Server size={13} className="shrink-0 text-text-muted" />
          <span className="truncate flex-1 font-medium">{anonHostname(group.name)}</span>
          {groupDevices.length > 0 && (
            <span className="text-xs font-mono text-text-muted">{groupDevices.length}</span>
          )}
        </Link>
      </div>

      {expanded && (
        <>
          {group.children.map(child => (
            <AgentGroupSection
              key={child.id}
              group={child}
              devices={devices}
              depth={depth + 1}
              getMonitorStatus={getMonitorStatus}
            />
          ))}
          {groupDevices.map(device => (
            <DraggableDeviceItem
              key={device.id}
              device={device}
              monitorStatus={getMonitorStatus(device.id)}
              depth={depth + 1}
            />
          ))}
        </>
      )}
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
  const { user, isAdmin } = useAuthStore();

  const navItems: NavItem[] = [
    { label: t('nav.dashboard'),        path: '/',                       icon: <LayoutDashboard size={18} /> },
    { label: t('nav.netmap'),           path: '/netmap',                  icon: <Network size={18} /> },
    { label: t('nav.ipReputation'),     path: '/ip-reputation',           icon: <Shield size={18} /> },
    { label: t('nav.groups'),           path: '/groups',                  icon: <FolderTree size={18} />,   adminOnly: true },
    { label: t('nav.notifications'),    path: '/notifications',           icon: <Bell size={18} />,         adminOnly: true },
    { label: t('nav.serviceTemplates'), path: '/admin/service-templates', icon: <ScanSearch size={18} />,   adminOnly: true },
    { label: t('nav.workspaces'),        path: '/admin/tenants',           icon: <Building2 size={18} />,    adminOnly: true },
    { label: t('nav.users'),            path: '/admin/users',             icon: <Users size={18} />,        adminOnly: true },
    { label: t('nav.agents'),           path: '/admin/agents',            icon: <Cpu size={18} />,          adminOnly: true },
    { label: t('nav.importExport'),     path: '/admin/import-export',     icon: <PackageOpen size={18} />,  adminOnly: true },
    { label: t('nav.settings'),         path: '/settings',                icon: <Settings size={18} />,     adminOnly: true },
  ];

  const {
    openAddAgentModal,
    sidebarFloating,
    toggleSidebarFloating,
    sidebarCollapsed,
    toggleSidebarCollapsed,
  } = useUiStore();
  const { tree, fetchTree } = useGroupStore();

  const [approvedDevices, setApprovedDevices] = useState<AgentDevice[]>([]);
  const [deviceStatuses, setDeviceStatuses] = useState<Map<number, string>>(new Map());

  const [search, setSearch] = useState('');
  const [adminMenuOpen, setAdminMenuOpen] = usePersisted<boolean>('sidebar:admin-open', true);

  const agentGroups = tree.filter(n => n.kind === 'agent');
  const admin = isAdmin();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

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
          loadDevices();
          return prev;
        }
        if (data.status !== 'approved' && data.status !== 'suspended') {
          return prev.filter(d => d.id !== data.deviceId);
        }
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

  const getMonitorStatus = useCallback(
    (deviceId: number): MonitorStatus | undefined => {
      const live = deviceStatuses.get(deviceId);
      if (live) return live as MonitorStatus;
      return undefined;
    },
    [deviceStatuses],
  );

  const handleAgentDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const dragData = active.data.current;
      const dropData = over.data.current;

      if (dragData?.type === 'agent-device' && dropData?.type === 'agent-group') {
        const device       = dragData.device as AgentDevice;
        const targetGroupId = dropData.groupId as number | null;
        if (device.groupId === targetGroupId) return;
        try {
          await agentApi.updateDevice(device.id, { groupId: targetGroupId });
          loadDevices();
          toast.success('Agent moved');
        } catch {
          toast.error('Failed to move agent');
        }
        return;
      }

      if (dragData?.type === 'agent-group-drag' && dropData?.type === 'agent-group') {
        const group        = dragData.group as GroupTreeNode;
        const targetGroupId = dropData.groupId as number | null;
        if (group.id === targetGroupId) return;
        try {
          await groupsApi.move(group.id, targetGroupId);
          void fetchTree();
          loadDevices();
          toast.success('Group moved');
        } catch {
          toast.error('Failed to move group');
        }
      }
    },
    [loadDevices, fetchTree],
  );

  const filteredNavItems = navItems.filter(item => {
    if (item.adminOnly && !admin) return false;
    if (!search) return true;
    return item.label.toLowerCase().includes(search.toLowerCase());
  });

  const filteredDevices = search
    ? approvedDevices.filter(d =>
        (d.name ?? d.hostname).toLowerCase().includes(search.toLowerCase()),
      )
    : approvedDevices;

  const ungroupedDevices = filteredDevices.filter(d => d.groupId === null);

  const renderAgentContent = () => !admin ? null : (
    <DndContext sensors={sensors} onDragEnd={handleAgentDragEnd}>
      <div className="mt-2 pt-2 border-t border-border">
        <div className="px-2 py-1.5 flex items-center gap-2 text-[11px] font-mono font-medium text-text-muted uppercase tracking-[0.12em]">
          <Server size={12} />
          {t('groups.agentGroup')}
        </div>

        {agentGroups.map(group => (
          <AgentGroupSection
            key={group.id}
            group={group}
            devices={filteredDevices}
            depth={0}
            getMonitorStatus={getMonitorStatus}
          />
        ))}

        {ungroupedDevices.length > 0 && (
          <DroppableGroupHeader groupId={null}>
            <div className="px-2 py-0.5 mt-1 text-[10px] font-medium text-text-muted uppercase tracking-wider">
              Ungrouped
            </div>
            {ungroupedDevices.map(device => (
              <DraggableDeviceItem
                key={device.id}
                device={device}
                monitorStatus={getMonitorStatus(device.id)}
                depth={0}
              />
            ))}
          </DroppableGroupHeader>
        )}
      </div>
    </DndContext>
  );

  const topNav = filteredNavItems.filter(item => !item.adminOnly);
  const adminNav = filteredNavItems.filter(item => item.adminOnly);

  // ── Collapsed mode (Obli Design v1) — 64 px icon-only column ─────────────
  if (sidebarCollapsed) {
    const allItems = [...topNav, ...adminNav];
    return (
      <aside className="flex h-full w-16 shrink-0 flex-col bg-bg-secondary">
        <div className="flex h-12 shrink-0 items-center justify-center">
          <button
            onClick={toggleSidebarCollapsed}
            title={t('nav.expandSidebar', 'Expand sidebar')}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ChevronsRight size={16} />
          </button>
        </div>

        {admin && (
          <div className="px-2 pt-1">
            <button
              onClick={openAddAgentModal}
              title={t('nav.addAgent', 'Add agent')}
              className="flex h-10 w-full items-center justify-center rounded-md bg-accent/12 text-accent transition-colors hover:bg-accent/20"
            >
              <Plus size={16} />
            </button>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-2 pt-3 space-y-1">
          {allItems.map((item) => {
            const isActive = location.pathname === item.path
              || (item.path !== '/' && location.pathname.startsWith(item.path + '/'));
            return (
              <Link
                key={item.path}
                to={item.path}
                title={item.label}
                className={cn(
                  'relative flex h-10 w-full items-center justify-center rounded-md transition-colors',
                  isActive
                    ? 'bg-accent/12 text-accent'
                    : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                {item.icon}
              </Link>
            );
          })}
        </nav>

        <div className="p-2 space-y-1">
          <Link
            to="/profile"
            title={anonUsername(user?.displayName || (user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username))}
            className={cn(
              'flex h-10 w-full items-center justify-center rounded-md transition-colors',
              location.pathname === '/profile'
                ? 'bg-bg-active text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {user?.avatar ? (
              <img src={user.avatar} alt="" className="w-6 h-6 rounded-full object-cover" />
            ) : (
              <UserCircle size={18} />
            )}
          </Link>
          <button
            onClick={() => useAuthStore.getState().logout()}
            title={t('nav.signOut')}
            className="flex h-10 w-full items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
    );
  }

  // ── Expanded mode ───────────────────────────────────────────────────────────
  return (
    <aside className="flex h-full w-full flex-col bg-bg-secondary">

      {/* Sidebar head — collapse + float/pin toggles only. The logo and
          tenant selector live in the topbar (Header.tsx) so they remain
          visible when the sidebar is collapsed or floating. */}
      <div className="flex h-9 shrink-0 items-center justify-end px-3 pt-2">
        <div className="flex items-center gap-1">
          {!sidebarFloating && (
            <button
              onClick={toggleSidebarCollapsed}
              title={t('nav.collapseSidebar', 'Collapse sidebar')}
              className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <ChevronsLeft size={15} />
            </button>
          )}
          <button
            onClick={toggleSidebarFloating}
            title={sidebarFloating ? t('nav.pinSidebar', 'Pin sidebar') : t('nav.floatSidebar', 'Float sidebar (auto-hide)')}
            className={cn(
              'p-1.5 rounded transition-colors',
              sidebarFloating
                ? 'text-accent hover:text-accent hover:bg-accent/10'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
            )}
          >
            {sidebarFloating ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
        </div>
      </div>

      {/* Add agent button — accent pill */}
      {admin && (
        <div className="px-3 pt-2">
          <button
            onClick={openAddAgentModal}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-accent/12 hover:bg-accent/20 px-3 py-2 text-[13px] font-medium text-accent transition-colors"
          >
            <Plus size={15} />
            {t('nav.addAgent', 'Add agent')}
          </button>
        </div>
      )}

      {/* Search */}
      <div className="px-3 py-2.5">
        <input
          type="text"
          placeholder={t('common.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Main nav + agents */}
      <div className="flex-1 overflow-y-auto px-2 min-h-0">
        <nav>
          {topNav.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-[14px] transition-colors',
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

        {renderAgentContent()}
      </div>

      {/* Admin section collapsible */}
      {admin && adminNav.length > 0 && (
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
              {adminNav.map((item) => {
                const isActive = location.pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-[14px] transition-colors',
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
          {user?.avatar ? (
            <img src={user.avatar} alt="" className="w-[20px] h-[20px] rounded-full object-cover" />
          ) : (
            <UserCircle size={18} />
          )}
          <span className="truncate flex-1">{anonUsername(user?.displayName || (user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username))}</span>
        </Link>
        <button
          onClick={() => useAuthStore.getState().logout()}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <LogOut size={18} />
          {t('nav.signOut')}
        </button>
      </div>
    </aside>
  );
}
