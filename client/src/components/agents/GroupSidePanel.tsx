import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2, ChevronRight, Cpu, FolderOpen, FolderTree, FolderX, PanelLeftClose, PanelLeftOpen, Pencil, Search, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GroupTreeNode } from '@obliview/shared';
import { cn } from '@/utils/cn';
import { anonHostname } from '@/utils/anonymize';
import { useGroupStore } from '@/store/groupStore';
import { useTenantStore } from '@/store/tenantStore';
import { useAgentDevices } from '@/store/agentStore';
import { useCan } from '@/hooks/usePermission';
import { useIsMasterTenant, MASTER_TENANT_ID } from '@/hooks/useIsMasterTenant';
import { useCanHover } from '@/hooks/useMediaQuery';
import { usePersistedState } from '@/hooks/usePersistedState';
import { IconButton } from '@/components/common/IconButton';

/**
 * Group tree of the /agents fleet list (port of Obliance
 * components/devices/GroupSidePanel.tsx): "All agents", "Ungrouped", then
 * the agent groups with their recursive agent counts. In the master tenant
 * (god view) the tree is bucketed per tenant (Default first, then by name),
 * each bucket collapsible. Picking a node filters the table; the pencil
 * opens the group's edit page (groups.manage, own tenant only).
 *
 * Counts come from the shared agent store (AppLayout keeps it live), so the
 * panel needs no request of its own. Group reparenting stays on the sidebar
 * and the groups page.
 *
 * Selection: null = all agents, -1 = ungrouped, otherwise a group id.
 */

interface GroupSidePanelProps {
  groupId: number | null;
  onGroupChange: (id: number | null) => void;
  className?: string;
  /**
   * 'panel' (default): the resizable / collapsible inline column (lg+).
   * 'drawer': full-width content of the off-canvas groups drawer below lg —
   * no collapse, no resize, a close button instead.
   */
  variant?: 'panel' | 'drawer';
  /** Drawer variant: closes the drawer (header × button). */
  onClose?: () => void;
}

/** Selection value of the "Ungrouped" entry. */
export const UNGROUPED = -1;

const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 180;
const MAX_WIDTH = 520;

function filterTree(nodes: GroupTreeNode[], query: string): GroupTreeNode[] {
  if (!query) return nodes;
  const lower = query.toLowerCase();
  return nodes.reduce<GroupTreeNode[]>((acc, node) => {
    const childMatches = filterTree(node.children, query);
    if (node.name.toLowerCase().includes(lower) || childMatches.length > 0) {
      acc.push({ ...node, children: childMatches.length > 0 ? childMatches : node.children.filter((c) => c.name.toLowerCase().includes(lower)) });
    }
    return acc;
  }, []);
}

function hasSelectedDescendant(node: GroupTreeNode, selectedId: number | null): boolean {
  if (selectedId == null) return false;
  if (node.id === selectedId) return true;
  return node.children.some((c) => hasSelectedDescendant(c, selectedId));
}

function TreeNode({
  node, depth, selectedGroupId, onSelect, counts, expandedIds, toggleExpand, canEdit,
}: {
  node: GroupTreeNode;
  depth: number;
  selectedGroupId: number | null;
  onSelect: (id: number) => void;
  counts: Map<number, number>;
  expandedIds: ReadonlySet<number>;
  toggleExpand: (id: number) => void;
  canEdit: (node: GroupTreeNode) => boolean;
}) {
  const { t } = useTranslation();
  const canHover = useCanHover();
  const isSelected = node.id === selectedGroupId;
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isAncestor = hasSelectedDescendant(node, selectedGroupId);
  const editable = canEdit(node);

  return (
    <>
      <div
        className={cn(
          'group/row flex w-full items-center gap-1.5 rounded-md py-1 pr-1 text-left text-sm transition-colors',
          'hover:bg-accent/5 coarse:min-h-10',
          isSelected && 'bg-accent/10 font-medium',
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        title={canHover ? node.name : undefined}
      >
        <button
          type="button"
          onClick={() => { if (hasChildren) toggleExpand(node.id); }}
          aria-label={isExpanded
            ? t('agents.list.groups.collapse', { name: node.name, defaultValue: 'Collapse {{name}}' })
            : t('agents.list.groups.expand', { name: node.name, defaultValue: 'Expand {{name}}' })}
          aria-expanded={hasChildren ? isExpanded : undefined}
          tabIndex={hasChildren ? 0 : -1}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded coarse:h-8 coarse:w-8',
            !hasChildren && 'invisible pointer-events-none',
          )}
        >
          <ChevronRight size={14} className={cn('text-text-muted transition-transform duration-150', isExpanded && 'rotate-90')} />
        </button>

        <button
          type="button"
          onClick={() => onSelect(node.id)}
          aria-current={isSelected ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 coarse:self-stretch"
        >
          <FolderOpen size={15} className={cn('shrink-0', isSelected || isAncestor ? 'text-accent' : 'text-text-muted')} />
          <span className="truncate text-text-primary">{anonHostname(node.name)}</span>
          {node.evaluateOnly && (
            <span
              className="shrink-0 rounded-full bg-amber-400/10 px-1.5 text-[10px] text-amber-400"
              title={t('status.agent.evaluateOnly', 'Evaluate only')}
            >
              {t('agents.list.groups.evalShort', 'eval')}
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs tabular-nums text-text-muted">{counts.get(node.id) ?? 0}</span>
        </button>

        {editable && (
          <Link
            to={`/group/${node.id}/edit`}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'shrink-0 rounded p-0.5 text-text-muted transition-opacity hover:bg-bg-tertiary hover:text-text-primary',
              'can-hover:opacity-0 can-hover:group-hover/row:opacity-100 coarse:p-2',
            )}
            title={t('agents.list.groups.settings', 'Group settings')}
            aria-label={t('agents.list.groups.settingsOf', { name: node.name, defaultValue: 'Settings of {{name}}' })}
          >
            <Pencil size={12} />
          </Link>
        )}
      </div>

      {hasChildren && isExpanded && node.children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedGroupId={selectedGroupId}
          onSelect={onSelect}
          counts={counts}
          expandedIds={expandedIds}
          toggleExpand={toggleExpand}
          canEdit={canEdit}
        />
      ))}
    </>
  );
}

export function GroupSidePanel({ groupId, onGroupChange, className, variant = 'panel', onClose }: GroupSidePanelProps) {
  const { t } = useTranslation();
  const isDrawer = variant === 'drawer';
  const tree = useGroupStore((s) => s.tree);
  const fetchTree = useGroupStore((s) => s.fetchTree);
  const devices = useAgentDevices();
  const tenants = useTenantStore((s) => s.tenants);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const isMaster = useIsMasterTenant();
  const canManageGroups = useCan('groups.manage');

  const [collapsed, setCollapsed] = usePersistedState<boolean>('og-agents-groups-collapsed', false);
  const [width, setWidth] = usePersistedState<number>('og-agents-groups-width', DEFAULT_WIDTH);
  const [expanded, setExpanded] = usePersistedState<number[] | null>('og-agents-groups-expanded', null);
  const [collapsedTenants, setCollapsedTenants] = usePersistedState<number[]>('og-agents-groups-collapsed-tenants', []);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (tree.length === 0) void fetchTree();
  }, [tree.length, fetchTree]);

  const agentTree = useMemo(() => tree.filter((n) => n.kind === 'agent'), [tree]);

  // Default: root groups expanded until the user folds / unfolds something.
  const expandedIds = useMemo(
    () => new Set(expanded ?? agentTree.map((n) => n.id)),
    [expanded, agentTree],
  );
  const toggleExpand = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev ?? agentTree.map((n) => n.id));
      if (next.has(id)) next.delete(id); else next.add(id);
      return [...next];
    });
  }, [setExpanded, agentTree]);
  const toggleTenant = useCallback((id: number) => {
    setCollapsedTenants((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, [setCollapsedTenants]);

  // Recursive agent counts per group (every status the store holds).
  const { counts, total, ungrouped, online, offline, pending } = useMemo(() => {
    const direct = new Map<number, number>();
    let ung = 0;
    let on = 0;
    let off = 0;
    let pend = 0;
    for (const d of devices) {
      if (d.groupId == null) ung++;
      else direct.set(d.groupId, (direct.get(d.groupId) ?? 0) + 1);
      if (d.status === 'pending') pend++;
      else if (d.status === 'approved') {
        if (d.wsConnected) on++; else off++;
      }
    }
    const out = new Map<number, number>();
    const walk = (n: GroupTreeNode): number => {
      let sum = direct.get(n.id) ?? 0;
      for (const c of n.children) sum += walk(c);
      out.set(n.id, sum);
      return sum;
    };
    agentTree.forEach(walk);
    return { counts: out, total: devices.length, ungrouped: ung, online: on, offline: off, pending: pend };
  }, [devices, agentTree]);

  const filteredTree = useMemo(() => filterTree(agentTree, search.trim()), [agentTree, search]);

  // God view: one collapsible bucket per tenant, Default first, then by name.
  // Tenants without any group still get an (empty) bucket.
  const tenantBuckets = useMemo(() => {
    if (!isMaster) return null;
    const byTenant = new Map<number, { name: string; nodes: GroupTreeNode[] }>();
    const nameOf = (id: number) => tenants.find((tn) => tn.id === id)?.name
      ?? t('tenantBadge.fallback', 'Tenant {{id}}', { id });
    for (const node of filteredTree) {
      const tid = node.tenantId ?? MASTER_TENANT_ID;
      if (!byTenant.has(tid)) byTenant.set(tid, { name: nameOf(tid), nodes: [] });
      byTenant.get(tid)!.nodes.push(node);
    }
    if (!search.trim()) {
      for (const tn of tenants) if (!byTenant.has(tn.id)) byTenant.set(tn.id, { name: tn.name, nodes: [] });
    }
    return [...byTenant.entries()].sort(([aId, a], [bId, b]) => {
      if (aId === MASTER_TENANT_ID) return -1;
      if (bId === MASTER_TENANT_ID) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [isMaster, filteredTree, tenants, search, t]);

  // Groups of another tenant (god view) are read-only here.
  const canEdit = useCallback(
    (node: GroupTreeNode) => canManageGroups && (node.tenantId == null || node.tenantId === currentTenantId),
    [canManageGroups, currentTenantId],
  );

  // ── Resize (pointer events: mouse, pen and touch laptops) ────────────
  const resizing = useRef(false);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!resizing.current) return;
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX)));
    };
    const onUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [setWidth]);

  if (collapsed && !isDrawer) {
    return (
      <div className={cn('flex h-full w-10 shrink-0 flex-col items-center bg-bg-secondary pt-3', className)}>
        <IconButton
          label={t('agents.list.groups.expandPanel', 'Show groups')}
          icon={<PanelLeftOpen size={18} />}
          size="sm"
          variant="plain"
          onClick={() => setCollapsed(false)}
        />
      </div>
    );
  }

  const renderNode = (node: GroupTreeNode, depth: number) => (
    <TreeNode
      key={node.id}
      node={node}
      depth={depth}
      selectedGroupId={groupId}
      onSelect={(id) => onGroupChange(id)}
      counts={counts}
      expandedIds={search.trim() ? new Set(allIds(filteredTree)) : expandedIds}
      toggleExpand={toggleExpand}
      canEdit={canEdit}
    />
  );

  const rootRow = (active: boolean) => cn(
    'flex w-full items-center gap-1.5 rounded-md py-1 pl-2 pr-2 text-left text-sm transition-colors',
    'hover:bg-accent/5 coarse:min-h-10',
    active && 'bg-accent/10 font-medium',
  );

  const clampedWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width || DEFAULT_WIDTH));

  return (
    <div
      style={isDrawer ? undefined : { width: `${clampedWidth}px` }}
      className={cn(
        isDrawer ? 'relative flex h-full w-full flex-col bg-bg-secondary' : 'relative flex h-full shrink-0 flex-col bg-bg-secondary',
        className,
      )}
      aria-label={t('agents.list.groups.title', 'Groups')}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <h2 className="text-sm font-semibold text-text-primary">{t('agents.list.groups.title', 'Groups')}</h2>
        <div className="flex items-center gap-1">
          {canManageGroups && (
            <Link
              to="/groups"
              className="rounded p-1 text-text-muted hover:bg-accent/10 hover:text-accent coarse:inline-flex coarse:min-h-10 coarse:min-w-10 coarse:items-center coarse:justify-center"
              title={t('agents.list.groups.manage', 'Manage groups')}
              aria-label={t('agents.list.groups.manage', 'Manage groups')}
            >
              <FolderTree size={16} />
            </Link>
          )}
          {isDrawer ? (
            <IconButton label={t('common.close')} icon={<X size={16} />} size="sm" variant="plain" onClick={onClose} />
          ) : (
            <IconButton
              label={t('agents.list.groups.collapsePanel', 'Hide groups')}
              icon={<PanelLeftClose size={16} />}
              size="sm"
              variant="plain"
              onClick={() => setCollapsed(true)}
            />
          )}
        </div>
      </div>

      {/* Fleet summary */}
      <div className="flex items-center gap-3 px-3 pb-1 text-xs text-text-muted">
        <span className="flex items-center gap-1" title={t('status.agent.online', 'Online')}>
          <span className="inline-block h-2 w-2 rounded-full bg-status-up" />{online}
        </span>
        <span className="flex items-center gap-1" title={t('status.agent.offline', 'Offline')}>
          <span className="inline-block h-2 w-2 rounded-full bg-text-muted" />{offline}
        </span>
        {pending > 0 && (
          <span className="flex items-center gap-1" title={t('status.agent.pending', 'Pending')}>
            <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />{pending}
          </span>
        )}
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('agents.list.groups.filter', 'Filter groups…')}
            aria-label={t('agents.list.groups.filter', 'Filter groups…')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-md bg-bg-hover py-[5px] pl-7 pr-2 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 coarse:py-2"
          />
        </div>
      </div>

      {/* Tree */}
      <nav className="flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2" aria-label={t('agents.list.groups.title', 'Groups')}>
        <button type="button" onClick={() => onGroupChange(null)} className={rootRow(groupId === null)} aria-current={groupId === null ? 'true' : undefined}>
          <Cpu size={15} className={cn('shrink-0', groupId === null ? 'text-accent' : 'text-text-muted')} />
          <span className="text-text-primary">{t('agents.list.groups.all', 'All agents')}</span>
          <span className="ml-auto text-xs tabular-nums text-text-muted">{total}</span>
        </button>
        <button
          type="button"
          onClick={() => onGroupChange(UNGROUPED)}
          className={rootRow(groupId === UNGROUPED)}
          aria-current={groupId === UNGROUPED ? 'true' : undefined}
          title={t('agents.list.groups.ungroupedHint', 'Agents that do not belong to any group')}
        >
          <FolderX size={15} className={cn('shrink-0', groupId === UNGROUPED ? 'text-accent' : 'text-text-muted')} />
          <span className="text-text-primary">{t('nav.ungrouped', 'Ungrouped')}</span>
          <span className="ml-auto text-xs tabular-nums text-text-muted">{ungrouped}</span>
        </button>

        {tenantBuckets ? (
          tenantBuckets.map(([tid, { name, nodes }]) => {
            const folded = collapsedTenants.includes(tid) && !search.trim();
            const bucketTotal = nodes.reduce((s, n) => s + (counts.get(n.id) ?? 0), 0);
            return (
              <div key={tid} className="mt-1">
                <button
                  type="button"
                  onClick={() => toggleTenant(tid)}
                  aria-expanded={!folded}
                  title={name}
                  className="flex w-full items-center gap-1.5 rounded-md py-1 pl-1 pr-2 text-left text-xs font-semibold uppercase tracking-wide transition-colors hover:bg-accent/5 coarse:min-h-10"
                >
                  <ChevronRight size={14} className={cn('shrink-0 text-text-muted transition-transform duration-150', !folded && 'rotate-90')} />
                  <Building2 size={13} className="shrink-0 text-accent" />
                  <span className="truncate text-accent">{anonHostname(name)}</span>
                  <span className="ml-auto text-[10px] tabular-nums text-text-muted">{bucketTotal}</span>
                </button>
                {!folded && (nodes.length === 0 ? (
                  <div className="py-0.5 pl-7 text-[11px] italic text-text-muted">
                    {t('agents.list.groups.tenantEmpty', 'No groups yet')}
                  </div>
                ) : nodes.map((node) => renderNode(node, 1)))}
              </div>
            );
          })
        ) : (
          filteredTree.map((node) => renderNode(node, 0))
        )}

        {filteredTree.length === 0 && search.trim() !== '' && (
          <p className="px-2 py-2 text-xs text-text-muted">{t('common.noResults')}</p>
        )}
      </nav>

      {!isDrawer && (
        <div
          onPointerDown={(e) => {
            e.preventDefault();
            resizing.current = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none hover:bg-accent/40 coarse:-right-1 coarse:w-3"
          title={t('agents.list.groups.resize', 'Drag to resize')}
          aria-hidden
        />
      )}
    </div>
  );
}

function allIds(nodes: GroupTreeNode[]): number[] {
  const out: number[] = [];
  const walk = (ns: GroupTreeNode[]) => ns.forEach((n) => { out.push(n.id); walk(n.children); });
  walk(nodes);
  return out;
}
