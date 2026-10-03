import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Pencil, Trash2, ArrowLeft, Server, Globe, ArrowUpCircle, ChevronRight, ChevronDown,
  FileCode2, Gauge, Bell, Eye, SlidersHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { anonHostname } from '@/utils/anonymize';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useAgentDevices, useAgentDevicesLoaded } from '@/store/agentStore';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import { useCan } from '@/hooks/usePermission';
import { agentUpdateErrorMessage, findGroupInTree, visibleUpdateAttempt } from '@/utils/agentUpdate';
import { groupsApi } from '@/api/groups.api';
import { agentApi } from '@/api/agent.api';
import { serviceTemplatesApi } from '@/api/serviceTemplates.api';
import { rateLimitPoliciesApi } from '@/api/rateLimitPolicies.api';
import { notificationsApi } from '@/api/notifications.api';
import type {
  MonitorGroup, AgentDevice, GroupTreeNode, ResolvedServiceConfig, RateLimitPolicy, ServiceTemplate,
} from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { TenantBadge } from '@/components/common/TenantBadge';
import { EvaluateOnlyBanner } from '@/components/common/EvaluateOnlyBanner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { resolveAgentStatus } from '@/components/status/AgentStatusBadge';
import { AgentTable } from '@/components/agents/AgentTable';
import { useGroupUpdatePolicyView, type GroupEditTab, type GroupUpdatePolicyView } from '@/pages/GroupEditPage';
import toast from 'react-hot-toast';

// Mirrors Obliance GroupDetailPage: header (name, path, tenant, badges, edit /
// delete), an "Attached policies" summary and the group's agents. Every
// setting is edited on /group/:id/edit (tabbed): nothing is edited here.

function apiError(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Ids of `groupId` and all its descendants in the tree (just the id when absent). */
function subtreeIds(tree: GroupTreeNode[], groupId: number): Set<number> {
  const ids = new Set<number>([groupId]);
  const collect = (n: GroupTreeNode) => { ids.add(n.id); n.children.forEach(collect); };
  const root = findGroupInTree(tree, groupId);
  if (root) collect(root);
  return ids;
}

/** Ancestors of a group, root first (stops at a group missing from the tree). */
function ancestorPath(tree: GroupTreeNode[], group: MonitorGroup): GroupTreeNode[] {
  const path: GroupTreeNode[] = [];
  const seen = new Set<number>([group.id]);
  let parentId = group.parentId;
  while (parentId != null && !seen.has(parentId)) {
    seen.add(parentId);
    const g = findGroupInTree(tree, parentId);
    if (!g) break;
    path.unshift(g);
    parentId = g.parentId;
  }
  return path;
}

/** Nearest ancestor (group itself excluded) in evaluate-only mode. */
function evaluateOnlyAncestor(path: GroupTreeNode[]): GroupTreeNode | null {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].evaluateOnly) return path[i];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attached policies (read-only summary, links to the edit page tabs)
// ─────────────────────────────────────────────────────────────────────────────

interface PolicyChip {
  key: string;
  label: string;
  hint?: string;
  muted?: boolean;
}

/** null = not loaded yet, 'error' = could not be loaded, else the rows. */
type Loaded<T> = T | null | 'error';

function PolicyRow({ icon, label, editHref, count, chips, empty, children }: {
  icon: ReactNode;
  label: string;
  /** Edit page tab, when the user may edit the group. */
  editHref?: string;
  count?: number | null;
  chips?: Loaded<PolicyChip[]>;
  empty?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3 py-3 max-sm:flex-col max-sm:gap-1.5">
      <div className="flex w-48 shrink-0 items-center gap-2 max-sm:w-auto">
        <span className="text-accent" aria-hidden="true">{icon}</span>
        <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</span>
        {count != null && <span className="text-xs text-text-muted/70">({count})</span>}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {children}
        {chips === null && <span className="text-xs text-text-muted">…</span>}
        {chips === 'error' && (
          <span className="text-xs text-amber-400">{t('groups.policies.loadFailed', { defaultValue: 'Could not be loaded' })}</span>
        )}
        {Array.isArray(chips) && chips.length === 0 && empty && (
          <span className="text-xs text-text-muted">{empty}</span>
        )}
        {Array.isArray(chips) && chips.map(c => (
          <span
            key={c.key}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded bg-bg-tertiary/60 px-2 py-0.5 text-xs coarse:min-h-8',
              c.muted ? 'text-text-muted line-through' : 'text-text-secondary',
            )}
          >
            <span className="truncate">{c.label}</span>
            {c.hint && <span className="shrink-0 font-mono text-[10px] text-text-muted/80">{c.hint}</span>}
          </span>
        ))}
      </div>
      {editHref && (
        <Link
          to={editHref}
          className="shrink-0 text-xs font-medium text-accent hover:underline coarse:min-h-8 coarse:inline-flex coarse:items-center"
        >
          {t('groups.policies.manage', { defaultValue: 'Manage' })}
        </Link>
      )}
    </div>
  );
}

function GroupPoliciesPanel({ group, canEdit, updatePolicy, evaluateOnlySource }: {
  group: MonitorGroup;
  canEdit: boolean;
  updatePolicy: GroupUpdatePolicyView;
  /** Group whose evaluate-only flag applies (this group or an ancestor). */
  evaluateOnlySource: { id: number; name: string } | null;
}) {
  const { t } = useTranslation();
  const canSeeBindings = useCan('notifications.manage');
  const [open, setOpen] = useState(true);
  const [templates, setTemplates] = useState<Loaded<ResolvedServiceConfig[]>>(null);
  const [localTemplates, setLocalTemplates] = useState<Loaded<ServiceTemplate[]>>(null);
  const [limits, setLimits] = useState<Loaded<RateLimitPolicy[]>>(null);
  const [bindings, setBindings] = useState<Loaded<Awaited<ReturnType<typeof notificationsApi.getResolvedBindings>>>>(null);

  useEffect(() => {
    let cancelled = false;
    const settle = <T,>(p: Promise<T>, set: (v: Loaded<T>) => void) => {
      set(null);
      p.then(v => { if (!cancelled) set(v); }, () => { if (!cancelled) set('error'); });
    };
    settle(serviceTemplatesApi.getResolvedForGroup(group.id), setTemplates);
    settle(serviceTemplatesApi.listLocal('group', group.id), setLocalTemplates);
    settle(rateLimitPoliciesApi.list('group', group.id), setLimits);
    if (canSeeBindings) settle(notificationsApi.getResolvedBindings('group', group.id), setBindings);
    return () => { cancelled = true; };
  }, [group.id, canSeeBindings]);

  const edit = (tab: GroupEditTab) => (canEdit ? `/group/${group.id}/edit?tab=${tab}` : undefined);

  const templateChips: Loaded<PolicyChip[]> = Array.isArray(templates)
    ? templates.filter(c => c.enabled).map(c => ({
        key: `t${c.templateId}`,
        label: c.name,
        hint: `${c.mode === 'ban' ? t('groups.policies.modeBan', { defaultValue: 'ban' }) : t('groups.policies.modeTrack', { defaultValue: 'track' })} ${c.threshold}/${c.windowSeconds}s`,
      }))
    : templates;
  const ownTemplates = Array.isArray(localTemplates) ? localTemplates.length : null;

  const limitChips: Loaded<PolicyChip[]> = Array.isArray(limits)
    ? limits.map(p => ({
        key: `l${p.id}`,
        label: t(`networkLimiting.types.${p.type}`, { defaultValue: p.type }),
        hint: `${p.port != null ? `:${p.port} ` : ''}${p.maxValue}${p.type === 'volume' ? ' Mbit/s' : p.type === 'rate' ? '/s' : ''}`,
        muted: !p.enabled,
      }))
    : limits;

  const bindingChips: Loaded<PolicyChip[]> = Array.isArray(bindings)
    ? bindings.map(b => ({
        key: `n${b.channelId}`,
        label: b.channelName,
        hint: b.isDirect
          ? t('groups.policies.direct', { defaultValue: 'direct' })
          : t('groups.policies.inheritedFrom', { defaultValue: 'from {{name}}', name: anonHostname(b.sourceName) }),
        muted: b.isExcluded,
      }))
    : bindings;

  const cfg = group.agentGroupConfig;
  const policy = updatePolicy.effective;
  const ownPolicy = cfg?.updatePolicy ?? null;
  const enabledTemplates = Array.isArray(templateChips) ? templateChips.length : null;

  return (
    <section className="rounded-lg border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-bg-tertiary/40 transition-colors coarse:min-h-11"
      >
        {open ? <ChevronDown size={16} className="text-text-muted" /> : <ChevronRight size={16} className="text-text-muted" />}
        <h2 className="text-sm font-semibold text-text-primary">
          {t('groups.policies.title', { defaultValue: 'Attached policies' })}
        </h2>
      </button>
      {open && (
        <div className="divide-y divide-border border-t border-border px-4">
          <PolicyRow
            icon={<FileCode2 size={14} />}
            label={t('groups.tabs.serviceTemplates', { defaultValue: 'Service templates' })}
            count={enabledTemplates}
            chips={templateChips}
            empty={t('groups.policies.noTemplates', { defaultValue: 'No active template' })}
            editHref={edit('templates')}
          >
            {ownTemplates != null && ownTemplates > 0 && (
              <span className="text-xs text-text-muted">
                {t('groups.policies.ownTemplates', { defaultValue: '{{count}} owned by this group ·', count: ownTemplates })}
              </span>
            )}
          </PolicyRow>

          <PolicyRow
            icon={<Gauge size={14} />}
            label={t('groups.tabs.networkLimits', { defaultValue: 'Network limits' })}
            count={Array.isArray(limits) ? limits.length : null}
            chips={limitChips}
            empty={t('groups.policies.noLimits', { defaultValue: 'No limit set on this group' })}
            editHref={edit('limits')}
          />

          {canSeeBindings && (
            <PolicyRow
              icon={<Bell size={14} />}
              label={t('groups.tabs.notifications', { defaultValue: 'Notifications' })}
              count={Array.isArray(bindings) ? bindings.filter(b => !b.isExcluded).length : null}
              chips={bindingChips}
              empty={t('groups.policies.noChannels', { defaultValue: 'No channel' })}
              editHref={edit('notifications')}
            />
          )}

          <PolicyRow
            icon={<Eye size={14} />}
            label={t('evaluateOnly.groupTitle')}
            editHref={edit('agent')}
          >
            {evaluateOnlySource ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">
                {evaluateOnlySource.id === group.id
                  ? t('groups.policies.evaluateOnlyOn', { defaultValue: 'On' })
                  : t('groups.policies.evaluateOnlyInherited', {
                      defaultValue: 'On (inherited from {{name}})',
                      name: anonHostname(evaluateOnlySource.name),
                    })}
              </span>
            ) : (
              <span className="text-xs text-text-muted">{t('groups.policies.evaluateOnlyOff', { defaultValue: 'Off: bans are enforced' })}</span>
            )}
          </PolicyRow>

          <PolicyRow
            icon={<ArrowUpCircle size={14} />}
            label={t('agentUpdate.policyLabel', 'Agent updates')}
            editHref={edit('agent')}
          >
            {policy ? (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                  policy.policy === 'off' ? 'bg-amber-500/10 text-amber-500' : 'bg-bg-tertiary text-text-secondary',
                )}
              >
                {t(`agentUpdate.policy.${policy.policy}`, policy.policy)}
                {updatePolicy.effectiveSourceText && (
                  <span className="text-text-muted">· {updatePolicy.effectiveSourceText}</span>
                )}
              </span>
            ) : (
              <span className="text-xs text-text-secondary">
                {ownPolicy
                  ? t(`agentUpdate.policy.${ownPolicy}`, ownPolicy)
                  : t('agentUpdate.policy.inherit', 'Inherit')}
              </span>
            )}
          </PolicyRow>

          <PolicyRow
            icon={<SlidersHorizontal size={14} />}
            label={t('groups.tabs.agentSettings', { defaultValue: 'Agent settings' })}
            editHref={edit('agent')}
          >
            <span className="text-xs text-text-secondary">
              {t('groups.detail.pushInterval')}:{' '}
              {cfg?.pushIntervalSeconds != null
                ? `${cfg.pushIntervalSeconds}${t('groups.detail.seconds')}`
                : t('groups.settings.default', { defaultValue: 'Default' })}
            </span>
            <span className="text-xs text-text-muted" aria-hidden="true">·</span>
            <span className="text-xs text-text-secondary">
              {t('groups.detail.maxMissedPushes')}:{' '}
              {cfg?.maxMissedPushes != null ? cfg.maxMissedPushes : t('groups.settings.default', { defaultValue: 'Default' })}
            </span>
          </PolicyRow>
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main GroupDetailPage
// ─────────────────────────────────────────────────────────────────────────────

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Keyed on the id: following a path link to another group starts from a clean state.
  return <GroupDetailView key={id} id={id!} />;
}

function GroupDetailView({ id }: { id: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const confirmAction = useConfirm();
  const { canWriteGroup } = useAuthStore();
  const { getGroup, removeGroup, fetchGroups, fetchTree } = useGroupStore();

  const groupId = parseInt(id, 10);
  const storeGroup = getGroup(groupId);
  const canWrite = canWriteGroup(groupId);
  const canUpdateAgents = useCan('agents.update');

  const [group, setGroup] = useState<MonitorGroup | null>(storeGroup ?? null);
  const [deviceRows, setDeviceRows] = useState<AgentDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const tree = useGroupStore(s => s.tree);
  // Live rows of the shared agent store (socket deltas + poll) win over the
  // page's snapshot, so presence and status stay current.
  const liveDevices = useAgentDevices();
  const liveLoaded = useAgentDevicesLoaded();

  // Writes follow the operating tenant: another tenant's group (Default god
  // view) is read-only here.
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  const isOwnTenantGroup = group?.tenantId === undefined || group.tenantId === currentTenantId;
  const [requestingUpdate, setRequestingUpdate] = useState(false);
  const updatePolicy = useGroupUpdatePolicyView(group, !isOwnTenantGroup);

  // Fetch group + agent devices (whole sub-tree, every status but refused)
  const loadData = useCallback(async () => {
    // Settled separately: a failed device list never hides the group itself.
    const [g, rows] = await Promise.allSettled([
      groupsApi.getById(groupId),
      agentApi.listDevices({ groupId, recursive: true }),
    ]);
    if (g.status === 'fulfilled') setGroup(g.value);
    if (rows.status === 'fulfilled') setDeviceRows(rows.value.filter(d => d.status !== 'refused'));
    const failed = g.status === 'rejected' ? g : rows.status === 'rejected' ? rows : null;
    if (failed) toast.error(apiError(failed.reason) ?? t('groups.failedLoad', 'Failed to load the group'));
    setLoading(false);
  }, [groupId, t]);

  useEffect(() => { void loadData(); }, [loadData]);

  // Socket reconnected: events emitted meanwhile are lost — reload.
  useEffect(() => {
    const onResync = () => { void loadData(); };
    window.addEventListener(SOCKET_RESYNC_EVENT, onResync);
    return () => window.removeEventListener(SOCKET_RESYNC_EVENT, onResync);
  }, [loadData]);

  // A device that leaves the store (AGENT_DEVICE_DELETED, uninstall) leaves
  // the page snapshot too, instead of lingering until the next reload.
  const prevLiveIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const ids = new Set(liveDevices.map(d => d.id));
    const gone = [...prevLiveIdsRef.current].filter(id => !ids.has(id));
    prevLiveIdsRef.current = ids;
    // Rows of another user / tenant not loaded yet: not a deletion.
    if (gone.length > 0 && liveLoaded) {
      setDeviceRows(prev => prev.filter(d => !gone.includes(d.id)));
    }
  }, [liveDevices, liveLoaded]);

  const devices = useMemo(() => {
    // Client-side sub-tree guard (also covers a server ignoring ?groupId).
    const ids = subtreeIds(tree, groupId);
    const liveById = new Map(liveDevices.map(d => [d.id, d]));
    return deviceRows
      .map(d => liveById.get(d.id) ?? d)
      .filter(d => d.status !== 'refused' && d.groupId != null && ids.has(d.groupId));
  }, [deviceRows, liveDevices, tree, groupId]);

  const stats = useMemo(() => {
    const s = { total: devices.length, online: 0, offline: 0, pending: 0, updateFailed: 0 };
    for (const d of devices) {
      // Live presence of approved agents (an agent restarting for an update
      // counts as neither online nor offline).
      if (d.status === 'approved' && d.wsConnected) s.online++;
      const status = resolveAgentStatus(d);
      if (status === 'offline') s.offline++;
      if (status === 'pending') s.pending++;
      const attempt = visibleUpdateAttempt({ update: d.update ?? null, agentVersion: d.agentVersion ?? null });
      if (attempt?.phase === 'failed') s.updateFailed++;
    }
    return s;
  }, [devices]);

  const path = useMemo(() => (group ? ancestorPath(tree, group) : []), [tree, group]);

  if (loading && !group) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!group) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-text-muted">{t('groups.notFound', { defaultValue: 'Group not found' })}</p>
        <Link to="/" className="mt-4">
          <Button variant="secondary">{t('groups.backToDashboard', { defaultValue: 'Back to dashboard' })}</Button>
        </Link>
      </div>
    );
  }

  const handleDelete = async () => {
    const ok = await confirmAction({ message: t('groups.confirmDelete', { name: group.name }), danger: true });
    if (!ok) return;
    try {
      await groupsApi.delete(groupId);
      removeGroup(groupId);
      fetchGroups();
      fetchTree();
      toast.success(t('groups.deleted'));
      navigate('/');
    } catch (err) {
      toast.error(apiError(err) ?? t('groups.failedDelete'));
    }
  };

  const handleGroupUpdate = async () => {
    const ok = await confirmAction(t('agentUpdate.groupConfirm', 'Request an update for every outdated agent of this group and its sub-groups?'));
    if (!ok) return;
    setRequestingUpdate(true);
    try {
      const r = await agentApi.requestGroupUpdate(group.id);
      const skipped = r.skipped.off + r.skipped.current + r.skipped.notUpdatable + r.skipped.notFound;
      toast.success(t('agentUpdate.bulkResult', {
        defaultValue: '{{requested}} update(s) requested, {{skipped}} skipped',
        requested: r.requested,
        skipped,
      }));
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('groups.failedUpdate')));
    } finally {
      setRequestingUpdate(false);
    }
  };

  const evalAncestor = evaluateOnlyAncestor(path);
  const evaluateOnlySource = group.evaluateOnly
    ? { id: group.id, name: group.name }
    : evalAncestor ? { id: evalAncestor.id, name: evalAncestor.name } : null;
  const frozen = updatePolicy.effective?.policy === 'off';

  const statCards: { key: string; label: string; value: number; className?: string }[] = [
    { key: 'total', label: t('groups.detail.totalAgents'), value: stats.total },
    { key: 'online', label: t('groups.detail.online'), value: stats.online, className: 'text-status-up' },
    { key: 'offline', label: t('groups.detail.offline'), value: stats.offline, className: stats.offline > 0 ? 'text-red-400' : undefined },
    { key: 'pending', label: t('groups.detail.pending'), value: stats.pending, className: stats.pending > 0 ? 'text-blue-400' : undefined },
    { key: 'updateFailed', label: t('groups.detail.updateFailed', { defaultValue: 'Update failed' }), value: stats.updateFailed, className: stats.updateFailed > 0 ? 'text-orange-400' : undefined },
  ];

  return (
    <PageContainer className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary coarse:min-h-10">
        <ArrowLeft size={14} />
        {t('groups.backToDashboard', { defaultValue: 'Back to dashboard' })}
      </Link>

      <PageHeader
        icon={<Server size={22} className="text-accent" />}
        title={anonHostname(group.name)}
        badge={(
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <TenantBadge tenantId={group.tenantId} size="md" />
            {group.isGeneral && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                <Globe size={10} />
                {t('groups.generalBadge')}
              </span>
            )}
            {evaluateOnlySource && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500"
                title={t('evaluateOnly.badgeTooltip')}
              >
                <Eye size={10} />
                {t('evaluateOnly.badge')}
              </span>
            )}
          </span>
        )}
        description={(
          <span className="flex flex-col gap-1">
            {path.length > 0 && (
              <nav aria-label={t('groups.path', { defaultValue: 'Group path' })} className="flex flex-wrap items-center gap-1 text-xs">
                {path.map(p => (
                  <span key={p.id} className="inline-flex items-center gap-1">
                    <Link to={`/group/${p.id}`} className="text-text-secondary hover:text-text-primary hover:underline">
                      {anonHostname(p.name)}
                    </Link>
                    <ChevronRight size={12} className="text-text-muted" aria-hidden="true" />
                  </span>
                ))}
                <span className="text-text-muted">{anonHostname(group.name)}</span>
              </nav>
            )}
            {group.description && <span>{group.description}</span>}
          </span>
        )}
        actions={(
          <>
            {canUpdateAgents && isOwnTenantGroup && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleGroupUpdate}
                loading={requestingUpdate}
                disabled={frozen}
                title={frozen && updatePolicy.effectiveSourceText
                  ? t('agentUpdate.frozenBy', { defaultValue: 'Frozen by {{source}}', source: updatePolicy.effectiveSourceText })
                  : undefined}
              >
                <ArrowUpCircle size={14} className="mr-1.5" />
                {t('agentUpdate.groupUpdate', 'Update outdated agents')}
              </Button>
            )}
            {canWrite && (
              <>
                <Link to={`/group/${groupId}/edit`}>
                  <Button variant="secondary" size="sm">
                    <Pencil size={14} className="mr-1.5" />
                    {t('common.edit')}
                  </Button>
                </Link>
                {/* The server refuses deleting another tenant's group (read-only). */}
                {isOwnTenantGroup && (
                  <Button variant="danger" size="sm" onClick={handleDelete}>
                    <Trash2 size={14} className="mr-1.5" />
                    {t('common.delete')}
                  </Button>
                )}
              </>
            )}
          </>
        )}
      />

      {evaluateOnlySource && (
        <EvaluateOnlyBanner source={evaluateOnlySource.id === group.id ? null : 'group'} />
      )}

      {/* ── Stats of the sub-tree's agents (live presence) ── */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {statCards.map(c => (
          <div key={c.key} className="rounded-lg border border-border bg-bg-secondary p-4 max-sm:p-3">
            <div className="text-sm text-text-secondary mb-1 truncate">{c.label}</div>
            <div className={cn('text-xl font-mono font-semibold text-text-primary', c.className)}>{c.value}</div>
          </div>
        ))}
      </div>

      <GroupPoliciesPanel
        group={group}
        canEdit={canWrite}
        updatePolicy={updatePolicy}
        evaluateOnlySource={evaluateOnlySource}
      />

      {/* Agent grid: same table as /agents, pre-filtered on this group + its sub-groups. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
          {t('groups.detail.agentList', { count: devices.length })}
        </h2>
        <AgentTable groupId={groupId} recursive embedded />
      </section>

    </PageContainer>
  );
}
