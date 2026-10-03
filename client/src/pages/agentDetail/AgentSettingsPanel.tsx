import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { AgentDevice, AgentUpdatePolicy } from '@obliview/shared';
import { agentApi } from '@/api/agent.api';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useGroupStore } from '@/store/groupStore';
import { useTenantStore } from '@/store/tenantStore';
import { findGroupInTree, updatePolicySourceLabel } from '@/utils/agentUpdate';

// ── AgentSettingsPanel ────────────────────────────────────────────────────────

const overrideBtn = 'text-[10px] text-accent border border-accent/40 rounded px-1.5 py-0.5 hover:bg-accent/10 transition-colors disabled:opacity-50 coarse:min-h-8 coarse:px-2.5';
const resetBtn = 'text-[10px] text-text-muted hover:text-status-down border border-border rounded px-1.5 py-0.5 transition-colors disabled:opacity-50 coarse:min-h-8 coarse:px-2.5';

/**
 * Agent-level settings: heartbeat interval and missed pushes (override or
 * inherit), WAN matching, evaluate-only and the agent update policy.
 *
 * The update policy follows the owner model (C17): auto | manual | off at
 * GLOBAL → TENANT → GROUP → AGENT; 'off' at any level above freezes this
 * selector; the source of the effective value is always shown. Policy writes
 * are platform-admin only (canEditUpdatePolicy).
 */
export function AgentSettingsPanel({
  device,
  onUpdate,
  readOnly = false,
  canEditUpdatePolicy = false,
}: {
  device: AgentDevice;
  onUpdate: (d: AgentDevice) => void;
  /** Another tenant's agent, a read-only grant or no agents.manage: every control is disabled. */
  readOnly?: boolean;
  /** Platform admin, on an own-tenant Go agent (owner directive C17). */
  canEditUpdatePolicy?: boolean;
}) {
  const { t } = useTranslation();
  // Per-param override detection
  const cisOverridden  = device.overrideGroupSettings ?? false;
  const mmpOverridden  = device.maxMissedPushes !== null;

  // Effective (resolved) values — inherited value shown in grey when not overriding
  const resolvedCIS = device.resolvedSettings?.checkIntervalSeconds ?? 60;
  const resolvedMMP = device.resolvedSettings?.maxMissedPushes ?? 2;

  const [checkInterval,  setCheckInterval]  = useState(String(device.checkIntervalSeconds ?? 60));
  const [maxMissed,      setMaxMissed]      = useState(String(device.maxMissedPushes ?? resolvedMMP));
  const [wanMatching,    setWanMatching]    = useState(device.wanMatchingEnabled ?? false);
  // evaluate-only: device-LEVEL flag. source==='agent' means the own flag is set;
  // source==='group' means it's inherited (own flag is off — checked first in resolution).
  const [evalOnly,       setEvalOnly]       = useState(device.evaluateOnlySource === 'agent');
  const [saving,         setSaving]         = useState(false);
  const evalInherited = device.evaluateOnlySource === 'group';

  useEffect(() => {
    setCheckInterval(String(device.checkIntervalSeconds ?? 60));
    setMaxMissed(String(device.maxMissedPushes ?? (device.resolvedSettings?.maxMissedPushes ?? 2)));
    setWanMatching(device.wanMatchingEnabled ?? false);
    setEvalOnly(device.evaluateOnlySource === 'agent');
  }, [device]);

  async function save(updates: Parameters<typeof agentApi.updateDevice>[1]) {
    setSaving(true);
    try {
      const updated = await agentApi.updateDevice(device.id, updates);
      onUpdate(updated);
    } catch (err) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('agentUpdate.saveFailed', 'Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  // Update policy (C17-1): frozen from above ('off' at group / tenant / global level) cannot be lifted here.
  const resolvedPolicy = device.resolvedUpdatePolicy ?? 'manual';
  const policySource = device.updatePolicySource ?? 'default';
  const frozenFromAbove = resolvedPolicy === 'off' && policySource !== 'agent';
  // Source names: the device's tenant (tenant level) or the group that sets the value.
  const policyTenantName = useTenantStore(s => s.tenants.find(tn => tn.id === device.tenantId)?.name ?? null);
  const policyGroupName = useGroupStore(s =>
    device.updatePolicySourceGroupId != null ? (findGroupInTree(s.tree, device.updatePolicySourceGroupId)?.name ?? null) : null);
  const policySourceText = updatePolicySourceLabel(policySource, t, { tenantName: policyTenantName, groupName: policyGroupName });
  const policySelectDisabled = saving || !canEditUpdatePolicy || frozenFromAbove;

  const inputCls = (on: boolean) =>
    `rounded border border-border px-2 py-1 text-xs focus:outline-none focus:border-accent coarse:min-h-9 ${
      on ? 'bg-bg-tertiary text-text-primary' : 'bg-bg-tertiary text-text-muted cursor-default'
    }`;

  return (
    <fieldset disabled={readOnly} className="min-w-0 border-0 p-0 m-0">
      <div className="rounded-lg border border-border bg-bg-secondary">
        <div className="px-4 py-3 border-b border-border flex items-center gap-3">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            {t('agentDetail.settings.title', { defaultValue: 'Agent settings' })}
          </h2>
          {saving && <span className="ml-auto text-[11px] text-text-muted animate-pulse">{t('common.saving', { defaultValue: 'Saving…' })}</span>}
        </div>
        <div className="px-4 py-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">

          {/* ── Check interval ──────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <label htmlFor="agent-cis" className="min-w-[9rem]">{t('agentDetail.settings.checkEvery', { defaultValue: 'Check every' })}</label>
            <input
              id="agent-cis"
              type="number"
              min={10}
              value={cisOverridden ? checkInterval : resolvedCIS}
              onChange={e => { if (cisOverridden) setCheckInterval(e.target.value); }}
              onBlur={() => {
                if (cisOverridden) void save({ checkIntervalSeconds: Math.max(10, Number(checkInterval) || 60) });
              }}
              disabled={!cisOverridden}
              className={`w-16 ${inputCls(cisOverridden)}`}
            />
            <span className="text-text-muted">s</span>
            {cisOverridden ? (
              <button
                type="button"
                onClick={() => void save({ overrideGroupSettings: false })}
                disabled={saving}
                className={resetBtn}
                title={t('agentDetail.settings.resetHint', { defaultValue: 'Remove the override: inherit from the group / global settings' })}
              >
                {t('common.reset', { defaultValue: 'Reset' })}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void save({ overrideGroupSettings: true, checkIntervalSeconds: resolvedCIS })}
                disabled={saving}
                className={overrideBtn}
                title={t('agentDetail.settings.overrideHint', { defaultValue: 'Override this setting at agent level' })}
              >
                {t('common.override', { defaultValue: 'Override' })}
              </button>
            )}
          </div>

          {/* ── Max missed pushes ───────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <label htmlFor="agent-mmp" className="min-w-[9rem]">
              {t('agentDetail.settings.maxMissed', { defaultValue: 'Max missed pushes' })}
            </label>
            <input
              id="agent-mmp"
              type="number"
              min={1}
              max={20}
              value={mmpOverridden ? maxMissed : resolvedMMP}
              onChange={e => { if (mmpOverridden) setMaxMissed(e.target.value); }}
              onBlur={() => {
                if (mmpOverridden) void save({ maxMissedPushes: Math.max(1, Number(maxMissed) || 2) });
              }}
              disabled={!mmpOverridden}
              className={`w-14 ${inputCls(mmpOverridden)}`}
            />
            {mmpOverridden ? (
              <button
                type="button"
                onClick={() => void save({ maxMissedPushes: null })}
                disabled={saving}
                className={resetBtn}
                title={t('agentDetail.settings.resetHint', { defaultValue: 'Remove the override: inherit from the group / global settings' })}
              >
                {t('common.reset', { defaultValue: 'Reset' })}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void save({ maxMissedPushes: resolvedMMP })}
                disabled={saving}
                className={overrideBtn}
                title={t('agentDetail.settings.overrideHint', { defaultValue: 'Override this setting at agent level' })}
              >
                {t('common.override', { defaultValue: 'Override' })}
              </button>
            )}
            <p className="basis-full text-[11px] text-text-muted">
              {t('agentDetail.settings.maxMissedDesc', { defaultValue: 'The agent is marked offline after this many consecutive missed pushes.' })}
            </p>
          </div>

          {/* ── WAN Matching — opt-in for dedicated/static public IPs ───────── */}
          <ToggleSwitch
            checked={wanMatching}
            disabled={saving || readOnly}
            onChange={v => { setWanMatching(v); void save({ wanMatchingEnabled: v }); }}
            label={
              <span className="text-xs text-text-secondary">
                {t('agentDetail.settings.wanMatching', { defaultValue: 'WAN matching' })}
                {wanMatching && (
                  <span className="ml-1 text-[10px] text-amber-400">
                    {t('agentDetail.settings.wanMatchingDedicated', { defaultValue: '(dedicated IP only)' })}
                  </span>
                )}
              </span>
            }
            description={t('agentDetail.settings.wanMatchingDesc', {
              defaultValue: 'Enable only if this agent has a dedicated / static public IP: the NetMap then draws peer links for WAN traffic. Do not enable behind a shared NAT.',
            })}
          />

          {/* ── Evaluate-only (dry-run) — observe without enforcing ─────────── */}
          <ToggleSwitch
            checked={evalOnly || evalInherited}
            disabled={saving || readOnly || evalInherited}
            onChange={v => {
              if (evalInherited) return; // controlled by the group — manage it there
              setEvalOnly(v); void save({ evaluateOnly: v });
            }}
            label={
              <span className="text-xs text-text-secondary">
                {t('evaluateOnly.badge', { defaultValue: 'Evaluate-only' })}
                {evalInherited && (
                  <span className="ml-1 text-[10px] text-amber-400">
                    {t('agentDetail.settings.inheritedFromGroup', { defaultValue: '(inherited from group)' })}
                  </span>
                )}
              </span>
            }
            description={t('agentDetail.settings.evaluateOnlyDesc', {
              defaultValue: 'The agent observes events but never creates or enforces auto-bans. Useful to tune the whitelist before enforcing.',
            })}
          />

          {/* ── Agent updates (C17-1) ────────────────────────────────────────── */}
          {device.deviceType === 'agent' && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary md:col-span-2">
              <label htmlFor="agent-update-policy" className="min-w-[9rem]">{t('agentUpdate.policyLabel', 'Agent updates')}</label>
              <select
                id="agent-update-policy"
                value={device.updatePolicy ?? 'inherit'}
                onChange={e => {
                  const v = e.target.value as 'inherit' | AgentUpdatePolicy;
                  void save({ updatePolicy: v === 'inherit' ? null : v });
                }}
                disabled={policySelectDisabled}
                className="rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-60 coarse:min-h-9 max-w-full"
              >
                <option value="inherit">
                  {`${t('agentUpdate.policy.inherit', 'Inherit')} (${t(`agentUpdate.policy.${resolvedPolicy}`, resolvedPolicy)} — ${policySourceText})`}
                </option>
                <option value="auto">{t('agentUpdate.policy.auto', 'Automatic')}</option>
                <option value="manual">{t('agentUpdate.policy.manual', 'Manual')}</option>
                <option value="off">{t('agentUpdate.policy.off', 'Off (frozen)')}</option>
              </select>
              {frozenFromAbove && (
                <span className="text-[10px] text-amber-400">
                  {t('agentUpdate.frozenBy', { defaultValue: 'Frozen by {{source}}', source: policySourceText })}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </fieldset>
  );
}
