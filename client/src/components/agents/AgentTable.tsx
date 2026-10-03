import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  ArrowUpCircle, Ban, CheckCircle2, Columns3, Cpu, Download, FolderInput, FolderTree, Loader2, Pencil,
  RefreshCw, Router, Search, Shield, Trash2, UserX, X,
} from 'lucide-react';
import type { AgentUpdatePolicy, GroupTreeNode } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import {
  agentApi, AGENT_LIST_CHIPS, AGENT_LIST_MAX_PAGE_SIZE,
  type AgentListChip, type AgentListCounts, type AgentListDeviceType, type AgentListPage, type AgentListQuery,
  type AgentListRow, type AgentListSortField,
} from '@/api/agent.api';
import { cn } from '@/utils/cn';
import { anonHostname, anonIp } from '@/utils/anonymize';
import { saveCsv } from '@/utils/download';
import { agentUpdateErrorMessage } from '@/utils/agentUpdate';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useGroupStore } from '@/store/groupStore';
import { useCan, useIsPlatformAdmin } from '@/hooks/usePermission';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useTenantFilter } from '@/hooks/useTenantFilter';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useSessionState } from '@/hooks/useSessionState';
import { useRowSelection } from '@/hooks/useRowSelection';
import { useSocketRefresh } from '@/hooks/useSocketRefresh';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { GroupPicker } from '@/components/common/GroupPicker';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { SortableTh, nextSort, type SortState } from '@/components/common/SortableTh';
import { TableScroll } from '@/components/common/TableScroll';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { TenantBadge } from '@/components/common/TenantBadge';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { AgentStatusBadge } from '@/components/status/AgentStatusBadge';
import { UpdateStatusBadge } from '@/components/agent/UpdateStatusBadge';
import { LastSeenPill } from '@/components/agent/LastSeenPill';

/**
 * Fleet table of /agents (port of Obliance components/devices/DeviceTable):
 * server-side search / chips / sort / paging (GET /agent/devices?paged=1),
 * a column picker persisted per browser, a batch bar and a CSV export.
 *
 *  - Page mode: the filters live in the URL (?q=, ?status=online,offline,
 *    ?type=, ?tenants=) so a view can be shared and the dashboard can deep
 *    link (/agents?status=offline); the sort lives in the session.
 *  - Embedded mode (`embedded`, e.g. a group page): the same table scoped to
 *    `groupId`, filters kept in component state (the host page owns its URL).
 *
 * Writes are capability-gated (useCan) and limited to the operating tenant's
 * agents the caller may write (accessLevel 'rw'): god-view rows of other
 * tenants are read-only, as on the server (bulk ids of another tenant are
 * skipped there). Every batch action is confirmed.
 */

export type AgentColumn =
  | 'status' | 'approval' | 'group' | 'tenant' | 'version' | 'lastSeen'
  | 'events24h' | 'bans24h' | 'evaluateOnly' | 'type' | 'ip' | 'os';

const ALL_COLUMNS: readonly AgentColumn[] = [
  'status', 'approval', 'group', 'tenant', 'version', 'lastSeen', 'events24h', 'bans24h', 'evaluateOnly', 'type', 'ip', 'os',
];
const DEFAULT_COLUMNS: readonly AgentColumn[] = ['status', 'group', 'tenant', 'version', 'lastSeen', 'events24h', 'bans24h', 'evaluateOnly'];

/** Sort field of the sortable columns (the name column sorts on 'name'). */
const COLUMN_SORT: Partial<Record<AgentColumn, AgentListSortField>> = {
  status: 'status',
  group: 'group',
  tenant: 'tenant',
  version: 'version',
  lastSeen: 'lastSeen',
  events24h: 'events24h',
  bans24h: 'bans24h',
};

const NUMERIC_COLUMNS: ReadonlySet<AgentColumn> = new Set(['events24h', 'bans24h']);
const PAGE_SIZES = [25, 50, 100, 200] as const;
const DEVICE_TYPES: readonly AgentListDeviceType[] = ['agent', 'mikrotik', 'm365'];
/** CSV export: whole filtered set, fetched page by page (server cap per page). */
const EXPORT_MAX_ROWS = 10_000;
const SEARCH_DEBOUNCE_MS = 300;

/** Value of the "Ungrouped" selection (GroupSidePanel). */
const UNGROUPED = -1;

export interface AgentTableProps {
  /** null / undefined = every group, -1 = ungrouped agents, otherwise a group. */
  groupId?: number | null;
  /** With a group: include its sub-groups (default true). */
  recursive?: boolean;
  /** Embedded in another page: compact toolbar, filters in local state, no tenant chips. */
  embedded?: boolean;
  /** Below lg the group panel is a drawer: the toolbar shows a "Groups" button opening it. */
  onOpenGroups?: () => void;
  /** Label of the current group selection (shown on the "Groups" button). */
  groupLabel?: string;
  /** Page mode: toggles "include sub-groups" (shown when a group is selected). */
  onRecursiveChange?: (recursive: boolean) => void;
  className?: string;
}

interface Filters {
  q: string;
  chips: AgentListChip[];
  type: AgentListDeviceType | '';
}

function parseChips(raw: string | null): AgentListChip[] {
  if (!raw) return [];
  const known = new Set<string>(AGENT_LIST_CHIPS);
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => known.has(s)))] as AgentListChip[];
}

/** Filters in the URL (page mode) or in local state (embedded). */
function useAgentFilters(embedded: boolean): [Filters, (patch: Partial<Filters>) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const [local, setLocal] = useState<Filters>({ q: '', chips: [], type: '' });
  const fromUrl = useMemo<Filters>(() => {
    const type = searchParams.get('type');
    return {
      q: searchParams.get('q') ?? '',
      chips: parseChips(searchParams.get('status')),
      type: (DEVICE_TYPES as readonly string[]).includes(type ?? '') ? type as AgentListDeviceType : '',
    };
  }, [searchParams]);

  const update = useCallback((patch: Partial<Filters>) => {
    if (embedded) {
      setLocal((prev) => ({ ...prev, ...patch }));
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const set = (key: string, value: string) => { if (value) next.set(key, value); else next.delete(key); };
      if (patch.q !== undefined) set('q', patch.q.trim());
      if (patch.chips !== undefined) set('status', patch.chips.join(','));
      if (patch.type !== undefined) set('type', patch.type);
      return next;
    }, { replace: true });
  }, [embedded, setSearchParams]);

  return [embedded ? local : fromUrl, update];
}

export function AgentTable({
  groupId = null, recursive = true, embedded = false, onOpenGroups, groupLabel, onRecursiveChange, className,
}: AgentTableProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const userId = useAuthStore((s) => s.user?.id);
  const isMaster = useIsMasterTenant();
  const isPlatformAdmin = useIsPlatformAdmin();
  const canUpdate = useCan('agents.update');
  const canApprove = useCan('agents.approve');
  const canManage = useCan('agents.manage');
  const canDelete = useCan('agents.delete');
  const canBatch = canUpdate || canApprove || canManage || canDelete || isPlatformAdmin;

  // ── Filters, sort, paging, columns ───────────────────────────────────────
  const [filters, setFilters] = useAgentFilters(embedded);
  const tenantFilter = useTenantFilter();
  const tenantIds = embedded ? [] : tenantFilter.ids;
  const [searchInput, setSearchInput] = useState(filters.q);
  useEffect(() => { setSearchInput(filters.q); }, [filters.q]);
  useEffect(() => {
    if (searchInput.trim() === filters.q.trim()) return;
    const id = window.setTimeout(() => setFilters({ q: searchInput }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput, filters.q, setFilters]);

  const [sort, setSort] = useSessionState<SortState<AgentListSortField>>(
    embedded ? 'og-agents-sort-embedded' : 'og-agents-sort', null,
  );
  const [pageSize, setPageSize] = usePersistedState<number>('og-agents-page-size', 50);
  const safePageSize = (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 50;
  const [storedColumns, setColumns] = usePersistedState<AgentColumn[]>('og-agents-columns', [...DEFAULT_COLUMNS]);
  const columns = useMemo(() => {
    const valid = new Set<AgentColumn>(ALL_COLUMNS);
    const picked = Array.isArray(storedColumns) ? storedColumns.filter((c) => valid.has(c)) : [...DEFAULT_COLUMNS];
    // Tenant column: god view only.
    return ALL_COLUMNS.filter((c) => picked.includes(c) && (c !== 'tenant' || isMaster));
  }, [storedColumns, isMaster]);

  const queryKey = useMemo(() => JSON.stringify({
    q: filters.q.trim(), chips: [...filters.chips].sort(), type: filters.type, tenantIds: [...tenantIds].sort(),
    groupId, recursive, sort, pageSize: safePageSize, tenant: currentTenantId, user: userId,
  }), [filters, tenantIds, groupId, recursive, sort, safePageSize, currentTenantId, userId]);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [queryKey]);

  const query = useMemo<AgentListQuery>(() => ({
    q: filters.q,
    chips: filters.chips,
    type: filters.type || undefined,
    tenantIds,
    groupId: groupId === UNGROUPED ? 'none' : groupId ?? undefined,
    recursive,
    sortBy: sort?.field,
    sortOrder: sort?.dir,
    pageSize: safePageSize,
  // queryKey serialises every input above (tenantIds is a new array each render).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [queryKey]);

  // ── Data ─────────────────────────────────────────────────────────────────
  const [data, setData] = useState<AgentListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await agentApi.listPaged({ ...query, page }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setData(res);
      setFailed(false);
    } catch (err) {
      if (ctrl.signal.aborted || (err as { code?: string })?.code === 'ERR_CANCELED') return;
      setFailed(true);
      toast.error(t('agents.list.loadFailed', 'Failed to load the agents'));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [query, page, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => abortRef.current?.abort(), []);

  useSocketRefresh([
    SOCKET_EVENTS.AGENT_STATUS_CHANGED,
    SOCKET_EVENTS.AGENT_DEVICE_UPDATED,
    SOCKET_EVENTS.AGENT_DEVICE_CREATED,
    SOCKET_EVENTS.AGENT_DEVICE_DELETED,
  ], load, { debounceMs: 1500 });

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const counts: AgentListCounts | null = data?.counts ?? null;
  const total = data?.total ?? 0;

  // ── Selection (writable rows of the operating tenant only) ───────────────
  const isWritable = useCallback(
    (d: AgentListRow) => d.tenantId === currentTenantId && d.accessLevel !== 'ro',
    [currentTenantId],
  );
  const selectableIds = useMemo(() => rows.filter(isWritable).map((d) => d.id), [rows, isWritable]);
  const sel = useRowSelection(selectableIds, [queryKey, page]);
  const selectedRows = useMemo(() => rows.filter((d) => sel.selected.has(d.id)), [rows, sel.selected]);

  // ── Batch actions ────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const runBatch = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      sel.clear();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const skippedToast = (skipped: number | undefined) => {
    if (skipped && skipped > 0) {
      toast(t('agents.list.batch.skipped', { count: skipped, defaultValue: '{{count}} agent(s) skipped (other tenant or read-only)' }));
    }
  };

  const batchUpdate = async () => {
    const ids = sel.ids;
    const version = selectedRows.find((d) => d.latestAgentVersion)?.latestAgentVersion ?? '?';
    if (!(await confirm({
      title: t('agents.list.batch.update', 'Update'),
      message: t('agentUpdate.confirmBulk', { defaultValue: 'Request an update to v{{version}} for {{count}} agent(s)?', count: ids.length, version }),
      confirmLabel: t('agents.list.batch.update', 'Update'),
    }))) return;
    await runBatch(async () => {
      try {
        const r = await agentApi.bulkRequestUpdate(ids);
        const skipped = r.skipped.off + r.skipped.current + r.skipped.notUpdatable + r.skipped.notFound;
        toast.success(t('agentUpdate.bulkResult', { defaultValue: '{{requested}} update(s) requested, {{skipped}} skipped', requested: r.requested, skipped }));
      } catch (err) {
        toast.error(agentUpdateErrorMessage(err, t, t('agents.list.batch.failed', 'The action failed')));
      }
    });
  };

  const batchStatus = async (status: 'approved' | 'suspended') => {
    const ids = sel.ids;
    const suspend = status === 'suspended';
    if (!(await confirm({
      title: suspend ? t('agents.list.batch.suspend', 'Suspend') : t('agents.list.batch.approve', 'Approve'),
      message: suspend
        ? t('agents.list.batch.confirmSuspend', { count: ids.length, defaultValue: 'Suspend {{count}} agent(s)? They are disconnected and stop enforcing bans until reinstated.' })
        : t('agents.list.batch.confirmApprove', { count: ids.length, defaultValue: 'Approve (or reinstate) {{count}} agent(s)?' }),
      confirmLabel: suspend ? t('agents.list.batch.suspend', 'Suspend') : t('agents.list.batch.approve', 'Approve'),
      danger: suspend,
    }))) return;
    await runBatch(async () => {
      try {
        const r = await agentApi.bulkUpdateDevices(ids, { status });
        toast.success(t('agents.list.batch.done', { count: r?.affected ?? ids.length, defaultValue: '{{count}} agent(s) updated' }));
        skippedToast(r?.skipped);
      } catch (err) {
        toast.error(agentUpdateErrorMessage(err, t, t('agents.list.batch.failed', 'The action failed')));
      }
    });
  };

  const batchMove = async (target: number | null) => {
    const ids = sel.ids;
    setMoveOpen(false);
    await runBatch(async () => {
      try {
        const r = await agentApi.bulkUpdateDevices(ids, { groupId: target });
        toast.success(t('agents.list.batch.moved', { count: r?.affected ?? ids.length, defaultValue: '{{count}} agent(s) moved' }));
        skippedToast(r?.skipped);
      } catch (err) {
        toast.error(agentUpdateErrorMessage(err, t, t('agents.list.batch.failed', 'The action failed')));
      }
    });
  };

  const batchEdit = async (patch: { overrideGroupSettings?: boolean; updatePolicy?: AgentUpdatePolicy | null }) => {
    const ids = sel.ids;
    setEditOpen(false);
    if (Object.keys(patch).length === 0) return;
    await runBatch(async () => {
      try {
        const r = await agentApi.bulkUpdateDevices(ids, patch);
        toast.success(t('agents.list.batch.done', { count: r?.affected ?? ids.length, defaultValue: '{{count}} agent(s) updated' }));
        skippedToast(r?.skipped);
      } catch (err) {
        toast.error(agentUpdateErrorMessage(err, t, t('agents.list.batch.failed', 'The action failed')));
      }
    });
  };

  const batchUninstall = async () => {
    const ids = sel.ids;
    if (!(await confirm({
      title: t('agents.list.batch.uninstall', 'Uninstall'),
      message: t('agents.list.batch.confirmUninstall', {
        count: ids.length,
        defaultValue: 'Send the uninstall command to {{count}} agent(s)? Each agent removes itself and its firewall rules; the entries are deleted a few minutes later. Type {{count}} to confirm.',
      }),
      confirmLabel: t('agents.list.batch.uninstall', 'Uninstall'),
      danger: true,
      requireText: String(ids.length),
    }))) return;
    await runBatch(async () => {
      try {
        const r = await agentApi.bulkSendCommand(ids, 'uninstall');
        toast.success(t('agents.list.batch.uninstallQueued', { count: r?.affected ?? ids.length, defaultValue: 'Uninstall queued for {{count}} agent(s)' }));
        skippedToast(r?.skipped);
      } catch (err) {
        toast.error(agentUpdateErrorMessage(err, t, t('agents.list.batch.failed', 'The action failed')));
      }
    });
  };

  const batchDelete = async () => {
    const ids = sel.ids;
    if (!(await confirm({
      title: t('agents.list.batch.delete', 'Delete'),
      message: t('agents.list.batch.confirmDelete', {
        count: ids.length,
        defaultValue: 'Delete {{count}} agent(s)? A running agent re-enrols as pending; use Uninstall to remove it from the host. This cannot be undone. Type {{count}} to confirm.',
      }),
      danger: true,
      requireText: String(ids.length),
    }))) return;
    await runBatch(async () => {
      try {
        const r = await agentApi.bulkDeleteDevices(ids);
        toast.success(t('agents.list.batch.deleted', { count: r?.affected ?? ids.length, defaultValue: '{{count}} agent(s) deleted' }));
        skippedToast(r?.skipped);
      } catch (err) {
        toast.error(agentUpdateErrorMessage(err, t, t('agents.list.batch.failed', 'The action failed')));
      }
    });
  };

  // ── CSV export (whole filtered set) ──────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: AgentListRow[] = [];
      for (let p = 1; all.length < EXPORT_MAX_ROWS; p++) {
        const res = await agentApi.listPaged({ ...query, page: p, pageSize: AGENT_LIST_MAX_PAGE_SIZE });
        all.push(...res.rows);
        if (res.rows.length < AGENT_LIST_MAX_PAGE_SIZE || all.length >= res.total) break;
      }
      // saveCsv: UTF-8 BOM so Excel reads accented host / group names.
      const ok = await saveCsv(
        ['id', 'name', 'hostname', 'ip', 'tenant', 'group', 'approval', 'online', 'version', 'latest_version', 'update_phase',
          'last_seen', 'events_24h', 'bans_24h', 'evaluate_only', 'type', 'os'],
        all.slice(0, EXPORT_MAX_ROWS).map((d) => [
          d.id, d.name ?? '', d.hostname, d.ip ?? '', d.tenantName ?? d.tenantId, d.groupName ?? '', d.status, d.wsConnected,
          d.agentVersion ?? '', d.latestAgentVersion ?? '', d.update?.phase ?? '', d.lastSeenAt ?? '', d.events24h, d.bans24h,
          !!d.evaluateOnly, d.deviceType, osLabel(d),
        ]),
        `agents-${new Date().toISOString().slice(0, 10)}.csv`,
      );
      if (!ok) toast.error(t('agents.list.exportFailed', 'Export failed'));
    } catch {
      toast.error(t('agents.list.exportFailed', 'Export failed'));
    } finally {
      setExporting(false);
    }
  };

  // ── Column picker ────────────────────────────────────────────────────────
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  useClickOutside(columnsRef, () => setColumnsOpen(false), columnsOpen);
  const toggleColumn = (c: AgentColumn) => {
    setColumns((prev) => {
      const base = Array.isArray(prev) ? prev : [...DEFAULT_COLUMNS];
      return base.includes(c) ? base.filter((x) => x !== c) : [...base, c];
    });
  };

  // ── Labels ───────────────────────────────────────────────────────────────
  const chipLabel = (c: AgentListChip): string => {
    switch (c) {
      case 'online': return t('status.agent.online', 'Online');
      case 'offline': return t('status.agent.offline', 'Offline');
      case 'pending': return t('status.agent.pending', 'Pending');
      case 'suspended': return t('status.agent.suspended', 'Suspended');
      case 'refused': return t('status.agent.refused', 'Refused');
      case 'updating': return t('status.agent.updating', 'Updating');
      case 'update_failed': return t('status.agent.updateFailed', 'Update failed');
      case 'evaluate_only': return t('status.agent.evaluateOnly', 'Evaluate only');
      case 'outdated': return t('agents.list.chip.outdated', 'Outdated');
      default: return c;
    }
  };
  const columnLabel = (c: AgentColumn): string => {
    switch (c) {
      case 'status': return t('agents.list.col.status', 'Status');
      case 'approval': return t('agents.list.col.approval', 'Approval');
      case 'group': return t('agents.list.col.group', 'Group');
      case 'tenant': return t('agents.list.col.tenant', 'Workspace');
      case 'version': return t('agents.list.col.version', 'Version');
      case 'lastSeen': return t('agents.list.col.lastSeen', 'Last seen');
      case 'events24h': return t('agents.list.col.events24h', 'Events 24h');
      case 'bans24h': return t('agents.list.col.bans24h', 'Bans 24h');
      case 'evaluateOnly': return t('agents.list.col.evaluateOnly', 'Evaluate only');
      case 'type': return t('agents.list.col.type', 'Type');
      case 'ip': return t('agents.list.col.ip', 'IP');
      case 'os': return t('agents.list.col.os', 'OS');
      default: return c;
    }
  };
  const typeLabel = (type: AgentListRow['deviceType']): string => {
    if (type === 'mikrotik') return t('agents.list.type.mikrotik', 'MikroTik');
    if (type === 'm365') return t('agents.list.type.m365', 'Microsoft 365');
    return t('agents.list.type.agent', 'Agent');
  };

  const onSort = (field: AgentListSortField) => setSort((s) => nextSort(s, field));
  const hasFilters = filters.q.trim() !== '' || filters.chips.length > 0 || filters.type !== '' || tenantIds.length > 0;
  const clearFilters = () => {
    setSearchInput('');
    setFilters({ q: '', chips: [], type: '' });
    if (!embedded && !tenantFilter.isEmpty) tenantFilter.setValue(new Set());
  };
  const toggleChip = (c: AgentListChip) => {
    const next = filters.chips.includes(c) ? filters.chips.filter((x) => x !== c) : [...filters.chips, c];
    setFilters({ chips: next });
  };

  const colCount = columns.length + 1 + (canBatch ? 1 : 0);
  const anyPending = selectedRows.some((d) => d.status === 'pending' || d.status === 'suspended');
  const anyApproved = selectedRows.some((d) => d.status === 'approved');

  // ── Render ───────────────────────────────────────────────────────────────
  const chipsRow = (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('agents.list.chipsLabel', 'Status filters')}>
      <ChipButton active={filters.chips.length === 0} onClick={() => setFilters({ chips: [] })} count={counts?.all}>
        {t('common.all', 'All')}
      </ChipButton>
      {AGENT_LIST_CHIPS.map((c) => {
        const n = counts?.[c] ?? 0;
        // Empty chips are hidden unless selected (they would match nothing).
        if (n === 0 && !filters.chips.includes(c)) return null;
        return (
          <ChipButton key={c} active={filters.chips.includes(c)} onClick={() => toggleChip(c)} count={n}>
            {chipLabel(c)}
          </ChipButton>
        );
      })}
    </div>
  );

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {onOpenGroups && (
          <Button variant="secondary" size="sm" onClick={onOpenGroups} className="max-w-[45%] coarse:min-h-10">
            <FolderTree size={14} className="mr-1.5 shrink-0" />
            <span className="truncate">{groupLabel ?? t('agents.list.groups.title', 'Groups')}</span>
          </Button>
        )}
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('agents.list.search', 'Search hostname, name or IP…')}
            aria-label={t('agents.list.search', 'Search hostname, name or IP…')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            className="w-full rounded-lg bg-bg-tertiary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
        </div>
        <select
          value={filters.type}
          onChange={(e) => setFilters({ type: e.target.value as AgentListDeviceType | '' })}
          aria-label={t('agents.list.col.type', 'Type')}
          className="rounded-lg border border-border bg-bg-tertiary px-2 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
        >
          <option value="">{t('agents.list.type.all', 'All types')}</option>
          {DEVICE_TYPES.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
        </select>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-lg p-2 text-text-muted hover:bg-bg-tertiary hover:text-text-primary coarse:min-h-10 coarse:min-w-10"
            title={t('agents.list.clearFilters', 'Clear filters')}
            aria-label={t('agents.list.clearFilters', 'Clear filters')}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={exporting || total === 0}
          className="rounded-lg p-2 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50 coarse:min-h-10 coarse:min-w-10"
          title={t('agents.list.export', 'Export CSV')}
          aria-label={t('agents.list.export', 'Export CSV')}
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        </button>
        <div className="relative" ref={columnsRef}>
          <button
            type="button"
            onClick={() => setColumnsOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={columnsOpen}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs transition-colors coarse:min-h-10',
              columnsOpen ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-muted hover:bg-bg-active hover:text-text-primary',
            )}
            title={t('agents.list.columns', 'Columns')}
          >
            <Columns3 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('agents.list.columns', 'Columns')}</span>
          </button>
          {columnsOpen && (
            <div
              className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-border bg-bg-secondary p-2 shadow-xl"
              onKeyDown={(e) => { if (e.key === 'Escape') setColumnsOpen(false); }}
            >
              {ALL_COLUMNS.filter((c) => c !== 'tenant' || isMaster).map((c) => (
                <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-text-primary hover:bg-bg-hover coarse:min-h-10">
                  <input
                    type="checkbox"
                    checked={columns.includes(c)}
                    onChange={() => toggleColumn(c)}
                    className="h-4 w-4 accent-accent"
                  />
                  {columnLabel(c)}
                </label>
              ))}
              <button
                type="button"
                onClick={() => setColumns([...DEFAULT_COLUMNS])}
                className="mt-1 w-full rounded px-2 py-1.5 text-left text-xs text-text-muted hover:bg-bg-hover hover:text-text-primary"
              >
                {t('agents.list.columnsReset', 'Reset columns')}
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg p-2 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary coarse:min-h-10 coarse:min-w-10"
          title={t('common.refresh')}
          aria-label={t('common.refresh')}
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      {!embedded && <TenantFilterChips value={tenantFilter.value} onChange={tenantFilter.setValue} />}
      {chipsRow}
      {groupId != null && groupId > 0 && onRecursiveChange && (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => onRecursiveChange(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {t('agents.list.includeSubgroups', 'Include sub-groups')}
        </label>
      )}

      {/* Batch bar */}
      {canBatch && sel.count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2" role="toolbar" aria-label={t('agents.list.batch.label', 'Batch actions')}>
          <span className="text-sm font-medium text-text-primary">
            {t('agents.list.batch.selected', { count: sel.count, defaultValue: '{{count}} selected' })}
          </span>
          <div className="flex flex-1 flex-wrap items-center gap-1.5">
            {canUpdate && (
              <BatchButton icon={<ArrowUpCircle size={13} />} onClick={batchUpdate} disabled={busy}>{t('agents.list.batch.update', 'Update')}</BatchButton>
            )}
            {canApprove && anyPending && (
              <BatchButton icon={<CheckCircle2 size={13} />} onClick={() => batchStatus('approved')} disabled={busy}>{t('agents.list.batch.approve', 'Approve')}</BatchButton>
            )}
            {canApprove && anyApproved && (
              <BatchButton icon={<Ban size={13} />} onClick={() => batchStatus('suspended')} disabled={busy}>{t('agents.list.batch.suspend', 'Suspend')}</BatchButton>
            )}
            {canManage && (
              <BatchButton icon={<FolderInput size={13} />} onClick={() => setMoveOpen(true)} disabled={busy}>{t('agents.list.batch.move', 'Move to group')}</BatchButton>
            )}
            {(canManage || isPlatformAdmin) && (
              <BatchButton icon={<Pencil size={13} />} onClick={() => setEditOpen(true)} disabled={busy}>{t('agents.list.batch.edit', 'Edit settings')}</BatchButton>
            )}
            {canDelete && (
              <BatchButton icon={<UserX size={13} />} onClick={batchUninstall} disabled={busy} danger>{t('agents.list.batch.uninstall', 'Uninstall')}</BatchButton>
            )}
            {canDelete && (
              <BatchButton icon={<Trash2 size={13} />} onClick={batchDelete} disabled={busy} danger>{t('agents.list.batch.delete', 'Delete')}</BatchButton>
            )}
          </div>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-accent" />}
          <button
            type="button"
            onClick={sel.clear}
            className="rounded p-1 text-text-muted hover:text-text-primary coarse:min-h-10 coarse:min-w-10"
            title={t('agents.list.batch.clear', 'Clear selection')}
            aria-label={t('agents.list.batch.clear', 'Clear selection')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Table */}
      <TableScroll className="bg-bg-secondary" stickyFirstCol={!canBatch}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-medium">
              {canBatch && (
                <th scope="col" className="w-8">
                  <input
                    type="checkbox"
                    aria-label={t('agents.list.selectPage', 'Select the agents of this page')}
                    checked={sel.headerState === 'checked'}
                    ref={(el) => { if (el) el.indeterminate = sel.headerState === 'indeterminate'; }}
                    onChange={() => sel.toggleAllVisible()}
                    disabled={selectableIds.length === 0}
                    className="h-4 w-4 accent-accent"
                  />
                </th>
              )}
              <SortableTh field="name" sort={sort} onSort={onSort}>{t('agents.list.col.name', 'Agent')}</SortableTh>
              {columns.map((c) => {
                const field = COLUMN_SORT[c];
                const align = NUMERIC_COLUMNS.has(c) ? 'right' : 'left';
                return field
                  ? <SortableTh key={c} field={field} sort={sort} onSort={onSort} align={align}>{columnLabel(c)}</SortableTh>
                  : <th key={c} scope="col" className={cn(align === 'right' && 'text-right')}>{columnLabel(c)}</th>;
              })}
            </tr>
          </thead>
          <tbody className={cn(loading && rows.length > 0 && 'opacity-60 transition-opacity')}>
            {loading && !data ? (
              <TableSkeleton rows={Math.min(safePageSize, 10)} cols={colCount} />
            ) : rows.length === 0 ? (
              failed ? (
                <EmptyState
                  colSpan={colCount}
                  title={t('agents.list.loadFailed', 'Failed to load the agents')}
                  action={<Button size="sm" variant="secondary" onClick={() => void load()}>{t('common.retry')}</Button>}
                />
              ) : hasFilters ? (
                <EmptyState variant="filtered" colSpan={colCount} onClearFilters={clearFilters} />
              ) : (
                <EmptyState
                  colSpan={colCount}
                  icon={<Cpu className="h-8 w-8" />}
                  title={t('agents.list.empty', 'No agents yet')}
                  description={t('agents.list.emptyHint', 'Install an agent with an enrolment key: it appears here as pending until approved.')}
                />
              )
            ) : rows.map((d) => {
              const writable = isWritable(d);
              return (
                <tr
                  key={d.id}
                  className={cn(
                    'border-b border-border/60 transition-colors last:border-0 hover:bg-bg-hover/60 [&>td]:px-3 [&>td]:py-2',
                    sel.isSelected(d.id) && 'bg-accent/5',
                  )}
                >
                  {canBatch && (
                    <td className="w-8">
                      <input
                        type="checkbox"
                        checked={sel.isSelected(d.id)}
                        onChange={() => sel.toggle(d.id)}
                        disabled={!writable}
                        aria-label={t('agents.list.selectAgent', { name: d.name ?? d.hostname, defaultValue: 'Select {{name}}' })}
                        title={writable ? undefined : t('agents.foreignReadOnlyShort', 'Read-only (other tenant)')}
                        className="h-4 w-4 accent-accent disabled:opacity-30"
                      />
                    </td>
                  )}
                  <td className="min-w-[10rem] max-w-[18rem]">
                    <Link to={`/agents/${d.id}`} className="block min-w-0 hover:underline">
                      <span className="flex items-center gap-1.5">
                        <TypeIcon type={d.deviceType} />
                        <span className="truncate font-medium text-text-primary">{anonHostname(d.name ?? d.hostname)}</span>
                      </span>
                      {d.name && d.name !== d.hostname && (
                        <span className="block truncate text-xs text-text-muted">{anonHostname(d.hostname)}</span>
                      )}
                    </Link>
                  </td>
                  {columns.map((c) => (
                    <td key={c} className={cn('whitespace-nowrap', NUMERIC_COLUMNS.has(c) && 'text-right tabular-nums')}>
                      {renderCell(c, d)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>

      <Pagination
        page={page}
        pageSize={safePageSize}
        total={total}
        onChange={setPage}
        pageSizeOptions={PAGE_SIZES}
        onPageSizeChange={setPageSize}
        disabled={loading}
      />

      <MoveGroupModal
        open={moveOpen}
        count={sel.count}
        onClose={() => setMoveOpen(false)}
        onMove={(gid) => void batchMove(gid)}
      />
      <BulkEditModal
        open={editOpen}
        count={sel.count}
        canEditSettings={canManage}
        canEditPolicy={isPlatformAdmin}
        onClose={() => setEditOpen(false)}
        onSave={(patch) => void batchEdit(patch)}
      />
    </div>
  );

  function renderCell(c: AgentColumn, d: AgentListRow): ReactNode {
    switch (c) {
      case 'status':
        return <AgentStatusBadge device={d} size="sm" showEvaluateOnly={false} />;
      case 'approval':
        return <ApprovalPill status={d.status} />;
      case 'group':
        return d.groupId != null
          ? <Link to={`/group/${d.groupId}`} className="text-text-secondary hover:text-text-primary hover:underline">{anonHostname(d.groupName ?? `#${d.groupId}`)}</Link>
          : <span className="text-text-muted">{t('nav.ungrouped', 'Ungrouped')}</span>;
      case 'tenant':
        return <TenantBadge tenantId={d.tenantId} tenantName={d.tenantName} />;
      case 'version':
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs text-text-secondary">{d.agentVersion ? `v${d.agentVersion}` : '—'}</span>
            {d.updateAvailable && (
              <span title={t('agents.list.outdatedTitle', { version: d.latestAgentVersion ?? '?', defaultValue: 'v{{version}} available' })}>
                <ArrowUpCircle size={13} className="text-sky-400" aria-hidden />
                <span className="sr-only">{t('agents.list.chip.outdated', 'Outdated')}</span>
              </span>
            )}
            <UpdateStatusBadge device={d} size="sm" canRetry={canUpdate && isWritable(d)} onRetried={() => void load()} />
          </span>
        );
      case 'lastSeen':
        return <LastSeenPill lastSeenAt={d.lastSeenAt} />;
      case 'events24h':
        return d.events24h > 0 ? d.events24h.toLocaleString() : <span className="text-text-muted">0</span>;
      case 'bans24h':
        return d.bans24h > 0 ? <span className="text-red-400">{d.bans24h.toLocaleString()}</span> : <span className="text-text-muted">0</span>;
      case 'evaluateOnly':
        return d.evaluateOnly
          ? <AgentStatusBadge status="evaluate_only" size="sm" showDot={false} />
          : <span className="text-text-muted">—</span>;
      case 'type':
        return <span className="text-text-secondary">{typeLabel(d.deviceType)}</span>;
      case 'ip':
        return <span className="font-mono text-xs text-text-secondary">{d.ip ? anonIp(d.ip) : '—'}</span>;
      case 'os':
        return <span className="text-text-secondary">{osLabel(d) || '—'}</span>;
      default:
        return null;
    }
  }
}

function osLabel(d: Pick<AgentListRow, 'osInfo'>): string {
  const o = d.osInfo;
  if (!o) return '';
  return [o.distro || o.platform, o.release, o.arch].filter(Boolean).join(' ');
}

function TypeIcon({ type }: { type: AgentListRow['deviceType'] }) {
  if (type === 'mikrotik') return <Router size={13} className="shrink-0 text-text-muted" aria-hidden />;
  if (type === 'm365') return <Shield size={13} className="shrink-0 text-text-muted" aria-hidden />;
  return <Cpu size={13} className="shrink-0 text-text-muted" aria-hidden />;
}

function ApprovalPill({ status }: { status: AgentListRow['status'] }) {
  const { t } = useTranslation();
  if (status !== 'approved') return <AgentStatusBadge status={status} size="sm" showDot={false} />;
  return (
    <span className="inline-flex items-center rounded-full border border-status-up/30 bg-status-up/10 px-2 py-0.5 text-xs font-medium text-status-up">
      {t('agents.list.approved', 'Approved')}
    </span>
  );
}

function ChipButton({ active, onClick, count, children }: { active: boolean; onClick: () => void; count?: number; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-9',
        active
          ? 'border-accent/40 bg-accent/15 text-accent'
          : 'border-border bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
      )}
    >
      {children}
      {count !== undefined && <span className="tabular-nums opacity-70">{count.toLocaleString()}</span>}
    </button>
  );
}

function BatchButton({ icon, onClick, disabled, danger, children }: {
  icon: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 coarse:min-h-10',
        danger
          ? 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
          : 'border-border bg-bg-secondary text-text-primary hover:bg-bg-hover',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/** Target group of a batch move: the operating tenant's groups only (bulk writes never cross tenants). */
function MoveGroupModal({ open, count, onClose, onMove }: {
  open: boolean; count: number; onClose: () => void; onMove: (groupId: number | null) => void;
}) {
  const { t } = useTranslation();
  const tree = useGroupStore((s) => s.tree);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [target, setTarget] = useState<number | null>(null);
  useEffect(() => { if (open) setTarget(null); }, [open]);
  const ownTree = useMemo<GroupTreeNode[]>(
    () => tree.filter((n) => n.kind === 'agent' && (n.tenantId == null || n.tenantId === currentTenantId)),
    [tree, currentTenantId],
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      phoneLayout="sheet"
      icon={<FolderInput className="h-4 w-4 text-accent" />}
      title={t('agents.list.batch.moveTitle', { count, defaultValue: 'Move {{count}} agent(s)' })}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => onMove(target)}>{t('agents.list.batch.moveConfirm', 'Move')}</Button>
        </>
      )}
    >
      <p className="mb-3 text-sm text-text-muted">
        {t('agents.list.batch.moveHint', 'Pick the target group, or none to make the agents ungrouped.')}
      </p>
      <GroupPicker value={target} onChange={setTarget} tree={ownTree} kindFilter="agent" placeholder={t('agents.noGroup')} />
    </Modal>
  );
}

/**
 * Batch settings: override of the group settings (agents.manage) and the
 * agent update policy (platform admins only — owner directive C17; 'off'
 * freezes the agent whatever the levels above say).
 */
function BulkEditModal({ open, count, canEditSettings, canEditPolicy, onClose, onSave }: {
  open: boolean;
  count: number;
  canEditSettings: boolean;
  canEditPolicy: boolean;
  onClose: () => void;
  onSave: (patch: { overrideGroupSettings?: boolean; updatePolicy?: AgentUpdatePolicy | null }) => void;
}) {
  const { t } = useTranslation();
  const [override, setOverride] = useState<'keep' | 'on' | 'off'>('keep');
  const [policy, setPolicy] = useState<'keep' | 'inherit' | AgentUpdatePolicy>('keep');
  useEffect(() => {
    if (open) { setOverride('keep'); setPolicy('keep'); }
  }, [open]);

  const save = () => {
    const patch: { overrideGroupSettings?: boolean; updatePolicy?: AgentUpdatePolicy | null } = {};
    if (canEditSettings && override !== 'keep') patch.overrideGroupSettings = override === 'on';
    if (canEditPolicy && policy !== 'keep') patch.updatePolicy = policy === 'inherit' ? null : policy;
    onSave(patch);
  };
  const selectCls = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      phoneLayout="sheet"
      icon={<Pencil className="h-4 w-4 text-accent" />}
      title={t('agents.bulkEditTitle', { count })}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={save} disabled={override === 'keep' && policy === 'keep'}>{t('common.apply')}</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <p className="text-xs text-text-muted">{t('agents.bulkEditDesc')}</p>
        {canEditSettings && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-text-secondary">{t('agents.overrideGroupSettings')}</span>
            <select value={override} onChange={(e) => setOverride(e.target.value as 'keep' | 'on' | 'off')} className={selectCls}>
              <option value="keep">{t('agents.keepCurrent')}</option>
              <option value="on">{t('common.on')}</option>
              <option value="off">{t('common.off')}</option>
            </select>
          </label>
        )}
        {canEditPolicy && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-text-secondary">{t('agentUpdate.policyLabel', 'Agent updates')}</span>
            <select value={policy} onChange={(e) => setPolicy(e.target.value as 'keep' | 'inherit' | AgentUpdatePolicy)} className={selectCls}>
              <option value="keep">{t('agents.keepCurrent')}</option>
              <option value="inherit">{t('agentUpdate.policy.inherit', 'Inherit')}</option>
              <option value="auto">{t('agentUpdate.policy.auto', 'Automatic')}</option>
              <option value="manual">{t('agentUpdate.policy.manual', 'Manual')}</option>
              <option value="off">{t('agentUpdate.policy.off', 'Off (frozen)')}</option>
            </select>
          </label>
        )}
      </div>
    </Modal>
  );
}
