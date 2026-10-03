import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { Plus, Gauge, Trash2, RefreshCw, X, Activity, Network, Pencil, ShieldOff, ShieldCheck, Search, Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  RateLimitPolicy,
  RateLimitScope,
  RateLimitType,
  RateLimitAction,
  CreateRateLimitPolicyRequest,
  GroupTreeNode,
  AgentDevice,
} from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { TableScroll } from '@/components/common/TableScroll';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { TenantBadge } from '@/components/common/TenantBadge';
import { TargetTreePicker } from '@/components/common/TargetTreePicker';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ScopeBadge } from '@/components/status/ScopeBadge';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useCan, useIsPlatformAdmin } from '@/hooks/usePermission';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { cn } from '@/utils/cn';
import { rateLimitPoliciesApi } from '@/api/rateLimitPolicies.api';
import type { RateLimitEnforcement } from '@/api/rateLimitPolicies.api';
import { groupsApi } from '@/api/groups.api';
import { agentApi } from '@/api/agent.api';
import { useTenantStore } from '@/store/tenantStore';
import toast from 'react-hot-toast';

// ── Shared types ─────────────────────────────────────────────────────────────

/** A policy's config minus its target (scope/scopeId), supplied separately. */
type PolicyConfig = Omit<CreateRateLimitPolicyRequest, 'scope' | 'scopeId'>;
/** A single target a policy can be applied to. */
type Target =
  | { scope: 'global' | 'tenant' }
  | { scope: 'group' | 'agent'; scopeId: number };

/** Heartbeat capability of agents whose firewall backend enforces rate limits. */
const CAP_RATE_LIMIT = 'ratelimit';

/** Display order of the scopes (filter chips, grouping). */
const SCOPE_ORDER: Record<RateLimitScope, number> = { global: 0, tenant: 1, group: 2, agent: 3 };

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const TYPE_CLASSES: Record<RateLimitType, string> = {
  connection: 'bg-purple-500/10 text-purple-400',
  rate:       'bg-cyan-500/10 text-cyan-400',
  volume:     'bg-emerald-500/10 text-emerald-400',
};

function typeLabel(t: TFunction, type: RateLimitType): string {
  if (type === 'connection') return t('networkLimiting.types.connection', { defaultValue: 'Connection limit' });
  if (type === 'rate') return t('networkLimiting.types.rate', { defaultValue: 'Rate limit' });
  return t('networkLimiting.types.volume', { defaultValue: 'Bandwidth limit' });
}

function TypeBadge({ type }: { type: RateLimitType }) {
  const { t } = useTranslation();
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium', TYPE_CLASSES[type])}>
      {typeLabel(t, type)}
    </span>
  );
}

function unitFor(t: TFunction, type: RateLimitType): string {
  if (type === 'connection') return t('networkLimiting.units.connection', { defaultValue: 'concurrent conns' });
  if (type === 'rate') return t('networkLimiting.units.rate', { defaultValue: 'conns/sec' });
  return t('networkLimiting.units.volume', { defaultValue: 'mbit/s' });
}

function describeLimit(t: TFunction, p: RateLimitPolicy): string {
  const where = p.port != null
    ? t('networkLimiting.port', { port: p.port, defaultValue: 'port {{port}}' })
    : t('networkLimiting.allPorts', { defaultValue: 'all inbound TCP' });
  return `${p.maxValue} ${unitFor(t, p.type)} · ${where}`;
}

function actionLabel(t: TFunction, action: RateLimitAction): string {
  if (action === 'reject') return t('networkLimiting.actions.reject', { defaultValue: 'Reject' });
  if (action === 'shape') return t('networkLimiting.actions.shape', { defaultValue: 'Shape' });
  return t('networkLimiting.actions.drop', { defaultValue: 'Drop' });
}

function escalationLabel(t: TFunction, p: RateLimitPolicy): string | null {
  if (p.banMultiplier == null) return null;
  return p.banTtlSeconds != null
    ? t('networkLimiting.escalation.withTtl', { mult: p.banMultiplier, ttl: p.banTtlSeconds, defaultValue: 'Ban at ×{{mult}} ({{ttl}} s)' })
    : t('networkLimiting.escalation.permanent', { mult: p.banMultiplier, defaultValue: 'Ban at ×{{mult}} (permanent)' });
}

function scopeName(t: TFunction, scope: RateLimitScope): string {
  return t(`status.scope.${scope}`, { defaultValue: scope.charAt(0).toUpperCase() + scope.slice(1) });
}

/**
 * Whether an agent enforces network limits, from the capabilities of its last
 * heartbeat: null when unknown (an agent that never reported capabilities).
 */
function rateLimitSupport(device: AgentDevice | null | undefined): boolean | null {
  const caps = device?.capabilities;
  if (!caps || caps.length === 0) return null;
  return caps.includes(CAP_RATE_LIMIT);
}

function unsupportedHint(t: TFunction): string {
  return t('networkLimiting.unsupportedHint', {
    defaultValue: 'This agent does not enforce network limits: its firewall (Windows, pf, firewalld) has no per-IP rate limiting, or the agent predates rate-limit delivery.',
  });
}

function UnsupportedBadge() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium bg-status-down/10 text-status-down"
      title={unsupportedHint(t)}
    >
      <ShieldOff size={10} />{t('networkLimiting.unsupported', { defaultValue: 'Unsupported on this agent' })}
    </span>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
  return data?.message || data?.error || fallback;
}

// ── Enforcement switch ─────────────────────────────────────────────────────────

/** Loads the global enforcement switch (null while unknown). */
function useEnforcement(): [RateLimitEnforcement | null, (v: RateLimitEnforcement) => void, () => void] {
  const [enforcement, setEnforcement] = useState<RateLimitEnforcement | null>(null);
  const reload = useCallback(() => {
    rateLimitPoliciesApi.getEnforcement().then(setEnforcement).catch(() => setEnforcement(null));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return [enforcement, setEnforcement, reload];
}

function EnforcementOffNote() {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 mb-3 text-xs text-yellow-400">
      <ShieldOff size={13} className="shrink-0 mt-0.5" />
      <span>
        {t('networkLimiting.enforcementOffNote', {
          defaultValue: 'Enforcement is off: network limits are not delivered to agents until a platform admin enables it under Policies > Network limits.',
        })}
      </span>
    </div>
  );
}

// ── PolicyModal (add or edit) ─────────────────────────────────────────────────

interface PolicyModalProps {
  onSave: (config: PolicyConfig, targets: Target[]) => Promise<void>;
  onClose: () => void;
  /** When set, the target is fixed (embedded in a group/agent view) and the picker is hidden. */
  lockedTarget?: Target;
  lockedLabel?: string;
  /** Edit mode: the form starts from this policy, whose target stays fixed. */
  initial?: RateLimitPolicy;
}

function PolicyModal({ onSave, onClose, lockedTarget, lockedLabel, initial }: PolicyModalProps) {
  const { t } = useTranslation();
  const editing = !!initial;
  // Global policies are created from the Default tenant only (server rule).
  const isMaster = useIsMasterTenant();
  const [type, setType] = useState<RateLimitType>(initial?.type ?? 'connection');
  const [port, setPort] = useState(initial?.port != null ? String(initial.port) : '');
  const [maxValue, setMaxValue] = useState(initial ? String(initial.maxValue) : '');
  const [action, setAction] = useState<RateLimitAction>(initial?.action ?? 'drop');
  const [escalate, setEscalate] = useState(initial?.banMultiplier != null);
  const [banMultiplier, setBanMultiplier] = useState(initial?.banMultiplier != null ? String(initial.banMultiplier) : '20');
  const [banTtl, setBanTtl] = useState(initial?.banTtlSeconds != null ? String(initial.banTtlSeconds) : '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  // Target selection (only when not locked)
  const [scopeMode, setScopeMode] = useState<'global' | 'tenant' | 'specific'>(isMaster ? 'global' : 'tenant');
  const [groupTree, setGroupTree] = useState<GroupTreeNode[]>([]);
  const [devices, setDevices] = useState<AgentDevice[]>([]);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const [selGroups, setSelGroups] = useState<Set<number>>(new Set());
  const [selAgents, setSelAgents] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (lockedTarget || scopeMode !== 'specific' || targetsLoaded) return;
    setTargetsLoaded(true);
    void Promise.allSettled([
      groupsApi.tree().then(setGroupTree),
      agentApi.listDevices('approved').then(setDevices),
    ]).then((results) => {
      if (results.some((r) => r.status === 'rejected')) {
        toast.error(t('networkLimiting.targetsLoadFailed', { defaultValue: 'Failed to load groups and agents' }));
      }
    });
  }, [lockedTarget, scopeMode, targetsLoaded, t]);

  const isVolume = type === 'volume';

  // Keep the action valid for the selected type:
  //   volume → 'drop' | 'shape' ; connection/rate → 'drop' | 'reject'
  useEffect(() => {
    if (isVolume && action === 'reject') setAction('drop');
    if (!isVolume && action === 'shape') setAction('drop');
  }, [isVolume, action]);

  /** '' → null; otherwise an integer within [min, max], or undefined when invalid. */
  const intField = (raw: string, min: number, max: number): number | null | undefined => {
    if (!raw.trim()) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  };

  const handleSubmit = async () => {
    const max = intField(maxValue, 1, 1_000_000);
    if (max == null) {
      toast.error(t('networkLimiting.form.invalidMax', { defaultValue: 'Enter a valid limit (positive integer)' }));
      return;
    }
    const portValue = intField(port, 1, 65535);
    if (portValue === undefined) {
      toast.error(t('networkLimiting.form.invalidPort', { defaultValue: 'Port must be between 1 and 65535' }));
      return;
    }
    const multValue = escalate ? intField(banMultiplier, 2, 1000) : null;
    if (escalate && multValue == null) {
      toast.error(t('networkLimiting.form.invalidMultiplier', { defaultValue: 'Ban multiplier must be an integer between 2 and 1000' }));
      return;
    }
    const ttlValue = escalate ? intField(banTtl, 1, 10 * 365 * 24 * 3600) : null;
    if (ttlValue === undefined) {
      toast.error(t('networkLimiting.form.invalidTtl', { defaultValue: 'Ban TTL must be a positive number of seconds' }));
      return;
    }

    let targets: Target[];
    if (lockedTarget) {
      targets = [lockedTarget];
    } else if (scopeMode === 'global') {
      targets = [{ scope: 'global' }];
    } else if (scopeMode === 'tenant') {
      targets = [{ scope: 'tenant' }];
    } else {
      targets = [
        ...[...selGroups].map(id => ({ scope: 'group' as const, scopeId: id })),
        ...[...selAgents].map(id => ({ scope: 'agent' as const, scopeId: id })),
      ];
      if (targets.length === 0) {
        toast.error(t('networkLimiting.form.noTarget', { defaultValue: 'Select at least one group or agent' }));
        return;
      }
    }

    const config: PolicyConfig = {
      type,
      port: portValue,
      maxValue: max,
      action,
      enabled,
      banMultiplier: multValue ?? null,
      banTtlSeconds: ttlValue ?? null,
    };

    setSaving(true);
    try {
      await onSave(config, targets);
    } catch {
      // The caller reported the error; keep the form open.
    } finally {
      setSaving(false);
    }
  };

  const scopeModes = (['global', 'tenant', 'specific'] as const).filter((m) => m !== 'global' || isMaster);

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      closeOnBackdrop={false}
      icon={<Gauge size={16} />}
      title={editing
        ? t('networkLimiting.form.editTitle', { defaultValue: 'Edit network limit' })
        : t('networkLimiting.form.addTitle', { defaultValue: 'Add network limit' })}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button loading={saving} onClick={() => void handleSubmit()}>
            <Gauge size={14} className="mr-1.5" />
            {editing
              ? t('common.save', { defaultValue: 'Save' })
              : t('networkLimiting.form.submitAdd', { defaultValue: 'Add limit' })}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {/* Type */}
        <div className="space-y-1">
          <span className="block text-sm font-medium text-text-secondary">{t('networkLimiting.form.type', { defaultValue: 'Limit type' })}</span>
          <div role="radiogroup" className="grid grid-cols-3 gap-2">
            {(['connection', 'rate', 'volume'] as RateLimitType[]).map(ty => (
              <button
                key={ty}
                type="button"
                role="radio"
                aria-checked={type === ty}
                onClick={() => setType(ty)}
                className={cn('px-2 py-2 text-xs font-medium rounded-md border transition-colors',
                  type === ty ? TYPE_CLASSES[ty] + ' border-current' : 'bg-bg-tertiary text-text-muted border-border hover:text-text-primary')}
              >
                {typeLabel(t, ty)}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted">
            {type === 'connection' && t('networkLimiting.form.typeConnectionHint', { defaultValue: 'Caps concurrent connections per source IP.' })}
            {type === 'rate' && t('networkLimiting.form.typeRateHint', { defaultValue: 'Caps new connections per second per source IP.' })}
            {type === 'volume' && t('networkLimiting.form.typeVolumeHint', { defaultValue: 'Caps bandwidth (mbit/s) per source IP. Enforced by nftables agents only.' })}
          </p>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <Input
              label={t('networkLimiting.form.max', { unit: unitFor(t, type), defaultValue: 'Max {{unit}} / IP' })}
              placeholder={isVolume ? '100' : type === 'connection' ? '50' : '10'}
              type="number"
              min={1}
              value={maxValue}
              onChange={e => setMaxValue(e.target.value)}
              autoFocus
            />
          </div>
          <div className="w-28">
            <Input
              label={t('networkLimiting.form.port', { defaultValue: 'Port (opt.)' })}
              placeholder={t('networkLimiting.form.portAll', { defaultValue: 'all' })}
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={e => setPort(e.target.value)}
            />
          </div>
        </div>

        {/* Action over limit */}
        <div className="space-y-1">
          <label htmlFor="rl-action" className="block text-sm font-medium text-text-secondary">
            {t('networkLimiting.form.onExceed', { defaultValue: 'On exceed' })}
          </label>
          <select
            id="rl-action"
            value={action}
            onChange={e => setAction(e.target.value as RateLimitAction)}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {isVolume ? (
              <>
                <option value="drop">{t('networkLimiting.form.actionDropVolume', { defaultValue: 'Drop over limit' })}</option>
                <option value="shape">{t('networkLimiting.form.actionShape', { defaultValue: 'Traffic shaping' })}</option>
              </>
            ) : (
              <>
                <option value="drop">{t('networkLimiting.form.actionDrop', { defaultValue: 'Drop (silent)' })}</option>
                <option value="reject">{t('networkLimiting.form.actionReject', { defaultValue: 'Reject (send RST)' })}</option>
              </>
            )}
          </select>
          {isVolume && action === 'shape' && (
            <p className="text-xs text-text-muted">
              {t('networkLimiting.form.shapeHint', { defaultValue: 'True throttling needs a traffic shaper: not enforced by the current agents.' })}
            </p>
          )}
          {isVolume && action === 'drop' && (
            <p className="text-xs text-text-muted">
              {t('networkLimiting.form.dropVolumeHint', { defaultValue: 'Drops traffic exceeding the bandwidth cap.' })}
            </p>
          )}
        </div>

        {/* Escalation */}
        <div className="rounded-md border border-border bg-bg-tertiary/50 p-3 space-y-3">
          <ToggleSwitch
            checked={escalate}
            onChange={setEscalate}
            label={t('networkLimiting.form.escalate', { defaultValue: 'Escalate to auto-ban when far over the limit' })}
          />
          {escalate && (
            <div className="flex gap-3">
              <div className="flex-1">
                <Input
                  label={t('networkLimiting.form.banMultiplier', { defaultValue: 'Ban at × limit' })}
                  placeholder="20"
                  type="number"
                  min={2}
                  value={banMultiplier}
                  onChange={e => setBanMultiplier(e.target.value)}
                />
              </div>
              <div className="flex-1">
                <Input
                  label={t('networkLimiting.form.banTtl', { defaultValue: 'Ban TTL (sec, opt.)' })}
                  placeholder={t('networkLimiting.form.banTtlPermanent', { defaultValue: 'permanent' })}
                  type="number"
                  value={banTtl}
                  onChange={e => setBanTtl(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* Enabled */}
        <ToggleSwitch
          checked={enabled}
          onChange={setEnabled}
          label={enabled
            ? t('networkLimiting.form.enabled', { defaultValue: 'Enabled' })
            : t('networkLimiting.form.disabled', { defaultValue: 'Disabled (kept, not delivered)' })}
        />

        {/* Target */}
        {lockedTarget ? (
          <div className="space-y-1">
            <span className="block text-sm font-medium text-text-secondary">{t('networkLimiting.form.appliesTo', { defaultValue: 'Applies to' })}</span>
            <div className="rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary">{lockedLabel}</div>
          </div>
        ) : (
          <div className="space-y-2">
            <span className="block text-sm font-medium text-text-secondary">{t('networkLimiting.form.applyTo', { defaultValue: 'Apply to' })}</span>
            <div role="radiogroup" className="flex w-fit items-center gap-1 rounded-lg bg-bg-secondary p-1">
              {scopeModes.map(m => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={scopeMode === m}
                  onClick={() => setScopeMode(m)}
                  className={cn('px-3 py-1 text-xs font-medium rounded-md transition-colors',
                    scopeMode === m ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary')}
                >
                  {m === 'specific'
                    ? t('networkLimiting.form.specific', { defaultValue: 'Groups / Agents' })
                    : scopeName(t, m)}
                </button>
              ))}
            </div>
            {scopeMode === 'specific' && (
              <TargetTreePicker
                tree={groupTree}
                devices={devices}
                selGroups={selGroups}
                selAgents={selAgents}
                onChange={(g, a) => { setSelGroups(g); setSelAgents(a); }}
              />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The fixed target of an existing policy (edit mode). */
function targetOf(p: RateLimitPolicy): Target {
  if ((p.scope === 'group' || p.scope === 'agent') && p.scopeId != null) return { scope: p.scope, scopeId: p.scopeId };
  return { scope: p.scope === 'tenant' ? 'tenant' : 'global' };
}

// ── Policy mutations shared by the panel and the page ─────────────────────────

function usePolicyActions(reload: () => void) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<Set<number>>(new Set());

  const mark = (id: number, on: boolean) => setBusy(prev => {
    const n = new Set(prev);
    if (on) n.add(id); else n.delete(id);
    return n;
  });

  const createAll = async (config: PolicyConfig, targets: Target[]) => {
    try {
      await Promise.all(targets.map(tg =>
        rateLimitPoliciesApi.create({ ...config, scope: tg.scope, scopeId: 'scopeId' in tg ? tg.scopeId : null })));
      toast.success(targets.length > 1
        ? t('networkLimiting.toast.createdMany', { count: targets.length, defaultValue: 'Limit applied to {{count}} targets' })
        : t('networkLimiting.toast.created', { defaultValue: 'Network limit added' }));
      reload();
    } catch (err) {
      toast.error(errorMessage(err, t('networkLimiting.toast.createFailed', { defaultValue: 'Failed to add limit' })));
      reload();
      throw err;
    }
  };

  const save = async (p: RateLimitPolicy, config: PolicyConfig) => {
    try {
      await rateLimitPoliciesApi.update(p.id, config);
      toast.success(t('networkLimiting.toast.updated', { defaultValue: 'Network limit updated' }));
      reload();
    } catch (err) {
      toast.error(errorMessage(err, t('networkLimiting.toast.updateFailed', { defaultValue: 'Failed to update limit' })));
      throw err;
    }
  };

  const toggle = async (p: RateLimitPolicy, enabled: boolean) => {
    mark(p.id, true);
    try {
      await rateLimitPoliciesApi.update(p.id, { enabled });
      toast.success(enabled
        ? t('networkLimiting.toast.enabled', { defaultValue: 'Limit enabled' })
        : t('networkLimiting.toast.disabled', { defaultValue: 'Limit disabled' }));
      reload();
    } catch (err) {
      toast.error(errorMessage(err, t('networkLimiting.toast.updateFailed', { defaultValue: 'Failed to update limit' })));
    } finally {
      mark(p.id, false);
    }
  };

  const remove = async (p: RateLimitPolicy) => {
    const ok = await confirm({
      title: t('networkLimiting.deleteTitle', { defaultValue: 'Delete network limit' }),
      message: t('networkLimiting.deleteMessage', { defaultValue: 'The agent will stop enforcing this limit on its next sync.' }),
      danger: true,
    });
    if (!ok) return;
    mark(p.id, true);
    try {
      await rateLimitPoliciesApi.delete(p.id);
      toast.success(t('networkLimiting.toast.deleted', { defaultValue: 'Limit removed' }));
      reload();
    } catch (err) {
      toast.error(errorMessage(err, t('networkLimiting.toast.deleteFailed', { defaultValue: 'Failed to remove limit' })));
    } finally {
      mark(p.id, false);
    }
  };

  return { createAll, save, toggle, remove, busy };
}

// ── NetworkLimitsPanel (embeddable, locked to one target) ───────────────────────

export function NetworkLimitsPanel({ scope, scopeId, label, title, readOnly = false }: {
  scope: 'group' | 'agent';
  scopeId: number;
  label: string;
  title?: string;
  /** Another tenant's agent (Default god view): list only, no add/delete. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const canWrite = useCan('rate_limit.write') && !readOnly;
  const [policies, setPolicies] = useState<RateLimitPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<RateLimitPolicy | null>(null);
  const [enforcement] = useEnforcement();
  const [support, setSupport] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPolicies(await rateLimitPoliciesApi.list(scope, scopeId));
    } catch {
      toast.error(t('networkLimiting.loadFailed', { defaultValue: 'Failed to load network limits' }));
    } finally {
      setLoading(false);
    }
  }, [scope, scopeId, t]);

  useEffect(() => { void load(); }, [load]);

  // Agent view: can this agent enforce limits at all (heartbeat capabilities)?
  useEffect(() => {
    if (scope !== 'agent') { setSupport(null); return; }
    let live = true;
    agentApi.getDeviceById(scopeId)
      .then(d => { if (live) setSupport(rateLimitSupport(d)); })
      .catch(() => { if (live) setSupport(null); });
    return () => { live = false; };
  }, [scope, scopeId]);

  const { createAll, save, toggle, remove, busy } = usePolicyActions(() => void load());

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
          <Network size={14} className="text-text-muted" />{title ?? t('networkLimiting.panelTitle', { defaultValue: 'Network limits' })}
          {support === false && <UnsupportedBadge />}
        </h3>
        {canWrite && (
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus size={12} className="mr-1" />{t('networkLimiting.add', { defaultValue: 'Add' })}
          </Button>
        )}
      </div>

      {enforcement === 'off' && policies.length > 0 && <EnforcementOffNote />}

      {loading ? (
        <p className="text-xs text-text-muted">{t('common.loading', { defaultValue: 'Loading…' })}</p>
      ) : policies.length === 0 ? (
        <p className="text-xs text-text-muted">
          {scope === 'group'
            ? t('networkLimiting.emptyGroup', { defaultValue: 'No limits set for this group.' })
            : t('networkLimiting.emptyAgent', { defaultValue: 'No limits set for this agent.' })}
        </p>
      ) : (
        <div className="space-y-2">
          {policies.map(p => {
            const escalation = escalationLabel(t, p);
            return (
              <div key={p.id} className={cn('flex items-center gap-2 rounded-md border border-border bg-bg-tertiary/40 px-3 py-2', !p.enabled && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <TypeBadge type={p.type} />
                    {!p.enabled && <span className="text-[10px] text-text-muted">{t('networkLimiting.disabled', { defaultValue: 'disabled' })}</span>}
                  </div>
                  <div className="font-mono text-[11px] text-text-secondary mt-1 truncate">{describeLimit(t, p)}</div>
                  {escalation && <div className="text-[10px] text-text-muted mt-0.5">{escalation}</div>}
                </div>
                {canWrite && (
                  <>
                    <ToggleSwitch
                      size="sm"
                      checked={p.enabled}
                      disabled={busy.has(p.id)}
                      onChange={v => void toggle(p, v)}
                      ariaLabel={p.enabled
                        ? t('networkLimiting.disableLimit', { defaultValue: 'Disable limit' })
                        : t('networkLimiting.enableLimit', { defaultValue: 'Enable limit' })}
                    />
                    <IconButton
                      size="sm"
                      label={t('networkLimiting.editLimit', { defaultValue: 'Edit limit' })}
                      icon={<Pencil size={13} />}
                      onClick={() => setEditing(p)}
                    />
                    <IconButton
                      size="sm"
                      variant="danger"
                      label={t('networkLimiting.deleteLimit', { defaultValue: 'Delete limit' })}
                      icon={<Trash2 size={13} />}
                      disabled={busy.has(p.id)}
                      onClick={() => void remove(p)}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAdd && canWrite && (
        <PolicyModal
          onSave={async (config, targets) => { await createAll(config, targets); setShowAdd(false); }}
          onClose={() => setShowAdd(false)}
          lockedTarget={{ scope, scopeId }}
          lockedLabel={label}
        />
      )}
      {editing && canWrite && (
        <PolicyModal
          initial={editing}
          onSave={async (config) => { await save(editing, config); setEditing(null); }}
          onClose={() => setEditing(null)}
          lockedTarget={targetOf(editing)}
          lockedLabel={label}
        />
      )}
    </div>
  );
}

// ── RateLimitPage (full page, or the "Network limits" tab of Policies) ────────

type ScopeFilter = RateLimitScope | 'all';

interface TargetGroup {
  key: string;
  scope: RateLimitScope;
  label: string;
  tenantId: number | null;
  rows: RateLimitPolicy[];
}

export interface RateLimitPageProps {
  /** Rendered inside another page (Policies hub): no page padding nor title. */
  embedded?: boolean;
}

export function RateLimitPage({ embedded = false }: RateLimitPageProps = {}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const canWrite = useCan('rate_limit.write');
  const isPlatformAdmin = useIsPlatformAdmin();
  const isMaster = useIsMasterTenant();
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  // The switch is instance-wide: platform admin operating the Default tenant.
  const canSwitch = isPlatformAdmin && isMaster;

  const [policies, setPolicies] = useState<RateLimitPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [search, setSearch] = useState('');
  const [groupByTarget, setGroupByTarget] = usePersistedState<boolean>('og-netlimits-group', false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editing, setEditing] = useState<RateLimitPolicy | null>(null);

  const [enforcement, setEnforcement, reloadEnforcement] = useEnforcement();
  const [switching, setSwitching] = useState(false);

  // Name and capability resolution for the target column
  const [groupNames, setGroupNames] = useState<Map<number, string>>(new Map());
  const [devices, setDevices] = useState<Map<number, AgentDevice>>(new Map());

  useEffect(() => {
    // Names fall back to "Group #id" / "Agent #id" when either list fails.
    void Promise.allSettled([
      groupsApi.tree().then(tree => {
        const m = new Map<number, string>();
        const walk = (nodes: GroupTreeNode[]) => nodes.forEach(n => { m.set(n.id, n.name); walk(n.children); });
        walk(tree);
        setGroupNames(m);
      }),
      agentApi.listDevices('approved').then(ds => setDevices(new Map(ds.map(d => [d.id, d])))),
    ]);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPolicies(await rateLimitPoliciesApi.list(scopeFilter));
      setLoadError(false);
    } catch {
      setLoadError(true);
      toast.error(t('networkLimiting.loadFailed', { defaultValue: 'Failed to load network limits' }));
    } finally {
      setLoading(false);
    }
  }, [scopeFilter, t]);

  useEffect(() => { void load(); }, [load]);

  const { createAll, save, toggle, remove, busy } = usePolicyActions(() => void load());

  const agentLabel = useCallback((id: number): string => {
    const d = devices.get(id);
    return d ? (d.name || d.hostname) : t('networkLimiting.agentFallback', { id, defaultValue: 'Agent #{{id}}' });
  }, [devices, t]);

  const targetLabel = useCallback((p: RateLimitPolicy): string => {
    if (p.scope === 'group' && p.scopeId != null) {
      return groupNames.get(p.scopeId) ?? t('networkLimiting.groupFallback', { id: p.scopeId, defaultValue: 'Group #{{id}}' });
    }
    if (p.scope === 'agent' && p.scopeId != null) return agentLabel(p.scopeId);
    return '';
  }, [groupNames, agentLabel, t]);

  /**
   * Only the owner edits, toggles or deletes (server rule): a global policy
   * from the Default tenant, a local one from its own tenant (Default sees
   * other tenants' rows read-only).
   */
  const canEdit = (p: RateLimitPolicy): boolean => {
    if (!canWrite || currentTenantId == null) return false;
    if (p.scope === 'global') return isMaster;
    return Number(p.tenantId ?? 1) === Number(currentTenantId);
  };

  /** Agents that reported capabilities without 'ratelimit' (they ignore every limit). */
  const unsupportedAgents = useMemo(
    () => [...devices.values()].filter(d => rateLimitSupport(d) === false),
    [devices],
  );

  // Client-side search over what the row shows (type, limit, action, target).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return policies;
    return policies.filter(p => [
      typeLabel(t, p.type),
      describeLimit(t, p),
      actionLabel(t, p.action),
      scopeName(t, p.scope),
      targetLabel(p),
      p.port != null ? String(p.port) : '',
    ].some(s => s.toLowerCase().includes(q)));
  }, [policies, search, t, targetLabel]);

  // Grouping by target: global, tenant(s), then groups and agents by name.
  const groups = useMemo<TargetGroup[]>(() => {
    const byKey = new Map<string, TargetGroup>();
    for (const p of filtered) {
      const key = p.scope === 'group' || p.scope === 'agent'
        ? `${p.scope}:${p.scopeId}`
        : p.scope === 'tenant' ? `tenant:${p.tenantId ?? ''}` : 'global';
      let g = byKey.get(key);
      if (!g) {
        g = { key, scope: p.scope, label: targetLabel(p) || scopeName(t, p.scope), tenantId: p.tenantId, rows: [] };
        byKey.set(key, g);
      }
      g.rows.push(p);
    }
    return [...byKey.values()].sort((a, b) =>
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]
      || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  }, [filtered, targetLabel, t]);

  /** Turning enforcement on first lists every enabled policy for review. */
  const requestEnforcement = async (on: boolean) => {
    if (!on) {
      await applyEnforcement('off');
      return;
    }
    let enabled: RateLimitPolicy[];
    try {
      enabled = (await rateLimitPoliciesApi.list('all')).filter(p => p.enabled);
    } catch (err) {
      toast.error(errorMessage(err, t('networkLimiting.loadFailed', { defaultValue: 'Failed to load network limits' })));
      return;
    }
    const ok = await confirm({
      title: t('networkLimiting.activation.title', { defaultValue: 'Turn on rate-limit enforcement?' }),
      message: (
        <div className="space-y-3">
          <p>
            {enabled.length === 0
              ? t('networkLimiting.activation.none', {
                defaultValue: 'No limit is enabled yet: agents will only start enforcing limits once you enable some.',
              })
              : t('networkLimiting.activation.review', {
                count: enabled.length,
                defaultValue: '{{count}} enabled limit(s) will be delivered to every supporting agent on its next heartbeat. Review them first: a limit too low can cut legitimate traffic.',
              })}
          </p>
          {enabled.length > 0 && (
            <div className="max-h-60 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {enabled.map(p => (
                <div key={p.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <TypeBadge type={p.type} />
                  <span className="font-mono text-text-secondary truncate flex-1">{describeLimit(t, p)}</span>
                  <ScopeBadge scope={p.scope} scopeName={targetLabel(p) || null} showTooltip={false} />
                </div>
              ))}
            </div>
          )}
        </div>
      ),
      confirmLabel: t('networkLimiting.activation.confirm', { defaultValue: 'Turn on enforcement' }),
      danger: true,
    });
    if (ok) await applyEnforcement('on');
  };

  const applyEnforcement = async (value: RateLimitEnforcement) => {
    setSwitching(true);
    try {
      setEnforcement(await rateLimitPoliciesApi.setEnforcement(value));
      toast.success(value === 'on'
        ? t('networkLimiting.toast.enforcementOn', { defaultValue: 'Enforcement enabled: agents receive their limits on their next heartbeat' })
        : t('networkLimiting.toast.enforcementOff', { defaultValue: 'Enforcement disabled: agents clear their limits on their next heartbeat' }));
    } catch (err) {
      toast.error(errorMessage(err, t('networkLimiting.toast.enforcementFailed', { defaultValue: 'Failed to change enforcement' })));
      reloadEnforcement();
    } finally {
      setSwitching(false);
    }
  };

  const scopeFilters: { key: ScopeFilter; label: string }[] = [
    { key: 'all', label: t('networkLimiting.filters.all', { defaultValue: 'All' }) },
    // Listing scope=global alone is admin-only on the server (403 otherwise);
    // other writers still see the global rows under "All".
    ...(['global', 'tenant', 'group', 'agent'] as const)
      .filter(s => s !== 'global' || isPlatformAdmin)
      .map(s => ({ key: s as ScopeFilter, label: scopeName(t, s) })),
  ];
  const hasFilters = scopeFilter !== 'all' || search.trim() !== '';
  const clearFilters = () => { setScopeFilter('all'); setSearch(''); };

  const th = 'px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted';
  const colCount = 8;

  const addButton = canWrite && (
    <Button size="sm" onClick={() => setShowAddModal(true)}>
      <Plus size={14} className="mr-1.5" />{t('networkLimiting.addLimit', { defaultValue: 'Add limit' })}
    </Button>
  );
  const actions = (
    <>
      <IconButton
        label={t('common.refresh', { defaultValue: 'Refresh' })}
        icon={<RefreshCw size={14} className={cn(loading && 'animate-spin')} />}
        onClick={() => { void load(); reloadEnforcement(); }}
      />
      {addButton}
    </>
  );
  const description = t('networkLimiting.description', {
    defaultValue: 'Per-IP connection, rate and bandwidth limits enforced on agents',
  });

  const renderRow = (p: RateLimitPolicy, showTarget: boolean): ReactNode => {
    const editable = canEdit(p);
    const agentSupport = p.scope === 'agent' && p.scopeId != null ? rateLimitSupport(devices.get(p.scopeId)) : null;
    const target = targetLabel(p);
    const escalation = escalationLabel(t, p);
    const items: ActionMenuItem[] = [
      { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit', { defaultValue: 'Edit' }), onClick: () => setEditing(p) },
      {
        key: 'toggle',
        icon: <Power size={14} />,
        label: p.enabled
          ? t('networkLimiting.disableLimit', { defaultValue: 'Disable limit' })
          : t('networkLimiting.enableLimit', { defaultValue: 'Enable limit' }),
        onClick: () => void toggle(p, !p.enabled),
      },
      {
        key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete', { defaultValue: 'Delete' }),
        onClick: () => void remove(p), danger: true, separator: true,
      },
    ];
    return (
      <tr key={p.id} className="h-11 transition-colors hover:bg-bg-hover">
        <td className="px-4 py-2">
          <ToggleSwitch
            size="sm"
            checked={p.enabled}
            disabled={!editable || busy.has(p.id)}
            onChange={v => void toggle(p, v)}
            ariaLabel={p.enabled
              ? t('networkLimiting.disableLimit', { defaultValue: 'Disable limit' })
              : t('networkLimiting.enableLimit', { defaultValue: 'Enable limit' })}
            title={editable ? undefined : t('networkLimiting.readOnlyHint', { defaultValue: 'Read-only: owned by another tenant or needs the network-limits permission' })}
          />
        </td>
        <td className={cn('px-4 py-2', !p.enabled && 'opacity-50')}><TypeBadge type={p.type} /></td>
        <td className={cn('px-4 py-2 whitespace-nowrap font-mono text-xs text-text-primary', !p.enabled && 'opacity-50')}>{describeLimit(t, p)}</td>
        <td className={cn('px-4 py-2 text-text-secondary', !p.enabled && 'opacity-50')}>{actionLabel(t, p.action)}</td>
        <td className={cn('px-4 py-2 whitespace-nowrap text-xs text-text-muted', !p.enabled && 'opacity-50')}>{escalation ?? '—'}</td>
        <td className="px-4 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <ScopeBadge scope={p.scope} scopeName={target || null} />
            {showTarget && target && (
              <span className="max-w-[14rem] truncate text-xs text-text-secondary" title={target}>{target}</span>
            )}
            {p.scope !== 'global' && Number(p.tenantId ?? 1) !== Number(currentTenantId) && <TenantBadge tenantId={p.tenantId} />}
          </div>
          {agentSupport === false && <div className="mt-1"><UnsupportedBadge /></div>}
        </td>
        <td className="px-4 py-2 whitespace-nowrap text-xs text-text-muted">{formatDate(p.createdAt)}</td>
        <td className="px-4 py-2">
          <div className="flex items-center justify-end">
            {editable && <ActionMenu items={items} triggerSize="sm" disabled={busy.has(p.id)} />}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <PageContainer embedded={embedded} className="space-y-5">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text-muted">{description}</p>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      ) : (
        <PageHeader
          icon={<Gauge size={20} />}
          title={t('networkLimiting.title', { defaultValue: 'Network limiting' })}
          description={description}
          actions={actions}
        />
      )}

      {/* Global enforcement switch */}
      {enforcement !== null && (
        <div className={cn(
          'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3',
          enforcement === 'on' ? 'border-status-up/30 bg-status-up/5' : 'border-yellow-500/30 bg-yellow-500/10',
        )}>
          {enforcement === 'on'
            ? <ShieldCheck size={16} className="text-status-up shrink-0" />
            : <ShieldOff size={16} className="text-yellow-400 shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-primary">
              {enforcement === 'on'
                ? t('networkLimiting.enforcementOn', { defaultValue: 'Enforcement is on' })
                : t('networkLimiting.enforcementOff', { defaultValue: 'Enforcement is off' })}
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              {enforcement === 'on'
                ? t('networkLimiting.enforcementOnHint', { defaultValue: 'Enabled limits are delivered to every supporting agent on its next heartbeat.' })
                : t('networkLimiting.enforcementOffHint', { defaultValue: 'Limits are stored but not delivered: agents enforce nothing until enforcement is turned on.' })}
            </div>
          </div>
          {canSwitch && (
            <ToggleSwitch
              checked={enforcement === 'on'}
              disabled={switching}
              onChange={v => void requestEnforcement(v)}
              label={enforcement === 'on' ? t('common.on', { defaultValue: 'On' }) : t('common.off', { defaultValue: 'Off' })}
            />
          )}
        </div>
      )}

      {unsupportedAgents.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs text-text-muted" title={unsupportedHint(t)}>
          <ShieldOff size={13} className="shrink-0 mt-0.5 text-status-down" />
          <span>
            {t('networkLimiting.unsupportedAgents', {
              count: unsupportedAgents.length,
              names: unsupportedAgents.slice(0, 5).map(d => d.name || d.hostname).join(', '),
              defaultValue: '{{count}} agent(s) cannot enforce network limits (Windows, pf or firewalld backend, or an older agent): {{names}}',
            })}
            {unsupportedAgents.length > 5
              ? ` ${t('networkLimiting.andMore', { count: unsupportedAgents.length - 5, defaultValue: 'and {{count}} more' })}`
              : ''}
          </span>
        </div>
      )}

      {/* Filters: scope chips, search, grouping */}
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t('networkLimiting.filters.scope', { defaultValue: 'Scope' })} className="flex flex-wrap items-center gap-1.5">
          {scopeFilters.map(f => (
            <button
              key={f.key}
              type="button"
              aria-pressed={scopeFilter === f.key}
              onClick={() => setScopeFilter(f.key)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors coarse:min-h-10 coarse:px-4',
                scopeFilter === f.key
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-transparent bg-bg-secondary text-text-muted hover:text-text-primary',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('networkLimiting.searchPlaceholder', { defaultValue: 'Type, port, target…' })}
            aria-label={t('common.search', { defaultValue: 'Search' })}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-md border border-border bg-bg-secondary py-2 pl-9 pr-8 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('networkLimiting.clearSearch', { defaultValue: 'Clear search' })}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-muted hover:text-text-primary"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="ml-auto">
          <ToggleSwitch
            size="sm"
            checked={groupByTarget}
            onChange={setGroupByTarget}
            label={<span className="text-xs text-text-secondary">{t('networkLimiting.groupByTarget', { defaultValue: 'Group by target' })}</span>}
          />
        </div>
      </div>

      {/* Table */}
      <TableScroll className="bg-bg-secondary">
        <table className={cn('w-full text-sm', loading && policies.length > 0 && 'opacity-60 transition-opacity')} aria-busy={loading}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={th}>{t('networkLimiting.columns.enabled', { defaultValue: 'Enabled' })}</th>
              <th scope="col" className={th}>{t('networkLimiting.columns.type', { defaultValue: 'Type' })}</th>
              <th scope="col" className={th}>{t('networkLimiting.columns.limit', { defaultValue: 'Limit' })}</th>
              <th scope="col" className={th}>{t('networkLimiting.columns.onExceed', { defaultValue: 'On exceed' })}</th>
              <th scope="col" className={th}>{t('networkLimiting.columns.escalation', { defaultValue: 'Escalation' })}</th>
              <th scope="col" className={th}>{t('networkLimiting.columns.target', { defaultValue: 'Target' })}</th>
              <th scope="col" className={th}>{t('networkLimiting.columns.added', { defaultValue: 'Added' })}</th>
              <th scope="col" className={cn(th, 'text-right')}>
                <span className="sr-only">{t('common.actions', { defaultValue: 'Actions' })}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {loading && policies.length === 0 ? (
              <TableSkeleton rows={5} cols={colCount} />
            ) : filtered.length === 0 ? (
              loadError ? (
                <EmptyState
                  colSpan={colCount}
                  title={t('networkLimiting.loadFailed', { defaultValue: 'Failed to load network limits' })}
                  action={<Button size="sm" variant="secondary" onClick={() => void load()}>{t('common.refresh', { defaultValue: 'Refresh' })}</Button>}
                />
              ) : hasFilters ? (
                <EmptyState variant="filtered" colSpan={colCount} onClearFilters={clearFilters} />
              ) : (
                <EmptyState
                  colSpan={colCount}
                  icon={<Activity size={32} strokeWidth={1.5} />}
                  title={t('networkLimiting.empty', { defaultValue: 'No network limits yet' })}
                  action={canWrite
                    ? <Button size="sm" onClick={() => setShowAddModal(true)}><Plus size={14} className="mr-1.5" />{t('networkLimiting.addFirst', { defaultValue: 'Add first limit' })}</Button>
                    : undefined}
                />
              )
            ) : groupByTarget ? (
              groups.map(g => (
                <TargetGroupRows key={g.key} group={g} colCount={colCount} renderRow={renderRow} />
              ))
            ) : (
              filtered.map(p => renderRow(p, true))
            )}
          </tbody>
        </table>
      </TableScroll>

      {showAddModal && canWrite && (
        <PolicyModal
          onSave={async (config, targets) => { await createAll(config, targets); setShowAddModal(false); }}
          onClose={() => setShowAddModal(false)}
        />
      )}
      {editing && canEdit(editing) && (
        <PolicyModal
          initial={editing}
          onSave={async (config) => { await save(editing, config); setEditing(null); }}
          onClose={() => setEditing(null)}
          lockedTarget={targetOf(editing)}
          lockedLabel={targetLabel(editing) || scopeName(t, editing.scope)}
        />
      )}
    </PageContainer>
  );
}

/** One target's header row followed by its policies (grouped view). */
function TargetGroupRows({ group, colCount, renderRow }: {
  group: TargetGroup;
  colCount: number;
  renderRow: (p: RateLimitPolicy, showTarget: boolean) => ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <tr className="bg-bg-tertiary/60">
        <th scope="rowgroup" colSpan={colCount} className="px-4 py-2 text-left">
          <div className="flex min-w-0 items-center gap-2">
            <ScopeBadge scope={group.scope} showTooltip={false} />
            {group.scope !== 'global' && (
              <span className="truncate text-sm font-medium text-text-primary">{group.label}</span>
            )}
            {group.scope !== 'global' && <TenantBadge tenantId={group.tenantId} />}
            <span className="ml-auto shrink-0 text-xs font-normal text-text-muted">
              {t('networkLimiting.groupCount', { count: group.rows.length, defaultValue: '{{count}} limit(s)' })}
            </span>
          </div>
        </th>
      </tr>
      {group.rows.map(p => renderRow(p, false))}
    </>
  );
}
