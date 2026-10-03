import { useState, useEffect, useCallback, useMemo, type FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, ChevronUp, ChevronDown, Server, Plus, X, Shield, EyeOff,
  Settings2, SlidersHorizontal, FileCode2, Gauge, Bell,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  MonitorGroup, GroupTreeNode, AgentGroupConfig, AgentTenantUpdatePolicyInfo,
  NotificationTypeConfig, ServiceTemplate, ServiceType, ServiceTemplateMode,
} from '@obliview/shared';
import { groupsApi } from '@/api/groups.api';
import { agentApi } from '@/api/agent.api';
import { serviceTemplatesApi } from '@/api/serviceTemplates.api';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useCan, useIsPlatformAdmin, Can } from '@/hooks/usePermission';
import { useTabParam } from '@/hooks/useTabParam';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { GroupPicker } from '@/components/common/GroupPicker';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { NotificationBindingsPanel } from '@/components/notifications/NotificationBindingsPanel';
import { NotificationTypesPanel } from '@/components/agent/NotificationTypesPanel';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { ServiceTemplatesPanel } from '@/components/agent/ServiceTemplatesPanel';
import { NetworkLimitsPanel } from '@/pages/RateLimitPage';
import {
  ancestorUpdatePolicyChain, findGroupInTree, resolveUpdatePolicyView, updatePolicySourceLabel,
  type ResolvedUpdatePolicyView,
} from '@/utils/agentUpdate';
import { cn } from '@/utils/cn';
import { anonHostname } from '@/utils/anonymize';
import toast from 'react-hot-toast';

function findNodeById(nodes: GroupTreeNode[], id: number): GroupTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

function apiError(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

const EMPTY_AGENT_GROUP_CONFIG: AgentGroupConfig = {
  pushIntervalSeconds: null,
  maxMissedPushes: null,
  notificationTypes: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Group update policy view (global -> tenant -> group chain, C17)
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupUpdatePolicyView {
  /** What the group inherits from above (global -> tenant -> ancestor groups). */
  inherited: ResolvedUpdatePolicyView | null;
  inheritedSourceText: string | null;
  /** What applies to the group's agents (its own value included). */
  effective: ResolvedUpdatePolicyView | null;
  effectiveSourceText: string | null;
}

/**
 * Display-only resolution of a group's agent update policy, mirroring the
 * server cascade: 'off' at any level is absolute, otherwise the nearest
 * explicit value wins, nothing set = manual. The tenant level fetched is the
 * OPERATING tenant's, so another tenant's group (`foreign`) resolves to null.
 * Shared by the detail page (attached policies) and the edit page (selector).
 */
export function useGroupUpdatePolicyView(group: MonitorGroup | null, foreign: boolean): GroupUpdatePolicyView {
  const { t } = useTranslation();
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  const tenantName = useTenantStore(s => s.tenants.find(tn => tn.id === (group?.tenantId ?? s.currentTenantId))?.name ?? null);
  const groupTree = useGroupStore(s => s.tree);
  const [tenantPolicy, setTenantPolicy] = useState<AgentTenantUpdatePolicyInfo | null>(null);

  useEffect(() => {
    if (foreign) { setTenantPolicy(null); return; }
    let cancelled = false;
    agentApi.getTenantUpdatePolicy()
      .then(i => { if (!cancelled) setTenantPolicy(i); })
      .catch(() => { if (!cancelled) setTenantPolicy(null); });
    return () => { cancelled = true; };
  }, [foreign, currentTenantId]);

  return useMemo(() => {
    const none: GroupUpdatePolicyView = { inherited: null, inheritedSourceText: null, effective: null, effectiveSourceText: null };
    if (!group) return none;
    // Never apply the operating tenant's level to another tenant's group.
    if (!tenantPolicy || (group.tenantId != null && group.tenantId !== tenantPolicy.tenantId)) return none;
    const chain = ancestorUpdatePolicyChain(groupTree, group);
    if (chain === null) return none;
    const globalPolicy = tenantPolicy.globalPolicyIsDefault ? null : tenantPolicy.globalPolicy;
    const own = group.agentGroupConfig?.updatePolicy ?? null;
    const inherited = resolveUpdatePolicyView(null, chain, tenantPolicy.updatePolicy, globalPolicy);
    const effective = resolveUpdatePolicyView(
      null, own ? [{ groupId: group.id, policy: own }, ...chain] : chain, tenantPolicy.updatePolicy, globalPolicy,
    );
    const label = (v: ResolvedUpdatePolicyView) => updatePolicySourceLabel(v.source, t, {
      tenantName,
      groupName: v.sourceGroupId != null
        ? (v.sourceGroupId === group.id ? group.name : (findGroupInTree(groupTree, v.sourceGroupId)?.name ?? null))
        : null,
    });
    return { inherited, inheritedSourceText: label(inherited), effective, effectiveSourceText: label(effective) };
  }, [group, tenantPolicy, groupTree, tenantName, t]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent settings tab (IPS settings cascade + update policy)
// ─────────────────────────────────────────────────────────────────────────────

function OverrideBadge({ overriding }: { overriding: boolean }) {
  const { t } = useTranslation();
  return overriding ? (
    <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
      {t('groups.settings.override', { defaultValue: 'Override' })}
    </span>
  ) : (
    <span className="text-xs text-text-muted">{t('groups.settings.default', { defaultValue: 'Default' })}</span>
  );
}

/**
 * Agent settings of a group: the IPS settings cascade at the group level
 * (W13-1: check interval, missed check-ins, automatic bans, evaluate-only,
 * Windows firewall backend, each with its inherited value and source) and
 * the agent update policy (C17 storage and resolver, platform admins only).
 * Notification types live in the Notifications tab.
 */
function AgentGroupSettingsPanel({ group, onUpdate, readOnly = false }: {
  group: MonitorGroup;
  onUpdate: (g: MonitorGroup) => void;
  /** Another tenant's group (Default god view): the server refuses every write. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  // Update policy writes stay platform-admin only (owner directive).
  const canSetPolicy = useIsPlatformAdmin();
  // Cascade writes: groups.manage (route) + RW on the group (server).
  const canManage = useCan('groups.manage');

  const cfg: AgentGroupConfig = group.agentGroupConfig ?? EMPTY_AGENT_GROUP_CONFIG;
  const [savingPolicy, setSavingPolicy] = useState(false);

  const { inherited: inheritedPolicy, inheritedSourceText } = useGroupUpdatePolicyView(group, readOnly);

  async function saveConfig(patch: Partial<AgentGroupConfig>, setSaving: (v: boolean) => void) {
    setSaving(true);
    try {
      // Only the edited keys: the server merges them into the stored config
      // (no stale value of another key written back).
      const updated = await groupsApi.updateAgentGroupConfig(group.id, { agentGroupConfig: patch });
      onUpdate(updated);
    } catch (err) {
      toast.error(apiError(err) ?? t('groups.failedUpdate'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-5 max-sm:p-4">
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-1">
        {t('groups.detail.agentSettings')}
      </h2>
      <p className="text-xs text-text-muted mb-4">{t('groups.detail.agentSettingsDesc')}</p>
      {readOnly && (
        <p className="text-xs text-amber-400 mb-3">
          {t('agentUpdate.readOnlyOtherTenant', 'Read-only: this group belongs to another tenant')}
        </p>
      )}

      {/* ── IPS settings cascade (group level) ── */}
      <SettingsPanel
        level="group"
        scopeId={group.id}
        hide={['notificationTypes', 'updatePolicy']}
        readOnly={readOnly || !canManage}
        className="min-w-0"
        onChange={(v) => {
          const evaluateOnly = v.overrides.evaluateOnly === true;
          if (evaluateOnly !== (group.evaluateOnly ?? false)) onUpdate({ ...group, evaluateOnly });
        }}
      />

      <fieldset disabled={readOnly} className="min-w-0 border-0 p-0 m-0 border-t border-border">
        {/* ── Agent updates (C17-1): Inherit / Automatic / Manual / Off, platform admins only ── */}
        <div className="flex items-center gap-4 py-3 max-sm:flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">{t('agentUpdate.policyLabel', 'Agent updates')}</span>
              <OverrideBadge overriding={!!cfg.updatePolicy} />
            </div>
            <p className="text-xs text-text-muted mt-0.5">
              {t('agentUpdate.groupPolicyDesc', "Update policy of this group's agents and sub-groups. 'Off' freezes them whatever is set below.")}
            </p>
            {inheritedPolicy?.policy === 'off' && inheritedSourceText && (
              <p className="text-[11px] text-amber-400 mt-0.5">
                {t('agentUpdate.frozenBy', { defaultValue: 'Frozen by {{source}}', source: inheritedSourceText })}
              </p>
            )}
            {!canSetPolicy && !readOnly && (
              <p className="text-[11px] text-text-muted mt-0.5">
                {t('groups.settings.policyPlatformOnly', { defaultValue: 'Only platform administrators can change the update policy.' })}
              </p>
            )}
          </div>
          <select
            value={cfg.updatePolicy ?? 'inherit'}
            onChange={e => {
              const v = e.target.value;
              void saveConfig({ updatePolicy: v === 'inherit' ? null : v as 'auto' | 'manual' | 'off' }, setSavingPolicy);
            }}
            disabled={savingPolicy || !canSetPolicy}
            aria-label={t('agentUpdate.policyLabel', 'Agent updates')}
            className="shrink-0 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 max-sm:w-full"
          >
            <option value="inherit">
              {inheritedPolicy && inheritedSourceText
                ? `${t('agentUpdate.policy.inherit', 'Inherit')} (${t(`agentUpdate.policy.${inheritedPolicy.policy}`, inheritedPolicy.policy)} — ${inheritedSourceText})`
                : t('agentUpdate.policy.inherit', 'Inherit')}
            </option>
            <option value="auto">{t('agentUpdate.policy.auto', 'Automatic')}</option>
            <option value="manual">{t('agentUpdate.policy.manual', 'Manual')}</option>
            <option value="off">{t('agentUpdate.policy.off', 'Off (frozen)')}</option>
          </select>
        </div>
      </fieldset>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Group templates (templates owned by this group, auto-applied to its agents)
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN_TYPES: ServiceType[] = ['ssh', 'rdp', 'nginx', 'apache', 'iis', 'ftp', 'mail', 'mysql'];

interface CreateGroupTemplateForm {
  name: string;
  serviceType: ServiceType;
  mode: ServiceTemplateMode;
  defaultLogPath: string;
  threshold: number;
  windowSeconds: number;
}

const FORM_DEFAULTS: CreateGroupTemplateForm = {
  name: '',
  serviceType: 'custom',
  mode: 'ban',
  defaultLogPath: '',
  threshold: 5,
  windowSeconds: 300,
};

const FIELD_CLASS = 'w-full rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

function GroupTemplatesPanel({ groupId, readOnly }: { groupId: number; readOnly: boolean }) {
  const { t } = useTranslation();
  const confirmAction = useConfirm();
  const [templates, setTemplates] = useState<ServiceTemplate[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState<CreateGroupTemplateForm>(FORM_DEFAULTS);
  const [saving, setSaving]       = useState(false);
  const [deleting, setDeleting]   = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await serviceTemplatesApi.listLocal('group', groupId));
    } catch (err) {
      toast.error(apiError(err) ?? t('groups.templates.loadFailed', { defaultValue: 'Failed to load the group templates' }));
    } finally {
      setLoading(false);
    }
  }, [groupId, t]);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await serviceTemplatesApi.create({
        name: form.name.trim(),
        serviceType: form.serviceType,
        mode: form.mode,
        defaultLogPath: form.defaultLogPath.trim() || null,
        threshold: form.threshold,
        windowSeconds: form.windowSeconds,
        ownerScope: 'group',
        ownerScopeId: groupId,
      });
      setForm(FORM_DEFAULTS);
      setShowForm(false);
      await load();
      toast.success(t('groups.templates.created', { defaultValue: 'Group template created' }));
    } catch (err) {
      toast.error(apiError(err) ?? t('groups.templates.createFailed', { defaultValue: 'Failed to create the group template' }));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(tpl: ServiceTemplate) {
    const ok = await confirmAction({
      message: t('groups.templates.confirmDelete', {
        defaultValue: 'Delete the group template "{{name}}"? This cannot be undone.',
        name: tpl.name,
      }),
      danger: true,
    });
    if (!ok) return;
    setDeleting(d => ({ ...d, [tpl.id]: true }));
    try {
      await serviceTemplatesApi.delete(tpl.id);
      await load();
      toast.success(t('groups.templates.deleted', { defaultValue: 'Group template deleted' }));
    } catch (err) {
      toast.error(apiError(err) ?? t('groups.templates.deleteFailed', { defaultValue: 'Failed to delete the group template' }));
    } finally {
      setDeleting(d => ({ ...d, [tpl.id]: false }));
    }
  }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary">

      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            {t('groups.templates.title', { defaultValue: 'Group templates' })}
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            {t('groups.templates.desc', { defaultValue: 'Templates owned by this group, visible to every agent of the group.' })}
          </p>
        </div>
        {!readOnly && (
          <Button size="sm" variant="secondary" onClick={() => setShowForm(v => !v)}>
            <Plus size={12} className="mr-1" />
            {t('groups.templates.new', { defaultValue: 'New template' })}
          </Button>
        )}
      </div>

      {/* Create form */}
      {showForm && !readOnly && (
        <form onSubmit={e => void handleCreate(e)} className="border-b border-border px-4 py-4 bg-bg-tertiary/40">
          <div className="grid gap-3 sm:grid-cols-2">

            <div className="sm:col-span-2">
              <label htmlFor="gt-name" className="block text-xs font-medium text-text-muted mb-1">
                {t('groups.templates.name', { defaultValue: 'Template name' })}
              </label>
              <input
                id="gt-name"
                required
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={t('groups.templates.namePlaceholder', { defaultValue: 'e.g. Custom App Auth' })}
                className={FIELD_CLASS}
              />
            </div>

            <div>
              <label htmlFor="gt-type" className="block text-xs font-medium text-text-muted mb-1">
                {t('groups.templates.serviceType', { defaultValue: 'Service type' })}
              </label>
              <select
                id="gt-type"
                value={form.serviceType}
                onChange={e => setForm(f => ({ ...f, serviceType: e.target.value as ServiceType }))}
                className={FIELD_CLASS}
              >
                {BUILTIN_TYPES.map(st => (
                  <option key={st} value={st}>{st}</option>
                ))}
                <option value="custom">{t('groups.templates.typeCustom', { defaultValue: 'custom' })}</option>
              </select>
            </div>

            <div>
              <label htmlFor="gt-mode" className="block text-xs font-medium text-text-muted mb-1">
                {t('groups.templates.mode', { defaultValue: 'Mode' })}
              </label>
              <select
                id="gt-mode"
                value={form.mode}
                onChange={e => setForm(f => ({ ...f, mode: e.target.value as ServiceTemplateMode }))}
                className={FIELD_CLASS}
              >
                <option value="ban">{t('groups.templates.modeBan', { defaultValue: 'Ban' })}</option>
                <option value="track">{t('groups.templates.modeTrack', { defaultValue: 'Track only' })}</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="gt-log" className="block text-xs font-medium text-text-muted mb-1">
                {t('groups.templates.logPath', { defaultValue: 'Default log path (optional)' })}
              </label>
              <input
                id="gt-log"
                value={form.defaultLogPath}
                onChange={e => setForm(f => ({ ...f, defaultLogPath: e.target.value }))}
                placeholder="/var/log/myapp/auth.log"
                className={cn(FIELD_CLASS, 'font-mono')}
              />
            </div>

            <div>
              <label htmlFor="gt-threshold" className="block text-xs font-medium text-text-muted mb-1">
                {t('groups.templates.threshold', { defaultValue: 'Threshold (events)' })}
              </label>
              <input
                id="gt-threshold"
                type="number"
                min={1}
                value={form.threshold}
                onChange={e => setForm(f => ({ ...f, threshold: Number(e.target.value) }))}
                className={FIELD_CLASS}
              />
            </div>

            <div>
              <label htmlFor="gt-window" className="block text-xs font-medium text-text-muted mb-1">
                {t('groups.templates.window', { defaultValue: 'Window (seconds)' })}
              </label>
              <input
                id="gt-window"
                type="number"
                min={1}
                value={form.windowSeconds}
                onChange={e => setForm(f => ({ ...f, windowSeconds: Number(e.target.value) }))}
                className={FIELD_CLASS}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 mt-4">
            <Button type="submit" size="sm" loading={saving} disabled={!form.name.trim()}>
              {t('common.create', { defaultValue: 'Create' })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => { setShowForm(false); setForm(FORM_DEFAULTS); }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-6"><LoadingSpinner size="sm" /></div>
      ) : templates.length === 0 && !showForm ? (
        <div className="py-6 px-4 text-center text-sm text-text-muted">
          {t('groups.templates.empty', { defaultValue: 'No group-level templates yet.' })}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {templates.map(tpl => (
            <div key={tpl.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-text-primary">{tpl.name}</span>
                  <span className="inline-flex items-center rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono text-text-muted border border-border">
                    {tpl.serviceType}
                  </span>
                  <span className={cn(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold',
                    tpl.mode === 'ban' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400',
                  )}>
                    {tpl.mode === 'ban' ? <Shield size={8} /> : <EyeOff size={8} />}
                    {tpl.mode === 'ban'
                      ? t('groups.templates.modeBan', { defaultValue: 'Ban' })
                      : t('groups.templates.modeTrackShort', { defaultValue: 'Track' })}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-text-muted min-w-0 truncate">
                  {t('groups.templates.thresholdSummary', {
                    defaultValue: 'Threshold: {{threshold}} / {{window}}s',
                    threshold: tpl.threshold,
                    window: tpl.windowSeconds,
                  })}
                  {tpl.defaultLogPath && (
                    <span className="ml-3 font-mono" title={tpl.defaultLogPath}>
                      {tpl.defaultLogPath}
                    </span>
                  )}
                </div>
              </div>
              {!readOnly && (
                <IconButton
                  label={t('groups.templates.delete', { defaultValue: 'Delete this group template' })}
                  icon={<X size={14} />}
                  onClick={() => void handleDelete(tpl)}
                  disabled={deleting[tpl.id]}
                  variant="danger"
                  size="sm"
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GroupEditPage
// ─────────────────────────────────────────────────────────────────────────────

interface GroupFormData {
  name: string;
  description: string;
  isGeneral: boolean;
}

export const GROUP_EDIT_TABS = ['general', 'agent', 'templates', 'limits', 'notifications'] as const;
export type GroupEditTab = typeof GROUP_EDIT_TABS[number];

export function GroupEditPage() {
  const { id } = useParams<{ id: string }>();
  // Keyed on the id: moving to another group's edit page starts from a clean state.
  return <GroupEditView key={id} id={id!} />;
}

function GroupEditView({ id }: { id: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { canWriteGroup } = useAuthStore();
  const { getGroup, fetchGroups, fetchTree, tree } = useGroupStore();
  const canTemplates = useCan('templates.write');
  const [tab, setTab] = useTabParam<GroupEditTab>(GROUP_EDIT_TABS, 'general');

  const groupId = parseInt(id, 10);

  const storeGroup = getGroup(groupId) ?? null;
  const [group, setGroup] = useState<MonitorGroup | null>(storeGroup);
  const [loading, setLoading] = useState(!storeGroup);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<GroupFormData>({
    name: storeGroup?.name ?? '',
    description: storeGroup?.description ?? '',
    isGeneral: storeGroup?.isGeneral ?? false,
  });
  const [formTouched, setFormTouched] = useState(false);

  // Position state
  // undefined = no pending change; null/number = new parent selected but not yet applied
  const [pendingParentId, setPendingParentId] = useState<number | null | undefined>(undefined);
  const [movingSaving, setMovingSaving] = useState(false);
  const [siblingsOrder, setSiblingsOrder] = useState<GroupTreeNode[]>([]);
  const [reorderDirty, setReorderDirty] = useState(false);
  const [reorderSaving, setReorderSaving] = useState(false);

  // Writes on another tenant's group (Default god view) are refused server-side.
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  const isOwnTenantGroup = group?.tenantId === undefined || group.tenantId === currentTenantId;

  const getSiblings = useCallback((): GroupTreeNode[] => {
    if (!group) return [];
    const parentId = group.parentId;
    if (parentId === null) return tree;
    const parentNode = findNodeById(tree, parentId);
    return parentNode?.children ?? [];
  }, [group, tree]);

  // Sync sibling list when group or tree changes
  useEffect(() => {
    setSiblingsOrder(getSiblings());
    setReorderDirty(false);
  }, [getSiblings]);

  // Always fetch the full group (the store copy may lack agentGroupConfig or be stale).
  useEffect(() => {
    let cancelled = false;
    groupsApi.getById(groupId)
      .then((g) => {
        if (cancelled) return;
        setGroup(g);
        setForm(prev => formTouched ? prev : {
          name: g.name,
          description: g.description ?? '',
          isGeneral: g.isGeneral,
        });
      })
      .catch((err) => { if (!cancelled) toast.error(apiError(err) ?? t('groups.failedLoad', 'Failed to load the group')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // formTouched is read once per load on purpose (a later edit never re-runs the fetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, t]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!group || !canWriteGroup(groupId)) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-text-muted">{t('groups.notFoundOrDenied', { defaultValue: 'Group not found or access denied' })}</p>
        <Link to="/" className="mt-4">
          <Button variant="secondary">{t('groups.backToDashboard', { defaultValue: 'Back to dashboard' })}</Button>
        </Link>
      </div>
    );
  }

  const updateForm = (patch: Partial<GroupFormData>) => {
    setFormTouched(true);
    setForm(f => ({ ...f, ...patch }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await groupsApi.update(groupId, {
        name: form.name,
        description: form.description || null,
        isGeneral: form.isGeneral,
      });
      toast.success(t('groups.updated'));
      fetchGroups();
      fetchTree();
      navigate(`/group/${groupId}`);
    } catch (err) {
      toast.error(apiError(err) ?? t('groups.failedUpdate'));
    } finally {
      setSaving(false);
    }
  };

  const handleMove = async () => {
    if (pendingParentId === undefined) return;
    setMovingSaving(true);
    try {
      await groupsApi.move(groupId, pendingParentId);
      toast.success(t('groups.moved'));
      setGroup((g) => g ? { ...g, parentId: pendingParentId } : g);
      setPendingParentId(undefined);
      await fetchGroups();
      await fetchTree();
    } catch (err) {
      toast.error(apiError(err) ?? t('groups.failedMove'));
    } finally {
      setMovingSaving(false);
    }
  };

  const moveSibling = (index: number, direction: -1 | 1) => {
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= siblingsOrder.length) return;
    const newOrder = [...siblingsOrder];
    [newOrder[index], newOrder[swapIndex]] = [newOrder[swapIndex], newOrder[index]];
    setSiblingsOrder(newOrder);
    setReorderDirty(true);
  };

  const handleReorder = async () => {
    setReorderSaving(true);
    try {
      await groupsApi.reorder(siblingsOrder.map((n, idx) => ({ id: n.id, sortOrder: idx })));
      toast.success(t('groups.orderSaved'));
      await fetchTree();
      setReorderDirty(false);
    } catch (err) {
      toast.error(apiError(err) ?? t('groups.failedOrder'));
    } finally {
      setReorderSaving(false);
    }
  };

  const effectiveParentId = pendingParentId !== undefined ? pendingParentId : group.parentId;
  const readOnly = !isOwnTenantGroup;

  const tabs = [
    { id: 'general' as const, label: t('groups.tabs.general', { defaultValue: 'General' }), icon: <Settings2 size={14} /> },
    { id: 'agent' as const, label: t('groups.tabs.agentSettings', { defaultValue: 'Agent settings' }), icon: <SlidersHorizontal size={14} /> },
    { id: 'templates' as const, label: t('groups.tabs.serviceTemplates', { defaultValue: 'Service templates' }), icon: <FileCode2 size={14} /> },
    { id: 'limits' as const, label: t('groups.tabs.networkLimits', { defaultValue: 'Network limits' }), icon: <Gauge size={14} /> },
    { id: 'notifications' as const, label: t('groups.tabs.notifications', { defaultValue: 'Notifications' }), icon: <Bell size={14} /> },
  ];

  return (
    <PageContainer className="space-y-6">
      <Link
        to={`/group/${groupId}`}
        className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary max-w-full coarse:min-h-10"
      >
        <ArrowLeft size={14} className="shrink-0" />
        <span className="truncate">{t('groups.backToGroup', { name: anonHostname(group.name) })}</span>
      </Link>

      <PageHeader
        title={t('groups.edit')}
        description={anonHostname(group.name)}
        badge={(
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary border border-border px-2.5 py-0.5 text-xs font-medium text-text-muted">
              <Server size={11} />
              {t('groups.agentGroup')}
            </span>
            <TenantBadge tenantId={group.tenantId} size="md" />
          </span>
        )}
      />

      <SegmentedTabs
        tabs={tabs}
        value={tab}
        onChange={setTab}
        fill={false}
        ariaLabel={t('groups.tabs.label', { defaultValue: 'Group settings sections' })}
      />

      {/* ── General: name, description, position ── */}
      {tab === 'general' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-border bg-bg-secondary p-5 max-sm:p-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">
              {t('groups.tabs.general', { defaultValue: 'General' })}
            </h2>
            {readOnly && (
              <p className="text-xs text-amber-400 mb-3">
                {t('agentUpdate.readOnlyOtherTenant', 'Read-only: this group belongs to another tenant')}
              </p>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <fieldset disabled={readOnly} className="min-w-0 space-y-4 border-0 p-0 m-0">
              <Input
                label={t('groups.form.name')}
                value={form.name}
                onChange={(e) => updateForm({ name: e.target.value })}
                placeholder={t('groups.form.namePlaceholder')}
                required
              />
              <Input
                label={t('groups.form.description')}
                value={form.description}
                onChange={(e) => updateForm({ description: e.target.value })}
                placeholder={t('groups.form.descriptionPlaceholder')}
              />
              <div className="flex items-center gap-2">
                <div className="relative h-4 w-4 shrink-0">
                  <input
                    type="checkbox"
                    id="is-general"
                    checked={form.isGeneral}
                    onChange={(e) => updateForm({ isGeneral: e.target.checked })}
                    className="peer appearance-none h-4 w-4 rounded border cursor-pointer transition-colors bg-bg-tertiary border-border checked:bg-accent checked:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <svg className="pointer-events-none absolute top-0 left-0 hidden h-4 w-4 text-white peer-checked:block" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 8L6 11.5L13.5 4.5" />
                  </svg>
                </div>
                <label htmlFor="is-general" className="text-sm text-text-secondary">
                  {t('groups.form.isGeneral')}
                </label>
              </div>
              </fieldset>
              <div className="flex items-center gap-3 pt-2 flex-wrap">
                <Button type="submit" loading={saving} disabled={readOnly}>{t('groups.save')}</Button>
                <Button type="button" variant="secondary" onClick={() => navigate(`/group/${groupId}`)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </div>

          {/* Position: parent + order among siblings (operating tenant's groups only) */}
          {isOwnTenantGroup && (
            <div className="rounded-lg border border-border bg-bg-secondary p-5 max-sm:p-4">
              <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">
                {t('groups.position', { defaultValue: 'Position' })}
              </h2>

              {/* Parent group */}
              <div className="mb-5">
                <label className="block text-sm font-medium text-text-secondary mb-1">{t('groups.form.parent')}</label>
                <GroupPicker
                  value={effectiveParentId}
                  onChange={(pid) => setPendingParentId(pid === group.parentId ? undefined : pid)}
                  tree={tree}
                  placeholder={t('groups.form.parentNone')}
                  excludeId={groupId}
                  kindFilter={group.kind}
                />
                {pendingParentId !== undefined && (
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <Button size="sm" onClick={handleMove} loading={movingSaving}>
                      {t('groups.applyMove')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setPendingParentId(undefined)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                )}
              </div>

              {/* Sibling order */}
              {siblingsOrder.length > 1 && (
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">
                    {t('groups.form.sortOrder')}
                  </label>
                  <div className="rounded-md border border-border overflow-hidden divide-y divide-border">
                    {siblingsOrder.map((sibling, idx) => (
                      <div
                        key={sibling.id}
                        className={cn(
                          'flex items-center gap-2 px-3 py-2 text-sm',
                          sibling.id === groupId
                            ? 'bg-accent/5 text-text-primary font-medium'
                            : 'text-text-secondary',
                        )}
                      >
                        <span className="w-5 shrink-0 text-right text-xs text-text-muted">{idx + 1}</span>
                        <span className="flex-1 truncate">{anonHostname(sibling.name)}</span>
                        {sibling.id === groupId && (
                          <div className="flex items-center gap-0.5 coarse:gap-1">
                            <IconButton
                              label={t('groups.form.moveUp')}
                              icon={<ChevronUp size={14} />}
                              onClick={() => moveSibling(idx, -1)}
                              disabled={idx === 0}
                              variant="plain"
                              size="xs"
                            />
                            <IconButton
                              label={t('groups.form.moveDown')}
                              icon={<ChevronDown size={14} />}
                              onClick={() => moveSibling(idx, 1)}
                              disabled={idx === siblingsOrder.length - 1}
                              variant="plain"
                              size="xs"
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {reorderDirty && (
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <Button size="sm" onClick={handleReorder} loading={reorderSaving}>
                        {t('groups.saveOrder')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => { setSiblingsOrder(getSiblings()); setReorderDirty(false); }}
                      >
                        {t('common.reset')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Agent settings: IPS settings cascade (group level) + update policy ── */}
      {tab === 'agent' && (
        <AgentGroupSettingsPanel key={group.id} group={group} onUpdate={setGroup} readOnly={readOnly} />
      )}

      {/* ── Service templates: global templates bound here + templates owned by the group ── */}
      {tab === 'templates' && (
        <div className="space-y-6">
          <ServiceTemplatesPanel scope="group" scopeId={groupId} readOnly={readOnly || !canTemplates} />
          <GroupTemplatesPanel groupId={groupId} readOnly={readOnly || !canTemplates} />
        </div>
      )}

      {/* ── Network limits scoped to this group ── */}
      {tab === 'limits' && (
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <NetworkLimitsPanel
            scope="group"
            scopeId={groupId}
            label={anonHostname(group.name)}
            title={t('groups.tabs.networkLimits', { defaultValue: 'Network limits' })}
            readOnly={readOnly}
          />
        </div>
      )}

      {/* ── Notifications: channel bindings + notification types ── */}
      {tab === 'notifications' && (
        <div className="space-y-6">
          <Can
            cap="notifications.manage"
            fallback={(
              <p className="rounded-lg border border-border bg-bg-secondary px-4 py-3 text-sm text-text-muted">
                {t('groups.notifications.noAccess', { defaultValue: 'Channel bindings need the "Manage notification channels" permission.' })}
              </p>
            )}
          >
            <fieldset disabled={readOnly} className="min-w-0 border-0 p-0 m-0">
              <NotificationBindingsPanel
                scope="group"
                scopeId={groupId}
                title={t('groups.notificationsFor', { name: anonHostname(group.name) })}
              />
            </fieldset>
          </Can>
          <fieldset disabled={readOnly} className="min-w-0 border-0 p-0 m-0">
            <NotificationTypesPanel
              config={group.agentGroupConfig?.notificationTypes ?? null}
              scope="group"
              onSave={async (notifTypes: NotificationTypeConfig | null) => {
                try {
                  // Only the edited key: the server merges, and re-sending the
                  // stored updatePolicy would be refused for non platform admins.
                  const updated = await groupsApi.updateAgentGroupConfig(group.id, {
                    agentGroupConfig: { notificationTypes: notifTypes },
                  });
                  setGroup(updated);
                } catch (err) {
                  toast.error(apiError(err) ?? t('groups.failedUpdate'));
                  // Rethrown so the panel keeps its previous draft.
                  throw err;
                }
              }}
            />
          </fieldset>
        </div>
      )}
    </PageContainer>
  );
}
