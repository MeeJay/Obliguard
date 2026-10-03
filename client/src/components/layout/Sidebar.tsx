import { useCallback, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
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
  LogOut,
  Cpu,
  Server,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  GripVertical,
  Pin,
  PinOff,
  Network,
  Shield,
  ShieldCheck,
  Building2,
  Plus,
  Activity,
  KeyRound,
  ScrollText,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import { useGroupStore } from '@/store/groupStore';
import { useUiStore, useEffectiveSidebar } from '@/store/uiStore';
import { useTenantStore } from '@/store/tenantStore';
import { useAgentStore, useAgentDevices } from '@/store/agentStore';
import { agentApi } from '@/api/agent.api';
import type { AgentDevice, GroupTreeNode } from '@obliview/shared';
import { groupsApi } from '@/api/groups.api';
import { anonHostname, anonUsername } from '@/utils/anonymize';
import { UserAvatar } from '@/components/common/UserAvatar';
import { IconButton } from '@/components/common/IconButton';
import { AgentStatusBadge, resolveAgentStatus, type AgentStatusKey } from '@/components/status/AgentStatusBadge';
import { useCan, useIsPlatformAdmin } from '@/hooks/usePermission';
import { useIsMasterTenant, MASTER_TENANT_ID } from '@/hooks/useIsMasterTenant';
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
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, [key]);
  return [value, set];
}

// ── Drawer UI cache ──────────────────────────────────────────────────────────
// Below 1024 px the Sidebar lives in the off-canvas Drawer (AppLayout), which
// unmounts it when closed, and the drawer closes on every navigation. The
// search text and the tree scroll position are kept here (keyed by user +
// tenant) so a re-opened drawer shows the tree where the user left it
// (Obliance Sidebar drawerUiCache). Device data needs no cache: it lives in
// the agent store.
let drawerUiCache: { key: string; search: string; scrollTop: number } | null = null;

function rememberDrawerUi(key: string, patch: Partial<{ search: string; scrollTop: number }>) {
  const base = drawerUiCache?.key === key ? drawerUiCache : { key, search: '', scrollTop: 0 };
  drawerUiCache = { ...base, ...patch };
}

// ── Agent status + ordering ──────────────────────────────────────────────────

/**
 * Sidebar status of a device: the shared AgentStatusBadge resolution, with the
 * last live AGENT_STATUS_CHANGED applied on top (a transient 'updating', or a
 * presence flip the device row has not received yet).
 */
function sidebarStatus(device: AgentDevice, live: string | undefined): AgentStatusKey {
  if (live === 'updating' && device.status === 'approved') return 'updating';
  const wsConnected = live === 'up' ? true
    : live === 'down' || live === 'inactive' ? false
      : device.wsConnected;
  return resolveAgentStatus({ ...device, wsConnected });
}

/** Problem agents first, then transitional states, then healthy, then paused. */
const STATUS_TIER: Record<AgentStatusKey, number> = {
  offline: 0,
  update_failed: 0,
  misconfigured: 0,
  refused: 0,
  updating: 1,
  pending: 1,
  evaluate_only: 2,
  online: 2,
  suspended: 3,
};

// ── Draggable Agent Device Item ───────────────────────────────────────────────

function DraggableDeviceItem({
  device,
  statusKey,
  canDrag,
  depth = 0,
}: {
  device: AgentDevice;
  statusKey: AgentStatusKey;
  canDrag: boolean;
  depth?: number;
}) {
  const location = useLocation();
  const isActive = location.pathname === `/agents/${device.id}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `agent-device-${device.id}`,
    data: { type: 'agent-device', device },
    disabled: !canDrag,
  });

  const displayName = device.name ?? device.hostname;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ opacity: isDragging ? 0.4 : 1, paddingLeft: `${depth * 14}px` }}
    >
      <Link
        to={`/agents/${device.id}`}
        data-status={statusKey}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors coarse:py-2.5',
          isActive
            ? 'bg-bg-active text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        )}
        onClick={e => {
          if (isDragging) e.preventDefault();
        }}
      >
        <span className="truncate flex-1">{anonHostname(displayName)}</span>
        <AgentStatusBadge status={statusKey} size="sm" showEvaluateOnly={false} className="shrink-0" />
      </Link>
    </div>
  );
}

// ── Recursive Agent Group Section ─────────────────────────────────────────────

function AgentGroupSection({
  group,
  devices,
  depth,
  getStatus,
  canDragAgents,
  canDragGroups,
}: {
  group: GroupTreeNode;
  devices: AgentDevice[];
  depth: number;
  getStatus: (device: AgentDevice) => AgentStatusKey;
  canDragAgents: boolean;
  canDragGroups: boolean;
}) {
  const { t } = useTranslation();
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
    disabled: !canDragGroups,
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
        {canDragGroups ? (
          <div
            ref={setDragRef}
            {...attributes}
            {...listeners}
            className="cursor-grab p-1 text-text-muted opacity-0 group-hover/row:opacity-50 hover:!opacity-100 shrink-0 transition-opacity coarse:opacity-50 coarse:p-2"
            title={t('nav.dragGroup', 'Drag to reparent group')}
          >
            <GripVertical size={10} />
          </div>
        ) : (
          <div ref={setDragRef} className="w-[18px] shrink-0" />
        )}

        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          aria-label={expanded
            ? t('nav.collapseGroup', { name: group.name, defaultValue: 'Collapse {{name}}' })
            : t('nav.expandGroup', { name: group.name, defaultValue: 'Expand {{name}}' })}
          className={cn(
            'relative p-0.5 text-text-muted hover:text-text-primary shrink-0 transition-colors',
            // Touch: an invisible 40 px hit area around the 10 px chevron.
            "coarse:after:absolute coarse:after:left-1/2 coarse:after:top-1/2 coarse:after:h-10 coarse:after:w-10 coarse:after:-translate-x-1/2 coarse:after:-translate-y-1/2 coarse:after:content-['']",
            !hasContent && 'invisible pointer-events-none',
          )}
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>

        <Link
          to={`/group/${group.id}`}
          className={cn(
            'flex flex-1 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors coarse:py-2.5',
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
              getStatus={getStatus}
              canDragAgents={canDragAgents}
              canDragGroups={canDragGroups}
            />
          ))}
          {groupDevices.map(device => (
            <DraggableDeviceItem
              key={device.id}
              device={device}
              statusKey={getStatus(device)}
              canDrag={canDragAgents}
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
  tenantId,
  children,
}: {
  groupId: number | null;
  /** God-view bucket the header belongs to (one "Ungrouped" drop zone per tenant). */
  tenantId?: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: groupId === null ? `drop-agent-ungrouped-${tenantId ?? 'all'}` : `drop-agent-group-${groupId}`,
    data: { type: 'agent-group', groupId, tenantId },
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
  /**
   * Visibility predicate, already resolved (capability, platform admin,
   * master tenant). Mirrors the route guard in App.tsx: an item is shown only
   * when its page would let the user in.
   */
  visible: boolean;
  /** Optional red pill with a pending-work count next to the label. */
  badgeCount?: number;
}

/** Active on the exact path, or on a sub-path (prefix match, never for '/'). */
function isNavActive(pathname: string, path: string): boolean {
  return pathname === path || (path !== '/' && pathname.startsWith(path + '/'));
}

function NavBadge({ count }: { count: number }) {
  return (
    <span className="shrink-0 min-w-[1.25rem] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 text-[10px] font-semibold text-center">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function NavLink({ item }: { item: NavItem }) {
  const location = useLocation();
  const isActive = isNavActive(location.pathname, item.path);
  return (
    <Link
      to={item.path}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-[14px] transition-colors coarse:py-2.5',
        isActive
          ? 'bg-bg-active text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
      )}
    >
      {item.icon}
      <span className="flex-1 truncate">{item.label}</span>
      {item.badgeCount !== undefined && item.badgeCount > 0 && <NavBadge count={item.badgeCount} />}
    </Link>
  );
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

interface SidebarProps {
  /**
   * 'drawer' = rendered inside the phone / tablet off-canvas Drawer
   * (AppLayout, < 1024 px): always expanded with full labels, a close button
   * instead of the collapse / float toggles. Default: the desktop column.
   */
  variant?: 'default' | 'drawer';
  /** Drawer variant: close the drawer (before opening a modal, etc.). */
  onRequestClose?: () => void;
}

export function Sidebar({ variant = 'default', onRequestClose }: SidebarProps = {}) {
  const { t } = useTranslation();
  const inDrawer = variant === 'drawer';
  const location = useLocation();
  const user = useAuthStore(s => s.user);
  // Role in the current tenant (permission-set slug); platform role as fallback.
  const tenantRole = useAuthStore(s => s.permissions?.tenantRole ?? null);

  // ── Permissions (same capabilities as the App.tsx route guards) ──────────
  const isPlatformAdmin = useIsPlatformAdmin();
  const isMaster = useIsMasterTenant();
  const canManageAgents = useCan('agents.manage');
  const canApproveAgents = useCan('agents.approve');
  const canAddAgent = useCan('agents.keys');
  const canSeeAgentAdmin = useCan(['agents.keys', 'agents.approve', 'agents.manage']);
  const canManageGroups = useCan('groups.manage');
  // Policies hub: any of its tabs (service templates, network limits, remote
  // blocklists), the same any-of set as the /policies route guard.
  const canSeeTemplates = useCan(['templates.write', 'ips.view']);
  const canRateLimit = useCan('rate_limit.write');
  const canRemoteBlocklists = useCan('remote_blocklists');
  const canSeePolicies = canSeeTemplates || canRateLimit || canRemoteBlocklists;
  const canNotifications = useCan('notifications.manage');
  const canUsers = useCan('users.manage');
  const canReadAudit = useCan('audit.read');
  const canTenantSettings = useCan('settings');

  const {
    openAddAgentModal,
    toggleSidebarFloating,
    toggleSidebarCollapsed,
  } = useUiStore();
  // Effective (device-aware) mode — see useEffectiveSidebar(). The drawer is
  // always the full, expanded sidebar.
  const effective = useEffectiveSidebar();
  const sidebarCollapsed = !inDrawer && effective.collapsed;
  const sidebarFloating = !inDrawer && effective.floating;
  const canFloat = !inDrawer && effective.canFloat;
  // The toggle flips what is on screen (the < 1280 px rail is a default, not
  // a stored choice).
  const toggleCollapsed = () => toggleSidebarCollapsed(sidebarCollapsed);
  // Opening the Add-agent modal from the drawer: close the drawer first (it
  // sits above the modal).
  const handleAddAgent = () => {
    onRequestClose?.();
    openAddAgentModal();
  };
  const { tree, fetchTree } = useGroupStore();
  const currentTenantId = useTenantStore(s => s.currentTenantId);

  // Default-tenant god view: other tenants' agents and groups are read-only.
  const isForeign = useCallback(
    (tid: number | null | undefined) => currentTenantId != null && tid != null && tid !== currentTenantId,
    [currentTenantId],
  );
  const groupTenant = useMemo(() => {
    const m = new Map<number, number | undefined>();
    const walk = (ns: GroupTreeNode[]) => ns.forEach(n => { m.set(n.id, n.tenantId); walk(n.children); });
    walk(tree);
    return m;
  }, [tree]);

  // Shared agent store (fetched + polled by AppLayout, live via useSocket):
  // the tree shows approved and suspended agents.
  const allDevices = useAgentDevices();
  const liveStatus = useAgentStore(s => s.liveStatus);
  const pendingCount = useMemo(
    () => allDevices.filter(d => d.status === 'pending').length,
    [allDevices],
  );

  // Status of every listed device, then problem agents first (stable within a
  // tier: alphabetical), so every group and the ungrouped list inherit it.
  const statusById = useMemo(() => {
    const m = new Map<number, AgentStatusKey>();
    for (const d of allDevices) {
      if (d.status === 'approved' || d.status === 'suspended') m.set(d.id, sidebarStatus(d, liveStatus[d.id]));
    }
    return m;
  }, [allDevices, liveStatus]);
  const sortedDevices = useMemo(() => {
    const listed = allDevices.filter(d => statusById.has(d.id));
    return listed.sort((a, b) => {
      const tier = STATUS_TIER[statusById.get(a.id)!] - STATUS_TIER[statusById.get(b.id)!];
      if (tier !== 0) return tier;
      return (a.name ?? a.hostname).localeCompare(b.name ?? b.hostname, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [allDevices, statusById]);
  const getStatus = useCallback(
    (device: AgentDevice): AgentStatusKey => statusById.get(device.id) ?? resolveAgentStatus(device),
    [statusById],
  );
  const loadDevices = useCallback(() => { void useAgentStore.getState().fetchDevices(); }, []);

  // Drawer: search + tree scroll survive a close / re-open (see drawerUiCache).
  const drawerCacheKey = `${user?.id ?? '-'}:${currentTenantId ?? '-'}`;
  const [search, setSearchState] = useState(() => (
    inDrawer && drawerUiCache?.key === drawerCacheKey ? drawerUiCache.search : ''
  ));
  const setSearch = (value: string) => {
    setSearchState(value);
    if (inDrawer) rememberDrawerUi(drawerCacheKey, { search: value });
  };
  const treeScrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!inDrawer) return;
    const el = treeScrollRef.current;
    if (el && drawerUiCache?.key === drawerCacheKey) el.scrollTop = drawerUiCache.scrollTop;
  }, [inDrawer, drawerCacheKey]);
  const handleTreeScroll = inDrawer
    ? (e: UIEvent<HTMLDivElement>) => rememberDrawerUi(drawerCacheKey, { scrollTop: e.currentTarget.scrollTop })
    : undefined;
  const [adminMenuOpen, setAdminMenuOpen] = usePersisted<boolean>('sidebar:admin-open', true);
  const tenants = useTenantStore(s => s.tenants);
  const [collapsedTenants, setCollapsedTenants] = usePersisted<number[]>('sidebar:collapsed-tenants', []);
  const toggleTenantCollapsed = useCallback((id: number) => {
    setCollapsedTenants(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }, [setCollapsedTenants]);

  const agentGroups = tree.filter(n => n.kind === 'agent');

  // ── Nav items ──────────────────────────────────────────────────────────────
  // Grouped like Obliance: "Navigation" holds the operational pages (IPS
  // views, agents, the Policies hub); "Administration" the platform and tenant
  // administration, shown only when at least one of its items is visible.
  // Each predicate matches the route guard of the page (App.tsx) so a link
  // never bounces.
  const navItems: NavItem[] = [
    { label: t('nav.dashboard'),    path: '/',              icon: <LayoutDashboard size={18} />, visible: true },
    { label: t('nav.netmap'),       path: '/netmap',        icon: <Network size={18} />,         visible: true },
    { label: t('nav.ipReputation'), path: '/ip-reputation', icon: <Shield size={18} />,          visible: true },
    { label: t('nav.liveEvents', { defaultValue: 'Live events' }), path: '/live-events', icon: <Activity size={18} />, visible: true },
    {
      // Fleet list: every member (write actions are gated inside the page).
      label: t('nav.agents'), path: '/agents', icon: <Cpu size={18} />,
      visible: true,
      // Pending agents waiting for an approval the user can give.
      badgeCount: canApproveAgents ? pendingCount : undefined,
    },
    // Service templates, network limits and remote blocklists (tabs gated by capability).
    { label: t('nav.policies', { defaultValue: 'Policies' }), path: '/policies', icon: <ShieldCheck size={18} />, visible: canSeePolicies },
  ].filter(item => item.visible);

  const adminNavItems: NavItem[] = [
    { label: t('nav.users'),            path: '/manage/users',             icon: <Users size={18} />,      visible: canUsers },
    // Workspaces: platform admin, from the master tenant (where every
    // workspace is administered).
    { label: t('nav.workspaces'),       path: '/manage/tenants',           icon: <Building2 size={18} />,  visible: isPlatformAdmin && isMaster },
    // Agent config hub: enrolment keys, approvals, update policy (same any-of as its route).
    { label: t('nav.agentConfig', 'Agent config'), path: '/manage/agents', icon: <KeyRound size={18} />, visible: canSeeAgentAdmin },
    { label: t('nav.notifications'),    path: '/notifications',            icon: <Bell size={18} />,       visible: canNotifications },
    { label: t('nav.groups'),           path: '/groups',                   icon: <FolderTree size={18} />, visible: canManageGroups },
    // Audit log: audit.read (tenant admins see their tenant, Default the god view).
    { label: t('nav.auditLog', 'Audit log'), path: '/audit-log',           icon: <ScrollText size={18} />, visible: canReadAudit },
    // Global settings stay platform-admin only (instance-wide sections).
    { label: t('nav.settings'),         path: '/settings',                 icon: <Settings size={18} />,   visible: isPlatformAdmin },
    // Workspace level of the IPS settings cascade (W13): 'settings' holders.
    // Platform admins edit it from /settings.
    { label: t('nav.workspaceSettings', 'Workspace settings'), path: '/settings/workspace', icon: <SlidersHorizontal size={18} />, visible: canTenantSettings && !isPlatformAdmin },
  ].filter(item => item.visible);

  // Mouse: drag after 8 px (as before). Touch: long-press 250 ms, so a swipe
  // still scrolls the drawer instead of picking up an agent.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const handleAgentDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const dragData = active.data.current;
      const dropData = over.data.current;

      if (dragData?.type === 'agent-device' && dropData?.type === 'agent-group') {
        if (!canManageAgents) return; // read-only members: no drag-to-move
        const device       = dragData.device as AgentDevice;
        const targetGroupId = dropData.groupId as number | null;
        // God view: the "Ungrouped" zone of another tenant's bucket is not a target.
        const targetTenant  = dropData.tenantId as number | undefined;
        if (targetGroupId == null && targetTenant != null && targetTenant !== device.tenantId) {
          toast.error(t('agents.foreignReadOnlyShort', 'Read-only (other tenant)'));
          return;
        }
        if (device.groupId === targetGroupId) return;
        if (isForeign(device.tenantId) || (targetGroupId != null && isForeign(groupTenant.get(targetGroupId)))) {
          toast.error(t('agents.foreignReadOnlyShort', 'Read-only (other tenant)'));
          return;
        }
        try {
          await agentApi.updateDevice(device.id, { groupId: targetGroupId });
          loadDevices();
          toast.success(t('nav.agentMoved', 'Agent moved'));
        } catch {
          toast.error(t('nav.agentMoveFailed', 'Failed to move agent'));
        }
        return;
      }

      if (dragData?.type === 'agent-group-drag' && dropData?.type === 'agent-group') {
        if (!canManageGroups) return;
        const group        = dragData.group as GroupTreeNode;
        const targetGroupId = dropData.groupId as number | null;
        if (group.id === targetGroupId) return;
        if (isForeign(groupTenant.get(group.id)) || (targetGroupId != null && isForeign(groupTenant.get(targetGroupId)))) {
          toast.error(t('agents.foreignReadOnlyShort', 'Read-only (other tenant)'));
          return;
        }
        try {
          await groupsApi.move(group.id, targetGroupId);
          void fetchTree();
          loadDevices();
          toast.success(t('nav.groupMoved', 'Group moved'));
        } catch {
          toast.error(t('nav.groupMoveFailed', 'Failed to move group'));
        }
      }
    },
    [loadDevices, fetchTree, canManageAgents, canManageGroups, isForeign, groupTenant, t],
  );

  // The search box filters the agent tree only; navigation stays complete.
  const filteredDevices = search
    ? sortedDevices.filter(d =>
        (d.name ?? d.hostname).toLowerCase().includes(search.toLowerCase()),
      )
    : sortedDevices;

  const ungroupedDevices = filteredDevices.filter(d => d.groupId === null);

  // Master tenant (god view): the agent tree is bucketed per tenant (Obliance
  // Sidebar), Default first then by name, each bucket holding that tenant's
  // group tree and its ungrouped agents. Buckets fold (persisted); a search
  // ignores the folding so no match is hidden.
  const tenantBuckets = useMemo(() => {
    if (!isMaster) return null;
    const byTenant = new Map<number, { name: string; groups: GroupTreeNode[]; ungrouped: AgentDevice[] }>();
    const bucket = (id: number) => {
      let b = byTenant.get(id);
      if (!b) {
        b = {
          name: tenants.find(tn => tn.id === id)?.name ?? t('tenantBadge.fallback', 'Tenant {{id}}', { id }),
          groups: [],
          ungrouped: [],
        };
        byTenant.set(id, b);
      }
      return b;
    };
    for (const g of agentGroups) bucket(g.tenantId ?? MASTER_TENANT_ID).groups.push(g);
    for (const d of ungroupedDevices) bucket(d.tenantId).ungrouped.push(d);
    return [...byTenant.entries()].sort(([aId, a], [bId, b]) => {
      if (aId === MASTER_TENANT_ID) return -1;
      if (bId === MASTER_TENANT_ID) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [isMaster, agentGroups, ungroupedDevices, tenants, t]);

  const renderUngrouped = (devices: AgentDevice[], tenantId?: number) => devices.length > 0 && (
    <DroppableGroupHeader groupId={null} tenantId={tenantId}>
      <div className={cn('px-2 py-0.5 mt-1 text-[10px] font-medium text-text-muted uppercase tracking-wider', tenantId != null && 'pl-4')}>
        {t('nav.ungrouped', 'Ungrouped')}
      </div>
      {devices.map(device => (
        <DraggableDeviceItem
          key={device.id}
          device={device}
          statusKey={getStatus(device)}
          canDrag={canManageAgents}
          depth={tenantId != null ? 1 : 0}
        />
      ))}
    </DroppableGroupHeader>
  );

  const renderAgentContent = () => (
    <DndContext sensors={sensors} onDragEnd={handleAgentDragEnd}>
      <div className="mt-2 pt-2 border-t border-border">
        <div className="px-2 py-1.5 flex items-center gap-2 text-[11px] font-mono font-medium text-text-muted uppercase tracking-[0.12em]">
          <Server size={12} />
          {t('groups.agentGroup')}
        </div>

        {tenantBuckets ? (
          tenantBuckets.map(([tenantId, b]) => {
            const folded = collapsedTenants.includes(tenantId) && !search;
            return (
              <div key={tenantId} className="mt-1">
                <button
                  type="button"
                  onClick={() => toggleTenantCollapsed(tenantId)}
                  aria-expanded={!folded}
                  title={folded
                    ? t('nav.expandGroup', { name: b.name, defaultValue: 'Expand {{name}}' })
                    : t('nav.collapseGroup', { name: b.name, defaultValue: 'Collapse {{name}}' })}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent hover:bg-accent/5 coarse:py-2.5"
                >
                  {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  <Building2 size={11} />
                  <span className="truncate">{anonHostname(b.name)}</span>
                </button>
                {!folded && (
                  <>
                    {b.groups.map(group => (
                      <AgentGroupSection
                        key={group.id}
                        group={group}
                        devices={filteredDevices}
                        depth={1}
                        getStatus={getStatus}
                        canDragAgents={canManageAgents}
                        canDragGroups={canManageGroups}
                      />
                    ))}
                    {renderUngrouped(b.ungrouped, tenantId)}
                  </>
                )}
              </div>
            );
          })
        ) : (
          <>
            {agentGroups.map(group => (
              <AgentGroupSection
                key={group.id}
                group={group}
                devices={filteredDevices}
                depth={0}
                getStatus={getStatus}
                canDragAgents={canManageAgents}
                canDragGroups={canManageGroups}
              />
            ))}
            {renderUngrouped(ungroupedDevices)}
          </>
        )}
      </div>
    </DndContext>
  );

  // ── Collapsed mode (Obli Design v1) — 64 px icon-only column ─────────────
  if (sidebarCollapsed) {
    // No Administration label here: the icons are stacked.
    const allItems = [...navItems, ...adminNavItems];
    return (
      <aside className="flex h-full w-16 shrink-0 flex-col bg-bg-secondary pb-safe">
        <div className="flex h-12 shrink-0 items-center justify-center">
          <button
            onClick={toggleCollapsed}
            title={t('nav.expandSidebar', 'Expand sidebar')}
            aria-label={t('nav.expandSidebar', 'Expand sidebar')}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10 coarse:inline-flex coarse:items-center coarse:justify-center"
          >
            <ChevronsRight size={16} />
          </button>
        </div>

        {canAddAgent && (
          <div className="px-2 pt-1">
            <button
              onClick={handleAddAgent}
              title={t('nav.addAgent', 'Add agent')}
              aria-label={t('nav.addAgent', 'Add agent')}
              className="flex h-10 w-full items-center justify-center rounded-md bg-accent/12 text-accent transition-colors hover:bg-accent/20"
            >
              <Plus size={16} />
            </button>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-2 pt-3 space-y-1">
          {allItems.map((item) => {
            const isActive = isNavActive(location.pathname, item.path);
            const badge = item.badgeCount ?? 0;
            return (
              <Link
                key={item.path}
                to={item.path}
                title={badge > 0 ? `${item.label} (${badge})` : item.label}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'relative flex h-10 w-full items-center justify-center rounded-md transition-colors',
                  isActive
                    ? 'bg-accent/12 text-accent'
                    : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                {item.icon}
                {badge > 0 && (
                  <span className="absolute top-1 right-1.5 min-w-[1rem] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold leading-4 text-center">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
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
            <UserAvatar avatar={user?.avatar} username={user?.username ?? '?'} size={24} />
          </Link>
          <button
            onClick={() => useAuthStore.getState().logout()}
            title={t('nav.signOut')}
            aria-label={t('nav.signOut')}
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
    // Desktop column: clear of the home indicator on tablets (0 elsewhere);
    // the drawer panel already pads its own safe areas.
    <aside className={cn('flex h-full w-full flex-col bg-bg-secondary', !inDrawer && 'pb-safe')}>

      {/* Sidebar head — collapse + float/pin toggles only. The logo and
          tenant selector live in the topbar (Header.tsx) so they remain
          visible when the sidebar is collapsed or floating. */}
      <div className="flex h-9 shrink-0 items-center justify-end px-3 pt-2 coarse:h-auto">
        {inDrawer ? (
          <IconButton
            label={t('common.close', 'Close')}
            icon={<X className="h-4 w-4" />}
            size="md"
            onClick={onRequestClose}
          />
        ) : (
          <div className="flex items-center gap-1">
            {!sidebarFloating && (
              <button
                onClick={toggleCollapsed}
                title={t('nav.collapseSidebar', 'Collapse sidebar')}
                aria-label={t('nav.collapseSidebar', 'Collapse sidebar')}
                className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10 coarse:inline-flex coarse:items-center coarse:justify-center"
              >
                <ChevronsLeft size={15} />
              </button>
            )}
            {/* Floating (auto-hide on mouse leave) needs a hovering pointer:
                not offered on touch screens (the effective mode is pinned). */}
            {canFloat && (
              <button
                onClick={toggleSidebarFloating}
                title={sidebarFloating ? t('nav.pinSidebar', 'Pin sidebar') : t('nav.floatSidebar', 'Float sidebar (auto-hide)')}
                aria-label={sidebarFloating ? t('nav.pinSidebar', 'Pin sidebar') : t('nav.floatSidebar', 'Float sidebar (auto-hide)')}
                className={cn(
                  'p-1.5 rounded transition-colors',
                  sidebarFloating
                    ? 'text-accent hover:text-accent hover:bg-accent/10'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
                )}
              >
                {sidebarFloating ? <PinOff size={15} /> : <Pin size={15} />}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Add agent button — accent pill (needs the enrolment-key capability) */}
      {canAddAgent && (
        <div className="px-3 pt-2">
          <button
            onClick={handleAddAgent}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-accent/12 hover:bg-accent/20 px-3 py-2 text-[13px] font-medium text-accent transition-colors coarse:py-2.5"
          >
            <Plus size={15} />
            {t('nav.addAgent', 'Add agent')}
          </button>
        </div>
      )}

      {/* Search (agent tree only) */}
      <div className="px-3 py-2.5">
        <input
          type="text"
          placeholder={t('nav.searchAgents', { defaultValue: 'Search agents…' })}
          aria-label={t('nav.searchAgents', { defaultValue: 'Search agents…' })}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Main nav + agents */}
      <div ref={treeScrollRef} onScroll={handleTreeScroll} className="flex-1 overflow-y-auto px-2 min-h-0">
        <nav aria-label={t('nav.navigation', 'Navigation')}>
          {navItems.map(item => <NavLink key={item.path} item={item} />)}
        </nav>

        {renderAgentContent()}
      </div>

      {/* Administration section — only when at least one item is visible. */}
      {adminNavItems.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setAdminMenuOpen(v => !v)}
            aria-expanded={adminMenuOpen}
            aria-controls="sidebar-admin-nav"
            title={adminMenuOpen ? t('nav.collapseAdmin', 'Collapse administration') : t('nav.expandAdmin', 'Expand administration')}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-text-muted hover:text-text-secondary transition-colors coarse:py-2.5"
          >
            <div className="flex-1 h-px bg-border" />
            <ChevronDown size={12} className={cn('transition-transform duration-200', !adminMenuOpen && '-rotate-90')} />
            <span className="text-[10px] font-bold uppercase tracking-widest">{t('nav.administration', 'Administration')}</span>
            <div className="flex-1 h-px bg-border" />
          </button>

          {adminMenuOpen && (
            <nav id="sidebar-admin-nav" aria-label={t('nav.administration', 'Administration')} className="p-2 pt-0">
              {adminNavItems.map(item => <NavLink key={item.path} item={item} />)}
            </nav>
          )}
        </>
      )}

      {/* User section */}
      <div className="border-t border-border p-2">
        <Link
          to="/profile"
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors coarse:py-2.5',
            location.pathname === '/profile'
              ? 'bg-accent/10'
              : 'hover:bg-bg-hover',
          )}
        >
          <UserAvatar avatar={user?.avatar} username={user?.username ?? '?'} size={20} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-primary">
              {anonUsername(user?.displayName || (user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username))}
            </div>
            <div className="truncate font-mono text-[10px] text-text-muted">
              {(user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username) ?? ''} · {tenantRole ?? user?.role ?? ''}
            </div>
          </div>
        </Link>
        <button
          onClick={() => useAuthStore.getState().logout()}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary coarse:py-2.5"
        >
          <LogOut size={18} />
          {t('nav.signOut')}
        </button>
      </div>
    </aside>
  );
}
