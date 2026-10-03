import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Trash2,
  Key,
  Cpu,
  CheckCircle,
  XCircle,
  Copy,
  Check,
  RefreshCw,
  Pencil,
  X,
  Router,
  ArrowUpCircle,
  Lock,
  AlertTriangle,
  FolderOpen,
  List,
  RotateCcw,
  Ban,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SOCKET_EVENTS } from '@obliview/shared';
import type {
  AgentDevice, MonitorGroup, AgentUpdatePolicy, AgentVersionDistribution, AgentTenantUpdatePolicyInfo,
} from '@obliview/shared';
import { agentApi } from '@/api/agent.api';
import type { AgentUpdateRolloutPreview, AgentUpdateAllResult, RolloutFrozenLevel } from '@/api/agent.api';
import { agentKeysApi, type AgentKey, type AgentKeyCreated } from '@/api/agentKeys.api';
import { groupsApi } from '@/api/groups.api';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { toDevicePatch } from '@/store/agentStore';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { EmptyState } from '@/components/common/EmptyState';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { useUiStore } from '@/store/uiStore';
import { useCan, Can, useIsPlatformAdmin } from '@/hooks/usePermission';
import { useTabParam } from '@/hooks/useTabParam';
import { useTenantStore } from '@/store/tenantStore';
import { AddMikroTikModal } from '@/components/mikrotik/AddMikroTikModal';
import { anonHostname, anonIp } from '@/utils/anonymize';
import {
  agentBuildLabel, agentUpdateErrorMessage, isUpdateFailed, isUpdateInFlight, visibleUpdateAttempt,
  updatePolicySourceLabel,
} from '@/utils/agentUpdate';
import { UpdateStatusBadge } from '@/components/agent/UpdateStatusBadge';
import { LastSeenPill } from '@/components/agent/LastSeenPill';
import toast from 'react-hot-toast';

/**
 * /manage/agents — the "Agent config" hub (W10-2), mirrored from Obliance
 * AdminDevicesPage: enrolment keys, pending approvals and the agent update
 * policy. The fleet list itself lives on /agents (AgentListPage): the legacy
 * `?tab=devices` and `?status=…` links (dashboard deep links) are redirected
 * there, `?status=pending` opens the approvals tab.
 */

/** Emitted to tenant admins when an agent registers (pending approval). */
const AGENT_DEVICE_CREATED = SOCKET_EVENTS.AGENT_DEVICE_CREATED;

const TABS = ['keys', 'approvals', 'policy'] as const;
type Tab = typeof TABS[number];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Copy to the clipboard with a toast that reflects the real outcome. */
async function copyWithToast(text: string, okMsg: string, failMsg: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
    return true;
  } catch {
    toast.error(failMsg);
    return false;
  }
}

/** Agent groups of the operating tenant, flattened depth-first with their depth. */
interface FlatGroup { id: number; name: string; depth: number; group: MonitorGroup }

function GroupSelect({
  value, onChange, groups, disabled, className, ariaLabel,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  groups: FlatGroup[];
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className ?? 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60'}
    >
      <option value="">{t('agents.noGroup')}</option>
      {groups.map(g => (
        <option key={g.id} value={g.id}>{'  '.repeat(g.depth)}{g.name}</option>
      ))}
    </select>
  );
}

// ── ApproveModal ──────────────────────────────────────────────────────────────

function ApproveModal({
  device,
  groups,
  initialGroupId,
  canPickGroup,
  onApprove,
  onCancel,
}: {
  device: AgentDevice;
  groups: FlatGroup[];
  /** agents.manage: without it the server refuses a groupId next to the status. */
  canPickGroup: boolean;
  /** Pre-filled: the device's registration group, else its key's default group. */
  initialGroupId: number | null;
  /** undefined: keep the registration group (or the key's default group). */
  onApprove: (groupId: number | null | undefined) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(
    initialGroupId != null && groups.some(g => g.id === initialGroupId) ? initialGroupId : null,
  );
  const [saving, setSaving] = useState(false);
  const selectedGroup = groups.find(g => g.id === selectedGroupId)?.group;
  const hasGroupThresholds = selectedGroup?.agentThresholds != null;

  const submit = async () => {
    setSaving(true);
    try { await onApprove(canPickGroup ? selectedGroupId : undefined); } finally { setSaving(false); }
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('agents.approveTitle')}
      size="sm"
      dismissible={!saving}
      footer={(
        <div className="flex gap-2">
          <Button onClick={() => void submit()} loading={saving} className="flex-1">
            <CheckCircle size={14} className="mr-1.5" />{t('agents.approve')}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={saving} className="flex-1">{t('common.cancel')}</Button>
        </div>
      )}
    >
      <p className="text-sm text-text-muted mb-4">
        {canPickGroup
          ? t('agents.approveDesc', { hostname: anonHostname(device.hostname) })
          : t('agentDetail.lifecycle.approveDescNoGroup', {
            hostname: anonHostname(device.hostname),
            defaultValue: 'Approve {{hostname}}: it starts receiving its configuration and enforcing bans. It keeps its current group (or the default group of its enrollment key).',
          })}
      </p>
      {canPickGroup && <div className="space-y-1">
        <label className="block text-sm font-medium text-text-secondary">{t('agents.assignGroup')}</label>
        <GroupSelect value={selectedGroupId} onChange={setSelectedGroupId} groups={groups} ariaLabel={t('agents.assignGroup')} />
        {groups.length === 0 && (
          <p className="text-xs text-text-muted mt-1">{t('agents.noAgentGroups')}</p>
        )}
        {initialGroupId != null && selectedGroupId === initialGroupId && (
          <p className="text-xs text-text-muted mt-1">
            {t('agentConfig.approvals.prefilled', 'Pre-filled with the enrolment key\'s default group.')}
          </p>
        )}
        {hasGroupThresholds && (
          <p className="text-xs text-status-up mt-1">{t('agents.groupThresholdsNote')}</p>
        )}
      </div>}
    </Modal>
  );
}

// ── CreateKeyModal + NewKeyModal (copy once) ──────────────────────────────────

function CreateKeyModal({
  groups,
  onCreated,
  onCancel,
}: {
  groups: FlatGroup[];
  onCreated: (key: AgentKeyCreated) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      onCreated(await agentKeysApi.create(name.trim(), groupId));
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentConfig.keys.createFailed', 'Failed to create the key')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('agentConfig.keys.newTitle', 'New enrolment key')}
      icon={<Key size={16} />}
      size="sm"
      dismissible={!saving}
      footer={(
        <div className="flex gap-2">
          <Button onClick={() => void submit()} loading={saving} disabled={!name.trim()} className="flex-1">
            {t('common.create')}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={saving} className="flex-1">{t('common.cancel')}</Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">{t('agentConfig.keys.name', 'Name')}</label>
          <Input
            placeholder={t('agentConfig.keys.namePlaceholder', 'Key name (e.g. Production servers)')}
            value={name}
            maxLength={255}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
            autoFocus
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">{t('agentConfig.keys.defaultGroup', 'Default group')}</label>
          <GroupSelect value={groupId} onChange={setGroupId} groups={groups} ariaLabel={t('agentConfig.keys.defaultGroup', 'Default group')} />
          <p className="text-xs text-text-muted mt-1">
            {t('agentConfig.keys.defaultGroupHelp', 'Agents enrolled with this key land in this group (still pending approval), so its templates, limits and team access apply from the start.')}
          </p>
        </div>
      </div>
    </Modal>
  );
}

function NewKeyModal({ created, onClose }: { created: AgentKeyCreated; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyWithToast(
      created.key,
      t('common.copied', 'Copied'),
      t('agentConfig.keys.copyFailed', 'Could not copy — select the key and copy it manually'),
    )) setCopied(true);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('agentConfig.keys.createdTitle', 'Key created')}
      icon={<Key size={16} />}
      size="md"
      closeOnBackdrop={false}
      footer={<Button onClick={onClose} className="w-full">{t('common.close', 'Close')}</Button>}
    >
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          {t('agentConfig.keys.createdDesc', {
            defaultValue: 'Copy the key "{{name}}" now: the list only shows a masked value. The Add Agent dialog builds the install commands for you.',
            name: created.name,
          })}
        </p>
        <div className="flex items-start gap-2 rounded-md bg-bg-tertiary p-3">
          <code className="flex-1 text-sm font-mono text-text-primary break-all select-all">{created.key}</code>
          <IconButton
            label={t('common.copy', 'Copy')}
            icon={copied ? <Check size={14} className="text-status-up" /> : <Copy size={14} />}
            onClick={() => void copy()}
            size="md"
            className="shrink-0"
          />
        </div>
        {created.defaultGroupName && (
          <p className="flex items-center gap-1.5 text-xs text-text-muted">
            <FolderOpen size={12} />
            {t('agentConfig.keys.defaultGroupIs', { defaultValue: 'Default group: {{group}}', group: created.defaultGroupName })}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── AgentVersionStrip (C17-1) ─────────────────────────────────────────────────

function AgentVersionStrip({ dist }: { dist: AgentVersionDistribution }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 rounded-lg border border-border bg-bg-secondary text-xs">
      <span className="font-medium text-text-secondary">{t('agentUpdate.distribution.title', 'Agent versions')}</span>
      {dist.latestVersion && (
        <span className="text-text-primary">
          {t('agentUpdate.distribution.latest', { defaultValue: 'Latest: v{{version}}', version: dist.latestVersion })}
        </span>
      )}
      <span className="text-green-400">{t('agentUpdate.distribution.upToDate', { defaultValue: '{{count}} up to date', count: dist.upToDate })}</span>
      {dist.outdated > 0 && (
        <span className="text-amber-400">{t('agentUpdate.distribution.outdated', { defaultValue: '{{count}} outdated', count: dist.outdated })}</span>
      )}
      {dist.updatePending > 0 && (
        <span className="text-blue-400">{t('agentUpdate.distribution.pending', { defaultValue: '{{count}} update(s) requested', count: dist.updatePending })}</span>
      )}
      {(dist.updateFailed ?? 0) > 0 && (
        <span className="text-red-400">{t('agents.update.failedCount', { defaultValue: '{{count}} update(s) failed', count: dist.updateFailed })}</span>
      )}
      {dist.unknown > 0 && (
        <span className="text-text-muted">{t('agentUpdate.distribution.unknown', { defaultValue: '{{count}} unknown', count: dist.unknown })}</span>
      )}
      <span className="flex flex-wrap items-center gap-1">
        {dist.versions.map(v => (
          <span
            key={v.version}
            className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${
              v.isLatest ? 'bg-accent/15 text-accent'
              : v.outdated ? 'bg-amber-500/10 text-amber-400'
              : 'bg-bg-tertiary text-text-muted'
            }`}
          >
            {v.version === 'unknown' ? '?' : `v${v.version}`} × {v.count}
          </span>
        ))}
      </span>
    </div>
  );
}

// ── MissingBuildsBanner (FLEET-AGENT-3) ───────────────────────────────────────

/** Artifacts whose build does not match the served version: those platforms are not offered it. */
function MissingBuildsBanner({ builds, version }: { builds: string[]; version: string | null }) {
  const { t } = useTranslation();
  if (builds.length === 0) return null;
  return (
    <div className="flex items-start gap-2 px-4 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-400">
      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
      <div>
        <p className="font-medium">
          {t('agents.update.missingBuilds', {
            defaultValue: 'Build missing for {{builds}}',
            builds: builds.map(agentBuildLabel).join(', '),
          })}
        </p>
        <p className="text-amber-400/80 mt-0.5">
          {t('agents.update.missingBuildsDesc', {
            defaultValue: 'Agents on these platforms are not offered v{{version}} until a matching build is published in agent/dist.',
            version: version ?? '?',
          })}
        </p>
      </div>
    </div>
  );
}

// ── AgentUpdatePolicyBar (C17: global -> tenant -> group -> agent) ────────────

/**
 * Global policy (read-only here, changed in Settings) next to the operating
 * tenant's policy: a selector for platform admins, read-only otherwise. The
 * group level is set on the group pages, the agent level on the agent page
 * and in the /agents batch bar (platform admins).
 */
function AgentUpdatePolicyBar({
  isAdmin,
  tenantId,
  tenantName,
  onChanged,
}: {
  isAdmin: boolean;
  tenantId: number | null;
  tenantName: string | null;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const [info, setInfo] = useState<AgentTenantUpdatePolicyInfo | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    agentApi.getTenantUpdatePolicy()
      .then(i => { if (!cancelled) setInfo(i); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [tenantId]);

  if (!info) return null;

  const policyName = (p: AgentUpdatePolicy) => t(`agentUpdate.policy.${p}`, p);
  const globalText = `${policyName(info.globalPolicy)}${info.globalPolicyIsDefault ? ` ${t('agentUpdate.builtInDefault', '(built-in default)')}` : ''}`;
  const tenantLabel = tenantName
    ? t('agents.update.tenantPolicyNamed', { defaultValue: 'Tenant policy ({{name}})', name: tenantName })
    : t('agents.update.tenantPolicy', 'Tenant policy');
  const inheritText = `${t('agentUpdate.policy.inherit', 'Inherit')} (${policyName(info.globalPolicy)} — ${t('agentUpdate.source.global', 'global')})`;

  const change = async (value: 'inherit' | AgentUpdatePolicy) => {
    const next = value === 'inherit' ? null : value;
    if (next === info.updatePolicy) return;
    if (next === 'auto' && !(await askConfirm({
      message: t('agents.update.confirmTenantAuto', 'Every agent of this tenant without a group or agent policy will update to the latest version at its next heartbeat, and to every future release. Continue?'),
    }))) return;
    if (next === 'off' && !(await askConfirm({
      message: t('agents.update.confirmTenantOff', 'Freeze updates for every agent of this tenant? Pending update requests are cancelled, whatever the groups and agents set.'),
      danger: true,
      confirmLabel: t('agentUpdate.policy.off', 'Off (frozen)'),
    }))) return;
    setSaving(true);
    try {
      setInfo(await agentApi.setTenantUpdatePolicy(next));
      onChanged();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentUpdate.saveFailed', 'Failed to save')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-4 py-2.5 rounded-lg border border-border bg-bg-secondary text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="font-medium text-text-secondary">{t('agentUpdate.policyLabel', 'Agent updates')}</span>
        <span className="flex flex-wrap items-center gap-2 text-text-muted">
          {t('agents.update.globalPolicy', 'Global policy')}: <span className="text-text-primary">{globalText}</span>
          {isAdmin && (
            <Link to="/settings" className="text-accent hover:underline">{t('agentUpdate.changeDefault', 'Change default')}</Link>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-2 text-text-muted">
          {tenantLabel}:
          {isAdmin ? (
            <select
              value={info.updatePolicy ?? 'inherit'}
              onChange={e => void change(e.target.value as 'inherit' | AgentUpdatePolicy)}
              disabled={saving}
              aria-label={tenantLabel}
              className="rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-60 coarse:min-h-10"
            >
              <option value="inherit">{inheritText}</option>
              <option value="auto">{policyName('auto')}</option>
              <option value="manual">{policyName('manual')}</option>
              <option value="off">{policyName('off')}</option>
            </select>
          ) : (
            <span className="text-text-primary">{info.updatePolicy ? policyName(info.updatePolicy) : inheritText}</span>
          )}
          {info.updatePolicy === 'off' && (
            <span className="inline-flex items-center gap-1 text-amber-400"><Lock size={10} />{t('agentUpdate.frozenBadge', 'Updates frozen')}</span>
          )}
        </span>
      </div>
      <p className="mt-1.5 text-text-muted leading-relaxed">
        {t('agents.update.cascadeHelp', 'Cascade: global → tenant → group → agent. The nearest explicit value wins; Off (frozen) at any level is absolute and freezes every level below.')}
      </p>
    </div>
  );
}

// ── UpdateRolloutModal (W12-4: update all outdated, paced) ────────────────────

/** Progress refresh while the modal shows a running rollout. */
const ROLLOUT_POLL_MS = 5_000;
const FROZEN_LEVELS: RolloutFrozenLevel[] = ['global', 'tenant', 'group', 'agent', 'unresolved'];

function RolloutStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${tone ?? 'text-text-primary'}`}>{value}</div>
      <div className="text-[11px] text-text-muted">{label}</div>
    </div>
  );
}

function RolloutBreakdown({ title, rows }: { title: string; rows: Array<{ key: string; label: string; count: number }> }) {
  if (rows.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted mb-1">{title}</p>
      <ul className="space-y-0.5 text-xs">
        {rows.map(r => (
          <li key={r.key} className="flex items-center justify-between gap-2">
            <span className="truncate text-text-secondary">{r.label}</span>
            <span className="tabular-nums text-text-primary">{r.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Update all outdated" (Obliance update-all preview): what the action does
 * now — per tenant / group / platform, the frozen agents with the level that
 * froze them (never updated, owner directive C17), the server pace — then the
 * progress of the rollout (offered / succeeded / failed), refreshed every 5 s.
 */
function UpdateRolloutModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<AgentUpdateRolloutPreview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AgentUpdateAllResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    agentApi.getUpdateRolloutPreview()
      .then(p => { if (!cancelled) setPreview(p); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  // Progress: re-read the preview while the rollout view is open.
  useEffect(() => {
    if (!result) return;
    const timer = setInterval(() => {
      agentApi.getUpdateRolloutPreview().then(setPreview).catch(() => { /* keep the last figures */ });
    }, ROLLOUT_POLL_MS);
    return () => clearInterval(timer);
  }, [result]);

  const levelLabels: Record<RolloutFrozenLevel, string> = {
    global: t('agentConfig.rollout.levelGlobal', 'Global policy'),
    tenant: t('agentConfig.rollout.levelTenant', 'Tenant policy'),
    group: t('agentConfig.rollout.levelGroup', 'Group policy'),
    agent: t('agentConfig.rollout.levelAgent', 'Agent policy'),
    unresolved: t('agentConfig.rollout.levelUnresolved', 'Policy unreadable'),
  };

  const submit = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      const r = await agentApi.updateAllOutdated(preview.scopeTenantId);
      setResult(r);
      setPreview(r.preview);
      toast.success(t('agentConfig.rollout.requestedToast', { defaultValue: '{{count}} update(s) requested', count: r.requested }));
      onDone();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentUpdate.bulkFailed', 'Failed to request the updates')));
    } finally {
      setSubmitting(false);
    }
  };

  const p = preview;
  const prog = p?.progress;
  const progTotal = prog ? prog.waiting + prog.offered + prog.inProgress + prog.succeeded + prog.failed : 0;
  const pct = (n: number) => (progTotal > 0 ? `${(n / progTotal) * 100}%` : '0%');

  const footer = result ? (
    <Button variant="secondary" onClick={onClose}>{t('common.close', 'Close')}</Button>
  ) : (
    <div className="flex gap-2">
      <Button variant="secondary" onClick={onClose} disabled={submitting}>{t('common.cancel')}</Button>
      <Button onClick={() => void submit()} loading={submitting} disabled={!p || p.toRequest === 0}>
        <ArrowUpCircle size={14} className="mr-1.5" />
        {t('agentConfig.rollout.confirm', { defaultValue: 'Update {{count}} agent(s)', count: p?.toRequest ?? 0 })}
      </Button>
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      icon={<ArrowUpCircle size={16} className="text-accent" />}
      title={t('agentConfig.rollout.title', 'Update all outdated agents')}
      dismissible={!submitting}
      footer={footer}
    >
      {loadError ? (
        <p className="text-sm text-red-400">{t('agentConfig.rollout.loadFailed', 'Failed to load the rollout preview')}</p>
      ) : !p ? (
        <div className="flex items-center justify-center py-8"><RefreshCw size={18} className="animate-spin text-text-muted" /></div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-text-secondary">
            {t('agentConfig.rollout.summary', {
              defaultValue: '{{count}} outdated agent(s) will update to v{{version}}.',
              count: p.targets,
              version: p.latestVersion ?? '?',
            })}
            {p.allTenants && (
              <span className="ml-1 text-text-muted">{t('agentConfig.rollout.allTenants', '(every tenant: Default tenant)')}</span>
            )}
          </p>

          {result && prog && (
            <div className="space-y-2 rounded-lg border border-border bg-bg-secondary p-3">
              <p className="text-xs font-medium text-text-secondary">
                {t('agentConfig.rollout.progressTitle', { defaultValue: 'Rollout to v{{version}}', version: p.latestVersion ?? '?' })}
              </p>
              <div
                className="flex h-2 overflow-hidden rounded-full bg-bg-tertiary"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progTotal}
                aria-valuenow={prog.succeeded}
              >
                <div className="bg-green-500" style={{ width: pct(prog.succeeded) }} />
                <div className="bg-blue-500" style={{ width: pct(prog.inProgress + prog.offered) }} />
                <div className="bg-red-500" style={{ width: pct(prog.failed) }} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                <RolloutStat label={t('agentConfig.rollout.waiting', 'Waiting')} value={prog.waiting} />
                <RolloutStat label={t('agentConfig.rollout.offered', 'Offered')} value={prog.offered} tone="text-blue-400" />
                <RolloutStat label={t('agentConfig.rollout.inProgress', 'Updating')} value={prog.inProgress} tone="text-blue-400" />
                <RolloutStat label={t('agentConfig.rollout.succeeded', 'Succeeded')} value={prog.succeeded} tone="text-green-400" />
                <RolloutStat label={t('agentConfig.rollout.failed', 'Failed')} value={prog.failed} tone="text-red-400" />
              </div>
              <p className="text-[11px] text-text-muted">
                {t('agentConfig.rollout.windowUsage', {
                  defaultValue: '{{used}} of {{max}} offers used in the current {{seconds}} s window.',
                  used: p.rollout.offersInWindow,
                  max: p.rollout.maxPerWindow,
                  seconds: p.rollout.windowSeconds,
                })}
              </p>
            </div>
          )}

          {!result && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <RolloutStat label={t('agentConfig.rollout.toRequest', 'New requests')} value={p.toRequest} tone="text-accent" />
                <RolloutStat label={t('agentConfig.rollout.alreadyRequested', 'Already requested')} value={p.alreadyRequested} />
                <RolloutStat label={t('agentConfig.rollout.inFlight', 'Updating now')} value={p.inFlight} />
                <RolloutStat label={t('agentConfig.rollout.online', 'Online now')} value={p.online} tone="text-green-400" />
              </div>
              <p className="text-xs text-text-muted">
                {t('agentConfig.rollout.pace', {
                  defaultValue: 'Offers are paced at {{max}} per {{seconds}} s for the whole fleet: about {{minutes}} min for these agents. Offline agents update when they come back.',
                  max: p.rollout.maxPerWindow,
                  seconds: p.rollout.windowSeconds,
                  minutes: p.rollout.estimatedMinutes,
                })}
              </p>
              {p.auto > 0 && (
                <p className="text-xs text-text-muted">
                  {t('agentConfig.rollout.autoNote', { defaultValue: '{{count}} of them follow the Auto policy and update even without a request.', count: p.auto })}
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-3">
                {p.allTenants && (
                  <RolloutBreakdown
                    title={t('agentConfig.rollout.byTenant', 'By tenant')}
                    rows={p.byTenant.filter(x => x.targets > 0).map(x => ({ key: String(x.tenantId), label: x.tenantName ?? `#${x.tenantId}`, count: x.targets }))}
                  />
                )}
                <RolloutBreakdown
                  title={t('agentConfig.rollout.byGroup', 'By group')}
                  rows={p.byGroup.slice(0, 8).map(x => ({
                    key: `${x.tenantId}:${x.groupId ?? ''}`,
                    label: x.groupName ?? t('agentConfig.rollout.noGroup', 'No group'),
                    count: x.targets,
                  }))}
                />
                <RolloutBreakdown
                  title={t('agentConfig.rollout.byPlatform', 'By platform')}
                  rows={p.byPlatform.map(x => ({ key: x.platform, label: x.platform, count: x.targets }))}
                />
              </div>
            </>
          )}

          {p.frozen.total > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-400 space-y-2">
              <p className="flex items-center gap-1.5 font-medium">
                <Lock size={12} />
                {t('agentConfig.rollout.frozenTitle', { defaultValue: '{{count}} outdated agent(s) are frozen and will not update', count: p.frozen.total })}
              </p>
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-amber-400/90">
                {FROZEN_LEVELS.filter(l => p.frozen.byLevel[l] > 0).map(l => (
                  <span key={l}>{levelLabels[l]}: {p.frozen.byLevel[l]}</span>
                ))}
              </p>
              <ul className="max-h-40 overflow-y-auto space-y-0.5 text-amber-400/80">
                {p.frozen.agents.map(a => (
                  <li key={a.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{a.name ?? anonHostname(a.hostname)}</span>
                    <span className="shrink-0">{levelLabels[a.level]}{a.sourceGroupName ? ` (${a.sourceGroupName})` : ''}</span>
                  </li>
                ))}
              </ul>
              {p.frozen.truncated && (
                <p className="text-amber-400/70">{t('agentConfig.rollout.frozenTruncated', 'Only the first 200 are listed.')}</p>
              )}
            </div>
          )}

          {(p.noBuild > 0 || p.failed > 0 || p.unknownVersion > 0) && (
            <div className="space-y-0.5 text-xs text-text-muted">
              {p.noBuild > 0 && (
                <p>{t('agentConfig.rollout.noBuild', { defaultValue: '{{count}} agent(s) have no build of this version for their platform.', count: p.noBuild })}</p>
              )}
              {p.failed > 0 && (
                <p>{t('agentConfig.rollout.failedSkipped', { defaultValue: '{{count}} agent(s) failed to update to this version: retry them one by one.', count: p.failed })}</p>
              )}
              {p.unknownVersion > 0 && (
                <p>{t('agentConfig.rollout.unknownVersion', { defaultValue: '{{count}} agent(s) never reported a version.', count: p.unknownVersion })}</p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function AdminAgentPage() {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const prompt = usePrompt();
  const [searchParams] = useSearchParams();

  // Permission layer (W7-4): each surface follows its server capability.
  const canKeys = useCan('agents.keys');
  const canApprove = useCan('agents.approve');
  const canManageAgents = useCan('agents.manage');
  const canDelete = useCan('agents.delete');
  const canUpdate = useCan('agents.update');
  // Update POLICY writes are platform-admin only (owner directive C17).
  const isAdmin = useIsPlatformAdmin();

  const allowedTabs = useMemo<Tab[]>(() => (canKeys ? [...TABS] : TABS.filter(x => x !== 'keys')), [canKeys]);
  const [tab, setTab] = useTabParam<Tab>(allowedTabs, canKeys ? 'keys' : 'approvals');

  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [devices, setDevices] = useState<AgentDevice[]>([]);
  // Latest rows for socket handlers (known-device check without re-binding).
  const devicesRef = useRef<AgentDevice[]>([]);
  devicesRef.current = devices;
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dist, setDist] = useState<AgentVersionDistribution | null>(null);

  const { openAddAgentModal } = useUiStore();
  const [showAddMikroTik, setShowAddMikroTik] = useState(false);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<AgentKeyCreated | null>(null);
  const [approvingDevice, setApprovingDevice] = useState<AgentDevice | null>(null);
  const [busyKeyId, setBusyKeyId] = useState<number | null>(null);
  const [showRollout, setShowRollout] = useState(false);

  // ── Data ─────────────────────────────────────────────────────────────────────

  const loadKeys = useCallback(async () => {
    // GET /agent/keys needs agents.keys: the default 'user' set reaches this
    // page through agents.approve / agents.manage without it.
    if (!canKeys) { setKeys([]); return; }
    try {
      setKeys(await agentKeysApi.list());
    } catch {
      toast.error(t('agentConfig.keys.loadFailed', 'Failed to load the enrolment keys'));
    }
  }, [canKeys, t]);

  const loadDevices = useCallback(async () => {
    try {
      const [d, v] = await Promise.all([
        agentApi.listDevices(),
        agentApi.getVersionDistribution().catch(() => null),
      ]);
      setDevices(d);
      setDist(v);
    } catch {
      toast.error(t('agentConfig.loadFailed', 'Failed to load agent data'));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  const loadAll = useCallback(async () => {
    await Promise.all([loadKeys(), loadDevices()]);
  }, [loadKeys, loadDevices]);

  const loadGroups = useCallback(async () => {
    try {
      const tree = await groupsApi.tree();
      const flat: MonitorGroup[] = [];
      const flatten = (nodes: typeof tree) => {
        for (const n of nodes) {
          flat.push(n);
          flatten(n.children);
        }
      };
      flatten(tree);
      setGroups(flat);
    } catch {
      // ignore: the selectors only offer "No group"
    }
  }, []);

  useEffect(() => {
    void loadAll();
    void loadGroups();
  }, [loadAll, loadGroups]);

  // Live updates via Socket.io. Re-bound when the socket instance changes
  // (reconnect after a tenant switch / server disconnect).
  const socketGeneration = useSocketStore(st => st.generation);
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    // Coalesce reloads asked by a burst of events (bulk ops emit one per row).
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadTimer = null; void loadAll(); }, 500);
    };

    // {deviceId, patch} (or a legacy shape) merged into the row. An unknown
    // device, or a payload without any field, re-reads the list.
    const onDeviceUpdated = (data: unknown) => {
      const p = toDevicePatch(data);
      if (!p) return;
      const fields = Object.fromEntries(
        Object.entries(p.patch).filter(([k, v]) => v !== undefined && k !== 'id'),
      ) as Partial<AgentDevice>;
      if (!devicesRef.current.some(d => d.id === p.deviceId) || Object.keys(fields).length === 0) {
        scheduleReload();
        return;
      }
      setDevices(prev => prev.map(d => (d.id === p.deviceId ? { ...d, ...fields } : d)));
    };
    // A new agent registered (pending approval): also refreshes the key counters.
    const onDeviceCreated = () => { scheduleReload(); };
    const onDeviceDeleted = (data: { deviceId: number }) => {
      setDevices(prev => prev.filter(d => d.id !== data.deviceId));
    };
    const onAgentStatusChanged = (data: { deviceId: number; wsConnected?: boolean }) => {
      if (data.wsConnected === undefined) return;
      const ws = data.wsConnected;
      setDevices(prev => prev.map(d => (d.id === data.deviceId && d.wsConnected !== ws ? { ...d, wsConnected: ws } : d)));
    };
    // Socket reconnected: events emitted meanwhile are lost — reload.
    const onResync = () => { scheduleReload(); };

    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
    socket.on(AGENT_DEVICE_CREATED, onDeviceCreated);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onAgentStatusChanged);
    window.addEventListener(SOCKET_RESYNC_EVENT, onResync);
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
      socket.off(AGENT_DEVICE_CREATED, onDeviceCreated);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onAgentStatusChanged);
      window.removeEventListener(SOCKET_RESYNC_EVENT, onResync);
    };
  }, [socketGeneration, loadAll]);

  // Default-tenant god view: other tenants' agents are listed read-only (the
  // server refuses writes on them with 403 — switch tenant to change them).
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  const currentTenantName = useTenantStore(s => s.tenants.find(tn => tn.id === s.currentTenantId)?.name ?? null);
  const isForeign = useCallback(
    (tid: number | null | undefined) => currentTenantId != null && tid != null && tid !== currentTenantId,
    [currentTenantId],
  );

  /** Agent groups of the operating tenant, tree order with depth (selectors). */
  const ownAgentGroups = useMemo<FlatGroup[]>(() => {
    const own = groups.filter(g => g.kind === 'agent' && !isForeign(g.tenantId));
    const byParent = new Map<number | null, MonitorGroup[]>();
    const ids = new Set(own.map(g => g.id));
    for (const g of own) {
      const parent = g.parentId != null && ids.has(g.parentId) ? g.parentId : null;
      byParent.set(parent, [...(byParent.get(parent) ?? []), g]);
    }
    const out: FlatGroup[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const g of byParent.get(parent) ?? []) {
        out.push({ id: g.id, name: g.name, depth, group: g });
        walk(g.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [groups, isForeign]);
  const groupName = useCallback((id: number | null | undefined) => (id == null ? null : groups.find(g => g.id === id)?.name ?? null), [groups]);
  const keyById = useMemo(() => new Map(keys.map(k => [k.id, k])), [keys]);

  const pendingDevices = useMemo(() => devices.filter(d => d.status === 'pending'), [devices]);
  const refusedDevices = useMemo(() => devices.filter(d => d.status === 'refused'), [devices]);
  const pendingCount = pendingDevices.filter(d => !isForeign(d.tenantId)).length;

  /** Approved agents with something to act on: update available / requested / failed. */
  const attentionDevices = useMemo(() => devices.filter(d =>
    d.status === 'approved' && d.deviceType === 'agent'
    && (d.updateAvailable || d.updatePending || isUpdateFailed(visibleUpdateAttempt(d)) || isUpdateInFlight(visibleUpdateAttempt(d)))),
  [devices]);

  // ── Legacy URLs: the fleet list moved to /agents ─────────────────────────────
  const rawTab = searchParams.get('tab');
  const rawStatus = searchParams.get('status');
  if (rawTab === 'devices' || (rawStatus && rawStatus !== 'pending')) {
    return <Navigate to={rawStatus && rawStatus !== 'pending' ? `/agents?status=${encodeURIComponent(rawStatus)}` : '/agents'} replace />;
  }
  if (rawStatus === 'pending') {
    return <Navigate to="/manage/agents?tab=approvals" replace />;
  }

  // ── Key actions ──────────────────────────────────────────────────────────────

  const patchKey = async (key: AgentKey, patch: Parameters<typeof agentKeysApi.update>[1], okMsg: string) => {
    setBusyKeyId(key.id);
    try {
      const updated = await agentKeysApi.update(key.id, patch);
      setKeys(prev => prev.map(k => (k.id === key.id ? { ...k, ...updated } : k)));
      toast.success(okMsg);
      return updated;
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentConfig.keys.saveFailed', 'Failed to save the key')));
      return null;
    } finally {
      setBusyKeyId(null);
    }
  };

  const handleToggleKey = async (key: AgentKey, active: boolean) => {
    if (!active && !(await askConfirm({
      title: t('agentConfig.keys.disableTitle', 'Disable this key?'),
      message: t('agentConfig.keys.disableConfirm', {
        defaultValue: 'Agents connected with "{{name}}" are disconnected now and refused until the key is re-enabled. Its {{count}} device(s) keep their binding, group and history.',
        name: key.name,
        count: key.deviceCount,
      }),
      danger: true,
      confirmLabel: t('agentConfig.keys.disable', 'Disable'),
    }))) return;
    const r = await patchKey(key, { isActive: active }, active
      ? t('agentConfig.keys.enabledToast', 'Key re-enabled')
      : t('agentConfig.keys.disabledToast', 'Key disabled'));
    if (r && !active && r.closedSessions > 0) {
      toast(t('agentConfig.keys.sessionsClosed', { defaultValue: '{{count}} live session(s) closed', count: r.closedSessions }));
    }
  };

  const handleRenameKey = async (key: AgentKey) => {
    const name = await prompt({
      title: t('agentConfig.keys.renameTitle', 'Rename key'),
      defaultValue: key.name,
      required: true,
    });
    if (name === null || !name.trim() || name.trim() === key.name) return;
    await patchKey(key, { name: name.trim() }, t('agentConfig.keys.renamedToast', 'Key renamed'));
  };

  const handleKeyGroup = async (key: AgentKey, groupId: number | null) => {
    if (groupId === key.defaultGroupId) return;
    await patchKey(key, { defaultGroupId: groupId }, t('agentConfig.keys.groupSavedToast', 'Default group saved'));
  };

  const handleDeleteKey = async (key: AgentKey) => {
    if (!(await askConfirm({
      title: t('agentConfig.keys.deleteTitle', 'Delete this key?'),
      message: t('agentConfig.keys.deleteConfirm', {
        defaultValue: 'Deleting "{{name}}" disconnects its agents and releases the binding of its {{count}} device(s): the next key of this tenant that connects claims them. To stop a leaked key while keeping its devices, disable it instead.',
        name: key.name,
        count: key.deviceCount,
      }),
      danger: true,
      requireText: key.deviceCount > 0 ? key.name : undefined,
    }))) return;
    try {
      await agentKeysApi.remove(key.id);
      toast.success(t('agentConfig.keys.deletedToast', 'Key deleted'));
      void loadKeys();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentConfig.keys.deleteFailed', 'Failed to delete the key')));
    }
  };

  // ── Approval actions ─────────────────────────────────────────────────────────

  /** Registration group of the device, else its key's default group. */
  const approvalGroupOf = (device: AgentDevice): number | null =>
    device.groupId ?? (device.apiKeyId != null ? keyById.get(device.apiKeyId)?.defaultGroupId ?? null : null);

  const handleApprove = async (groupId: number | null | undefined) => {
    if (!approvingDevice) return;
    try {
      // No groupId without agents.manage: the server keeps the registration
      // group (or the key's default group) instead of answering 403.
      await agentApi.updateDevice(approvingDevice.id, groupId === undefined ? { status: 'approved' } : { status: 'approved', groupId });
      toast.success(t('agentConfig.approvals.approvedToast', {
        defaultValue: '{{name}} approved',
        name: anonHostname(approvingDevice.name ?? approvingDevice.hostname),
      }));
      setApprovingDevice(null);
      void loadAll();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentConfig.approvals.approveFailed', 'Failed to approve the agent')));
    }
  };

  const handleRefuse = async (device: AgentDevice) => {
    if (!(await askConfirm({
      title: t('agentConfig.approvals.refuseTitle', 'Refuse this agent?'),
      message: t('agentConfig.approvals.refuseConfirm', {
        defaultValue: '{{name}} is refused: it enters backoff mode and gets no configuration. You can reinstate it later.',
        name: anonHostname(device.hostname),
      }),
      danger: true,
      confirmLabel: t('agentConfig.approvals.refuse', 'Refuse'),
    }))) return;
    try {
      await agentApi.updateDevice(device.id, { status: 'refused' });
      toast.success(t('agentConfig.approvals.refusedToast', 'Agent refused'));
      void loadAll();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentConfig.approvals.refuseFailed', 'Failed to refuse the agent')));
    }
  };

  const handleReinstate = async (device: AgentDevice) => {
    try {
      await agentApi.updateDevice(device.id, { status: 'pending' });
      toast.success(t('agentConfig.approvals.reinstatedToast', 'Agent back to pending'));
      void loadAll();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentConfig.approvals.reinstateFailed', 'Failed to reinstate the agent')));
    }
  };

  const handleDeleteDevice = async (device: AgentDevice) => {
    if (!(await askConfirm({
      message: t('agentConfig.approvals.deleteConfirm', {
        defaultValue: 'Delete {{name}}? Its entry and history are removed; a still-installed agent enrols again as pending.',
        name: anonHostname(device.hostname),
      }),
      danger: true,
    }))) return;
    try {
      await agentApi.deleteDevice(device.id);
      toast.success(t('agentConfig.approvals.deletedToast', 'Agent deleted'));
      void loadAll();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentConfig.approvals.deleteFailed', 'Failed to delete the agent')));
    }
  };

  // ── Agent updates (C17-1) ────────────────────────────────────────────────────

  const handleRequestUpdate = async (device: AgentDevice) => {
    if (!(await askConfirm({
      message: t('agentUpdate.confirmUpdate', {
        defaultValue: 'Update {{name}} to v{{version}}?',
        name: device.name ?? device.hostname,
        version: device.latestAgentVersion,
      }),
      confirmLabel: t('agentUpdate.updateNow', 'Update now'),
    }))) return;
    try {
      await agentApi.requestUpdate(device.id);
      toast.success(t('agentUpdate.requestedToast', 'Update requested: the agent updates at its next heartbeat'));
      void loadDevices();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentUpdate.requestFailed', 'Failed to request the update')));
    }
  };

  const handleCancelUpdate = async (device: AgentDevice) => {
    try {
      await agentApi.cancelUpdate(device.id);
      void loadDevices();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentUpdate.cancelFailed', 'Failed to cancel the update')));
    }
  };

  /** Retry from the update badge: merge the refreshed row, refresh the fleet counters. */
  const handleRetried = (updated: AgentDevice) => {
    setDevices(prev => prev.map(d => (d.id === updated.id ? { ...d, ...updated } : d)));
    agentApi.getVersionDistribution().then(setDist).catch(() => {});
  };

  /** "Cancel all pending" (W12-4): every pending request of the scope (Default: every tenant). */
  const handleCancelAllUpdates = async () => {
    if (!(await askConfirm({
      message: t('agentConfig.rollout.cancelAllConfirm', 'Cancel every pending agent update request? Agents already installing finish; agents under the Auto policy keep updating.'),
      danger: true,
      confirmLabel: t('agentConfig.rollout.cancelAll', 'Cancel all pending'),
    }))) return;
    try {
      const r = await agentApi.cancelAllUpdates();
      toast.success(t('agentConfig.rollout.cancelledToast', { defaultValue: '{{count}} pending update(s) cancelled', count: r.cancelled }));
      if (r.autoContinuing > 0) {
        toast(t('agentConfig.rollout.autoContinuing', {
          defaultValue: '{{count}} outdated agent(s) follow the Auto policy and keep updating: set their policy to Manual or Off to stop them.',
          count: r.autoContinuing,
        }));
      }
      void loadDevices();
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentConfig.rollout.cancelFailed', 'Failed to cancel the pending updates')));
    }
  };

  // ── Render helpers ───────────────────────────────────────────────────────────

  const th = 'px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide whitespace-nowrap';
  const td = 'px-4 py-3 align-top';

  const deviceName = (device: AgentDevice) => (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 flex-wrap">
        {device.status === 'approved' ? (
          <Link to={`/agents/${device.id}`} className="font-medium text-text-primary hover:text-accent transition-colors">
            {anonHostname(device.name ?? device.hostname)}
          </Link>
        ) : (
          <span className="font-medium text-text-primary">{anonHostname(device.name ?? device.hostname)}</span>
        )}
        <TenantBadge tenantId={device.tenantId} />
      </div>
      {device.name && <div className="text-[10px] text-text-muted mt-0.5">{anonHostname(device.hostname)}</div>}
      <div className="text-[10px] text-text-muted font-mono mt-0.5">{device.uuid.slice(0, 12)}…</div>
    </div>
  );

  const osText = (device: AgentDevice) => (device.osInfo
    ? `${device.osInfo.distro ?? device.osInfo.platform} ${device.osInfo.release ?? ''}`
    : '—');

  const keyLabel = (device: AgentDevice) => {
    if (device.apiKeyId == null) return <span className="text-text-muted">—</span>;
    const k = keyById.get(device.apiKeyId);
    if (!k) return <span className="text-text-muted">#{device.apiKeyId}</span>;
    return (
      <span className={k.isActive ? 'text-text-secondary' : 'text-text-muted line-through'}>{k.name}</span>
    );
  };

  // ── Tabs ─────────────────────────────────────────────────────────────────────

  const keysTab = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-text-muted max-w-3xl">
          {t('agentConfig.keys.description', 'Enrolment keys authenticate agents. Disable a leaked key to cut its agents off at once without losing its devices; give a key a default group so new agents land in the right place.')}
        </p>
        <Button size="sm" onClick={() => setShowCreateKey(true)}>
          <Plus size={13} className="mr-1" />{t('agentConfig.keys.new', 'New key')}
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        {keys.length === 0 ? (
          <EmptyState
            icon={<Key size={28} />}
            title={t('agentConfig.keys.empty', 'No enrolment key yet')}
            description={t('agentConfig.keys.emptyDesc', 'Create a key, then use Add Agent to get the install command.')}
          />
        ) : (
          <TableScroll>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-tertiary">
                  <th className={th}>{t('agentConfig.keys.name', 'Name')}</th>
                  <th className={th}>{t('agentConfig.keys.key', 'Key')}</th>
                  <th className={th}>{t('agentConfig.keys.enabled', 'Enabled')}</th>
                  <th className={th}>{t('agentConfig.keys.defaultGroup', 'Default group')}</th>
                  <th className={th}>{t('agentConfig.keys.devices', 'Devices')}</th>
                  <th className={th}>{t('agentConfig.keys.usage', 'Created / last used')}</th>
                  <th className={`${th} text-right`}>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {keys.map(key => {
                  const busy = busyKeyId === key.id;
                  return (
                    <tr key={key.id} className={key.isActive ? '' : 'bg-bg-tertiary/40'}>
                      <td className={td}>
                        <div className="flex items-center gap-2">
                          <Key size={14} className={key.isActive ? 'text-accent shrink-0' : 'text-text-muted shrink-0'} />
                          <span className="font-medium text-text-primary break-all">{key.name}</span>
                        </div>
                        {!key.isActive && key.revokedAt && (
                          <div className="text-[11px] text-status-down mt-0.5">
                            {t('agentConfig.keys.disabledSince', { defaultValue: 'Disabled {{date}}', date: formatDate(key.revokedAt) })}
                          </div>
                        )}
                      </td>
                      <td className={td}>
                        <code className="text-xs font-mono text-text-muted whitespace-nowrap">{key.keyMasked}</code>
                      </td>
                      <td className={td}>
                        <ToggleSwitch
                          checked={key.isActive}
                          onChange={v => void handleToggleKey(key, v)}
                          disabled={busy}
                          size="sm"
                          ariaLabel={key.isActive
                            ? t('agentConfig.keys.disableAria', { defaultValue: 'Disable {{name}}', name: key.name })
                            : t('agentConfig.keys.enableAria', { defaultValue: 'Enable {{name}}', name: key.name })}
                        />
                      </td>
                      <td className={td}>
                        <GroupSelect
                          value={key.defaultGroupId}
                          onChange={id => void handleKeyGroup(key, id)}
                          groups={ownAgentGroups}
                          disabled={busy}
                          ariaLabel={t('agentConfig.keys.defaultGroupOf', { defaultValue: 'Default group of {{name}}', name: key.name })}
                          className="max-w-[14rem] rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 coarse:min-h-10"
                        />
                        {/* A default group of a group list that is not loaded (or of a
                            non-agent kind) is still shown by name. */}
                        {key.defaultGroupId != null && !ownAgentGroups.some(g => g.id === key.defaultGroupId) && key.defaultGroupName && (
                          <div className="text-[11px] text-text-muted mt-0.5">{key.defaultGroupName}</div>
                        )}
                      </td>
                      <td className={`${td} text-text-muted whitespace-nowrap`}>
                        {t('agentConfig.keys.deviceCount', { defaultValue: '{{count}} device(s)', count: key.deviceCount })}
                        {key.pendingCount > 0 && (
                          <button
                            type="button"
                            onClick={() => setTab('approvals')}
                            className="block text-xs text-yellow-400 hover:underline coarse:min-h-10"
                          >
                            {t('agentConfig.keys.pendingCount', { defaultValue: '{{count}} pending', count: key.pendingCount })}
                          </button>
                        )}
                      </td>
                      <td className={`${td} text-xs text-text-muted whitespace-nowrap`}>
                        <div>{formatDate(key.createdAt)}</div>
                        <div>
                          {key.lastUsedAt
                            ? t('agentConfig.keys.lastUsed', { defaultValue: 'Last used {{date}}', date: formatDate(key.lastUsedAt) })
                            : t('agentConfig.keys.neverUsed', 'Never used')}
                        </div>
                      </td>
                      <td className={`${td} text-right`}>
                        <div className="flex items-center justify-end gap-1">
                          <IconButton
                            label={t('agentConfig.keys.rename', 'Rename')}
                            icon={<Pencil size={13} />}
                            onClick={() => void handleRenameKey(key)}
                            disabled={busy}
                          />
                          <IconButton
                            label={t('common.delete')}
                            icon={<Trash2 size={13} />}
                            variant="danger"
                            onClick={() => void handleDeleteKey(key)}
                            disabled={busy}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>
    </div>
  );

  const approvalsTab = (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        {pendingDevices.length === 0 ? (
          <EmptyState
            icon={<Cpu size={28} />}
            title={t('agentConfig.approvals.empty', 'No agent waiting for approval')}
            description={t('agentConfig.approvals.emptyDesc', 'New agents appear here after their first connection. Use Add Agent to get the install command.')}
          />
        ) : (
          <TableScroll>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-tertiary">
                  <th className={th}>{t('agentConfig.approvals.agent', 'Agent')}</th>
                  <th className={th}>IP</th>
                  <th className={th}>OS</th>
                  <th className={th}>{t('common.agent')}</th>
                  {canKeys && <th className={th}>{t('agentConfig.approvals.key', 'Key')}</th>}
                  <th className={th}>{t('agentConfig.approvals.targetGroup', 'Target group')}</th>
                  <th className={th}>{t('agents.update.lastSeen', 'Last seen')}</th>
                  <th className={th}>{t('agentConfig.approvals.registered', 'Registered')}</th>
                  <th className={`${th} text-right`}>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pendingDevices.map(device => {
                  const foreign = isForeign(device.tenantId);
                  const target = approvalGroupOf(device);
                  return (
                    <tr key={device.id} className="hover:bg-bg-hover transition-colors">
                      <td className={td}>{deviceName(device)}</td>
                      <td className={`${td} text-text-muted`}>{anonIp(device.ip)}</td>
                      <td className={`${td} text-text-muted`}>{osText(device)}</td>
                      <td className={`${td} text-text-muted`}>{device.agentVersion ?? '—'}</td>
                      {canKeys && <td className={td}>{keyLabel(device)}</td>}
                      <td className={`${td} text-text-muted`}>
                        {target != null
                          ? <span className="inline-flex items-center gap-1"><FolderOpen size={12} />{groupName(target) ?? `#${target}`}</span>
                          : '—'}
                      </td>
                      <td className={td}>
                        {!device.lastSeenAt
                          ? <span className="text-text-muted text-xs">—</span>
                          : <LastSeenPill lastSeenAt={device.lastSeenAt} />}
                      </td>
                      <td className={`${td} text-text-muted text-xs whitespace-nowrap`}>{formatDate(device.createdAt)}</td>
                      <td className={`${td} text-right`}>
                        {foreign ? (
                          <span className="text-[11px] text-text-muted">{t('agents.foreignReadOnlyShort', 'Read-only (other tenant)')}</span>
                        ) : (
                          <Can cap="agents.approve">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button size="sm" onClick={() => setApprovingDevice(device)}>
                                <CheckCircle size={12} className="mr-1" />{t('agents.approve')}
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => void handleRefuse(device)}>
                                <XCircle size={12} className="mr-1" />{t('agentConfig.approvals.refuse', 'Refuse')}
                              </Button>
                            </div>
                          </Can>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>

      {refusedDevices.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-text-secondary">
            {t('agentConfig.approvals.refusedTitle', { defaultValue: 'Refused ({{count}})', count: refusedDevices.length })}
          </h2>
          <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
            <TableScroll>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-bg-tertiary">
                    <th className={th}>{t('agentConfig.approvals.agent', 'Agent')}</th>
                    <th className={th}>IP</th>
                    {canKeys && <th className={th}>{t('agentConfig.approvals.key', 'Key')}</th>}
                    <th className={th}>{t('agents.update.lastSeen', 'Last seen')}</th>
                    <th className={`${th} text-right`}>{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {refusedDevices.map(device => (
                    <tr key={device.id}>
                      <td className={td}>{deviceName(device)}</td>
                      <td className={`${td} text-text-muted`}>{anonIp(device.ip)}</td>
                      {canKeys && <td className={td}>{keyLabel(device)}</td>}
                      <td className={td}>
                        {!device.lastSeenAt
                          ? <span className="text-text-muted text-xs">—</span>
                          : <LastSeenPill lastSeenAt={device.lastSeenAt} />}
                      </td>
                      <td className={`${td} text-right`}>
                        {isForeign(device.tenantId) ? (
                          <span className="text-[11px] text-text-muted">{t('agents.foreignReadOnlyShort', 'Read-only (other tenant)')}</span>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            {canApprove && (
                              <Button size="sm" variant="secondary" onClick={() => void handleReinstate(device)}>
                                <RotateCcw size={12} className="mr-1" />{t('agentConfig.approvals.reinstate', 'Reinstate')}
                              </Button>
                            )}
                            {canDelete && (
                              <IconButton
                                label={t('common.delete')}
                                icon={<Trash2 size={13} />}
                                variant="danger"
                                onClick={() => void handleDeleteDevice(device)}
                              />
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </div>
        </section>
      )}
    </div>
  );

  const policyTab = (
    <div className="space-y-4">
      <AgentUpdatePolicyBar
        isAdmin={isAdmin}
        tenantId={currentTenantId}
        tenantName={currentTenantName}
        onChanged={() => { void loadDevices(); }}
      />
      {dist && <MissingBuildsBanner builds={dist.missingBuilds ?? []} version={dist.latestVersion} />}
      {dist && dist.total > 0 && <AgentVersionStrip dist={dist} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-secondary">
          {t('agentConfig.policy.attentionTitle', 'Agents with an update to handle')}
        </h2>
        {canUpdate && dist && (
          <div className="flex flex-wrap items-center gap-2">
            {dist.updatePending > 0 && (
              <Button size="sm" variant="ghost" onClick={() => void handleCancelAllUpdates()}>
                <Ban size={12} className="mr-1.5" />
                {t('agentConfig.rollout.cancelAll', 'Cancel all pending')}
              </Button>
            )}
            {dist.outdated > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setShowRollout(true)}>
                <ArrowUpCircle size={12} className="mr-1.5" />
                {t('agentConfig.rollout.updateAll', 'Update all outdated')}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        {attentionDevices.length === 0 ? (
          <EmptyState
            compact
            icon={<CheckCircle size={24} />}
            title={t('agentConfig.policy.allCurrent', 'Every agent is up to date')}
          />
        ) : (
          <TableScroll>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-tertiary">
                  <th className={th}>{t('agentConfig.approvals.agent', 'Agent')}</th>
                  <th className={th}>{t('common.agent')}</th>
                  <th className={th}>{t('agentUpdate.policyLabel', 'Agent updates')}</th>
                  <th className={th}>{t('agents.update.lastSeen', 'Last seen')}</th>
                  <th className={`${th} text-right`}>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {attentionDevices.map(device => {
                  const foreign = isForeign(device.tenantId);
                  const attempt = visibleUpdateAttempt(device);
                  return (
                    <tr key={device.id} className="hover:bg-bg-hover transition-colors">
                      <td className={td}>{deviceName(device)}</td>
                      <td className={`${td} text-text-muted`}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>{device.agentVersion ?? '—'}</span>
                          <UpdateStatusBadge
                            device={device}
                            size="sm"
                            canRetry={canUpdate && !foreign && device.status === 'approved' && device.resolvedUpdatePolicy !== 'off'}
                            onRetried={handleRetried}
                          />
                          {device.updateAvailable && device.latestAgentVersion && !attempt && (
                            <span
                              className="rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-400"
                              title={t('agentUpdate.updateAvailableShort', 'Update available')}
                            >
                              ↑ v{device.latestAgentVersion}
                            </span>
                          )}
                          {device.updatePending && !isUpdateInFlight(attempt) && (
                            <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-400">
                              {t('agentUpdate.updateRequested', { defaultValue: 'Update to v{{version}} requested', version: device.updateRequestedVersion })}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={`${td} text-xs`}>
                        {device.resolvedUpdatePolicy ? (
                          <div className="flex flex-col gap-0.5">
                            <span className={device.resolvedUpdatePolicy === 'off' ? 'inline-flex items-center gap-1 text-amber-400' : 'text-text-primary'}>
                              {device.resolvedUpdatePolicy === 'off' && <Lock size={10} />}
                              {t(`agentUpdate.policy.${device.resolvedUpdatePolicy}`, device.resolvedUpdatePolicy)}
                            </span>
                            {device.updatePolicySource && (
                              <span className="text-text-muted">
                                {updatePolicySourceLabel(device.updatePolicySource, t, {
                                  tenantName: currentTenantName,
                                  groupName: groupName(device.updatePolicySourceGroupId),
                                })}
                              </span>
                            )}
                          </div>
                        ) : <span className="text-text-muted">—</span>}
                      </td>
                      <td className={td}>
                        <LastSeenPill lastSeenAt={device.lastSeenAt} />
                      </td>
                      <td className={`${td} text-right`}>
                        {!foreign && canUpdate && (
                          <div className="flex items-center justify-end gap-1">
                            {device.updatePending && (
                              <IconButton
                                label={t('agentUpdate.cancelRequest', 'Cancel')}
                                icon={<X size={13} />}
                                onClick={() => void handleCancelUpdate(device)}
                              />
                            )}
                            {!device.updatePending && device.updateAvailable && device.resolvedUpdatePolicy !== 'off'
                              && !isUpdateFailed(attempt) && (
                              <IconButton
                                label={t('agentUpdate.updateNow', 'Update now')}
                                icon={<ArrowUpCircle size={13} />}
                                variant="accent"
                                onClick={() => void handleRequestUpdate(device)}
                              />
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>
    </div>
  );

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        icon={<Cpu size={20} />}
        title={t('agentConfig.title', 'Agent config')}
        description={t('agentConfig.subtitle', 'Enrolment keys, pending approvals and the agent update policy. The fleet itself is on the Agents page.')}
        badge={pendingCount > 0 ? (
          <span className="rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs font-medium text-yellow-400">
            {t('agentConfig.pendingBadge', { defaultValue: '{{count}} pending', count: pendingCount })}
          </span>
        ) : undefined}
        actions={(
          <>
            <Link
              to="/agents"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors coarse:min-h-10"
            >
              <List size={14} />{t('agentConfig.fleetLink', 'Agent list')}
            </Link>
            <IconButton
              label={t('common.refresh', 'Refresh')}
              icon={<RefreshCw size={14} />}
              onClick={() => { void loadAll(); void loadGroups(); }}
              size="lg"
            />
            <Can cap="integrations.mikrotik">
              <Button variant="secondary" onClick={() => setShowAddMikroTik(true)}>
                <Router size={14} className="mr-1.5" />{t('agentConfig.addMikrotik', 'Add MikroTik')}
              </Button>
            </Can>
            <Can cap="agents.keys">
              <Button onClick={openAddAgentModal}>
                <Plus size={14} className="mr-1.5" />{t('addAgent.title', 'Add Agent')}
              </Button>
            </Can>
          </>
        )}
      />

      <SegmentedTabs<Tab>
        value={tab}
        onChange={setTab}
        fill={false}
        ariaLabel={t('agentConfig.title', 'Agent config')}
        tabs={[
          { id: 'keys', label: t('agentConfig.tabs.keys', 'Enrolment keys'), icon: <Key size={13} />, hidden: !canKeys },
          {
            id: 'approvals',
            label: t('agentConfig.tabs.approvals', 'Pending approvals'),
            icon: <CheckCircle size={13} />,
            badge: pendingCount > 0 ? (
              <span className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-yellow-500 text-white text-[10px] font-bold">
                {pendingCount}
              </span>
            ) : undefined,
          },
          { id: 'policy', label: t('agentConfig.tabs.policy', 'Update policy'), icon: <ArrowUpCircle size={13} /> },
        ]}
      />

      {!loaded ? (
        <div className="flex items-center justify-center py-10">
          <RefreshCw size={18} className="animate-spin text-text-muted" />
        </div>
      ) : tab === 'keys' && canKeys ? keysTab : tab === 'approvals' ? approvalsTab : policyTab}

      {/* Modals */}
      {approvingDevice && (
        <ApproveModal
          device={approvingDevice}
          groups={ownAgentGroups}
          initialGroupId={approvalGroupOf(approvingDevice)}
          canPickGroup={canManageAgents}
          onApprove={handleApprove}
          onCancel={() => setApprovingDevice(null)}
        />
      )}

      {showCreateKey && (
        <CreateKeyModal
          groups={ownAgentGroups}
          onCancel={() => setShowCreateKey(false)}
          onCreated={(k) => {
            setShowCreateKey(false);
            setCreatedKey(k);
            void loadKeys();
          }}
        />
      )}

      {createdKey && <NewKeyModal created={createdKey} onClose={() => setCreatedKey(null)} />}

      {showRollout && (
        <UpdateRolloutModal
          onClose={() => { setShowRollout(false); void loadDevices(); }}
          onDone={() => { void loadDevices(); }}
        />
      )}

      <AddMikroTikModal
        open={showAddMikroTik}
        onClose={() => setShowAddMikroTik(false)}
        onCreated={() => { void loadAll(); toast.success(t('agentConfig.mikrotikCreated', 'MikroTik device created')); }}
      />
    </PageContainer>
  );
}
