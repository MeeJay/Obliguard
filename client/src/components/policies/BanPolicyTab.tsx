import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Lock, Plus, RotateCcw, Save, Timer, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { EmptyState } from '@/components/common/EmptyState';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useIsPlatformAdmin } from '@/hooks/usePermission';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useTenantStore } from '@/store/tenantStore';

// Policies > Ban policy (W12-3): how long an auth-failure auto-ban lasts and
// how it grows for repeat offenders. Auto-bans are global, so this is one
// platform policy (server: banPolicy.service.ts, app_config 'banPolicy'),
// edited by the platform admin from the Default tenant; everyone else sees a
// read-only summary. Presentation follows Obliance TenantThresholdsTab: one
// card, description on the left, Cancel / Save on the right.

interface BanPolicyStep { priorBans: number; ttlSeconds: number | null }
interface BanPolicy { autoBanTtlSeconds: number | null; ladder: BanPolicyStep[] }
interface BanPolicyLimits { minTtlSeconds: number; maxTtlSeconds: number; maxSteps: number; maxPriorBans: number }
interface BanPolicyResponse {
  policy: BanPolicy;
  source: 'default' | 'platform';
  limits: BanPolicyLimits;
}

const banPolicyApi = {
  async get(): Promise<BanPolicyResponse> {
    const res = await apiClient.get<{ data: BanPolicyResponse }>('/admin/config/ban-policy');
    return res.data.data;
  },
  async set(policy: BanPolicy | null): Promise<BanPolicyResponse> {
    const res = await apiClient.put<{ data: BanPolicyResponse }>('/admin/config/ban-policy', policy === null ? { policy: null } : policy);
    return res.data.data;
  },
};

type Unit = 'm' | 'h' | 'd';
const UNIT_SECONDS: Record<Unit, number> = { m: 60, h: 3600, d: 86400 };
const UNITS: Unit[] = ['m', 'h', 'd'];

/** Editable duration: permanent, or a whole number of minutes / hours / days. */
interface DurationDraft { permanent: boolean; value: string; unit: Unit }
interface StepDraft { key: number; priorBans: string; duration: DurationDraft }
interface PolicyDraft { base: DurationDraft; ladder: StepDraft[] }

/** Largest unit that divides the duration exactly. */
function toDuration(seconds: number | null): DurationDraft {
  if (seconds === null) return { permanent: true, value: '1', unit: 'd' };
  for (const unit of ['d', 'h', 'm'] as const) {
    if (seconds % UNIT_SECONDS[unit] === 0) return { permanent: false, value: String(seconds / UNIT_SECONDS[unit]), unit };
  }
  return { permanent: false, value: String(Math.max(1, Math.round(seconds / 60))), unit: 'm' };
}

/** Seconds of a draft duration; null = permanent, NaN = not a whole positive number. */
function durationSeconds(d: DurationDraft): number | null {
  if (d.permanent) return null;
  const n = /^\d+$/.test(d.value.trim()) ? Number(d.value.trim()) : NaN;
  return n > 0 ? n * UNIT_SECONDS[d.unit] : NaN;
}

let stepKey = 0;
function toDraft(p: BanPolicy): PolicyDraft {
  return {
    base: toDuration(p.autoBanTtlSeconds),
    ladder: p.ladder.map((s) => ({ key: ++stepKey, priorBans: String(s.priorBans), duration: toDuration(s.ttlSeconds) })),
  };
}

function formatDuration(t: TFunction, seconds: number | null): string {
  if (seconds === null) return t('policies.banPolicyPermanent', { defaultValue: 'Permanent' });
  const d = toDuration(seconds);
  const count = Number(d.value);
  if (d.unit === 'd') return t('policies.banPolicyDays', { count, defaultValue: '{{count}} day(s)' });
  if (d.unit === 'h') return t('policies.banPolicyHours', { count, defaultValue: '{{count}} hour(s)' });
  return t('policies.banPolicyMinutes', { count, defaultValue: '{{count}} minute(s)' });
}

/** Mirror of the server validation (banPolicyService.validate): the first problem, or the policy. */
function fromDraft(t: TFunction, d: PolicyDraft, limits: BanPolicyLimits): { policy: BanPolicy } | { error: string } {
  const checkTtl = (v: number | null): string | null => {
    if (v === null) return null;
    if (Number.isNaN(v)) return t('policies.banPolicyErrNumber', { defaultValue: 'Enter a whole number greater than 0.' });
    if (v < limits.minTtlSeconds || v > limits.maxTtlSeconds) {
      return t('policies.banPolicyErrRange', {
        min: formatDuration(t, limits.minTtlSeconds), max: formatDuration(t, limits.maxTtlSeconds),
        defaultValue: 'A timed ban lasts between {{min}} and {{max}}.',
      });
    }
    return null;
  };
  const base = durationSeconds(d.base);
  const baseErr = checkTtl(base);
  if (baseErr) return { error: baseErr };
  const rank = (v: number | null) => (v === null ? Number.POSITIVE_INFINITY : v);
  const ladder: BanPolicyStep[] = [];
  let prevPrior = 0;
  let prevTtl = base;
  for (const s of d.ladder) {
    const n = /^\d+$/.test(s.priorBans.trim()) ? Number(s.priorBans.trim()) : NaN;
    if (!(n >= 1 && n <= limits.maxPriorBans)) {
      return { error: t('policies.banPolicyErrPrior', { max: limits.maxPriorBans, defaultValue: 'Earlier bans: a whole number between 1 and {{max}}.' }) };
    }
    if (n <= prevPrior) return { error: t('policies.banPolicyErrOrder', { defaultValue: 'Each step needs more earlier bans than the step above it.' }) };
    const ttl = durationSeconds(s.duration);
    const err = checkTtl(ttl);
    if (err) return { error: err };
    if (rank(ttl) < rank(prevTtl)) {
      return { error: t('policies.banPolicyErrShorter', { defaultValue: 'A repeat offence never gets a shorter ban than the step above it.' }) };
    }
    ladder.push({ priorBans: n, ttlSeconds: ttl });
    prevPrior = n;
    prevTtl = ttl;
  }
  return { policy: { autoBanTtlSeconds: base, ladder } };
}

/** Server error text of a failed API call, if any. */
function apiError(err: unknown): string | undefined {
  const data = (err as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
  return data?.error ?? data?.message;
}

const selectCls = 'rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50';
const inputCls = 'w-24 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50';

function DurationEditor({ value, onChange, idPrefix, disabled }: {
  value: DurationDraft;
  onChange: (next: DurationDraft) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ToggleSwitch
        size="sm"
        checked={value.permanent}
        onChange={(permanent) => onChange({ ...value, permanent })}
        disabled={disabled}
        label={t('policies.banPolicyPermanent', { defaultValue: 'Permanent' })}
      />
      {!value.permanent && (
        <div className="flex items-center gap-2">
          <input
            id={`${idPrefix}-value`}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={value.value}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
            disabled={disabled}
            className={inputCls}
            aria-label={t('policies.banPolicyDuration', { defaultValue: 'Duration' })}
          />
          <select
            value={value.unit}
            onChange={(e) => onChange({ ...value, unit: e.target.value as Unit })}
            disabled={disabled}
            className={selectCls}
            aria-label={t('policies.banPolicyUnit', { defaultValue: 'Unit' })}
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u === 'm' ? t('policies.banPolicyUnitMinutes', { defaultValue: 'minutes' })
                  : u === 'h' ? t('policies.banPolicyUnitHours', { defaultValue: 'hours' })
                    : t('policies.banPolicyUnitDays', { defaultValue: 'days' })}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/** One line per level: first offence, then each ladder step. */
function PolicySummary({ policy }: { policy: BanPolicy }) {
  const { t } = useTranslation();
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      <li className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
        <span className="text-text-secondary">{t('policies.banPolicyFirstOffence', { defaultValue: 'First offence' })}</span>
        <span className="font-medium text-text-primary">{formatDuration(t, policy.autoBanTtlSeconds)}</span>
      </li>
      {policy.ladder.map((s) => (
        <li key={s.priorBans} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
          <span className="text-text-secondary">
            {t('policies.banPolicyAfterPrior', { count: s.priorBans, defaultValue: 'After {{count}} earlier ban(s)' })}
          </span>
          <span className="font-medium text-text-primary">{formatDuration(t, s.ttlSeconds)}</span>
        </li>
      ))}
    </ul>
  );
}

export function BanPolicyTab() {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const isPlatformAdmin = useIsPlatformAdmin();
  const isMaster = useIsMasterTenant();
  const canWrite = isPlatformAdmin && isMaster;
  const currentTenantId = useTenantStore((s) => s.currentTenantId);

  const [data, setData] = useState<BanPolicyResponse | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const apply = useCallback((r: BanPolicyResponse) => {
    setData(r);
    setDraft(toDraft(r.policy));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await banPolicyApi.get();
      if (!live.current) return;
      apply(r);
      setLoadError(false);
    } catch {
      if (!live.current) return;
      setLoadError(true);
      toast.error(t('policies.banPolicyLoadFailed', { defaultValue: 'Failed to load the ban policy' }), { id: 'ban-policy-load' });
    } finally {
      if (live.current) setLoading(false);
    }
  }, [apply, t]);

  useEffect(() => { void load(); }, [load, currentTenantId]);

  const parsed = useMemo(
    () => (draft && data ? fromDraft(t, draft, data.limits) : null),
    [draft, data, t],
  );
  const dirty = !!(parsed && data && 'policy' in parsed && JSON.stringify(parsed.policy) !== JSON.stringify(data.policy))
    || !!(parsed && 'error' in parsed);

  const save = async () => {
    if (!parsed || !('policy' in parsed)) return;
    setSaving(true);
    try {
      apply(await banPolicyApi.set(parsed.policy));
      toast.success(t('policies.banPolicySaved', { defaultValue: 'Ban policy saved. It applies to new auto-bans.' }));
    } catch (err) {
      toast.error(apiError(err) ?? t('policies.banPolicySaveFailed', { defaultValue: 'Failed to save the ban policy' }));
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    if (!(await askConfirm({
      title: t('policies.banPolicyResetTitle', { defaultValue: 'Back to permanent auto-bans?' }),
      message: t('policies.banPolicyResetConfirm', {
        defaultValue: 'New auto-bans will be permanent again and the repeat-offender ladder is removed. Existing bans keep their expiry.',
      }),
      confirmLabel: t('policies.banPolicyReset', { defaultValue: 'Reset to default' }),
    }))) return;
    setSaving(true);
    try {
      apply(await banPolicyApi.set(null));
      toast.success(t('policies.banPolicySaved', { defaultValue: 'Ban policy saved. It applies to new auto-bans.' }));
    } catch (err) {
      toast.error(apiError(err) ?? t('policies.banPolicySaveFailed', { defaultValue: 'Failed to save the ban policy' }));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner />
      </div>
    );
  }

  if (!data || !draft) {
    return (
      <EmptyState
        icon={<Timer size={32} strokeWidth={1.5} />}
        title={t('policies.banPolicyLoadFailed', { defaultValue: 'Failed to load the ban policy' })}
        action={loadError ? (
          <Button variant="secondary" onClick={() => void load()}>{t('common.retry', { defaultValue: 'Retry' })}</Button>
        ) : undefined}
      />
    );
  }

  const setStep = (key: number, patch: Partial<StepDraft>) =>
    setDraft((d) => d && { ...d, ladder: d.ladder.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  const addStep = () => setDraft((d) => {
    if (!d) return d;
    const last = d.ladder[d.ladder.length - 1];
    const prior = last ? (Number(last.priorBans) || d.ladder.length) + 1 : 1;
    const duration = last ? { ...last.duration } : (d.base.permanent ? { ...d.base } : { permanent: false, value: '1', unit: 'd' as Unit });
    return { ...d, ladder: [...d.ladder, { key: ++stepKey, priorBans: String(prior), duration }] };
  });
  const removeStep = (key: number) => setDraft((d) => d && { ...d, ladder: d.ladder.filter((s) => s.key !== key) });

  const description = t('policies.banPolicyHelp', {
    defaultValue: 'How long an auto-ban (too many authentication failures) lasts. Auto-bans are global, so this policy applies to every tenant. Repeat offenders can get longer bans: the step matching the number of earlier bans of the address wins. Changes apply to new auto-bans only.',
  });

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-bg-secondary p-4 sm:p-5">
        {/* Phones: Cancel / Save move under the description instead of squeezing it. */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              {t('policies.banPolicyTitle', { defaultValue: 'Auto-ban duration' })}
            </h3>
            <p className="mt-1 max-w-2xl text-xs text-text-muted">{description}</p>
            <p className="mt-1 text-xs text-text-muted">
              {data.source === 'default'
                ? t('policies.banPolicySourceDefault', { defaultValue: 'Default policy: auto-bans are permanent.' })
                : t('policies.banPolicySourcePlatform', { defaultValue: 'Platform policy set by an administrator.' })}
            </p>
          </div>
          {canWrite && (
            <div className="flex shrink-0 items-center gap-2 max-sm:justify-end">
              <Button variant="ghost" size="sm" onClick={() => setDraft(toDraft(data.policy))} disabled={!dirty || saving}>
                <RotateCcw size={14} className="mr-1" />
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button onClick={() => void save()} loading={saving} disabled={!dirty || !parsed || 'error' in parsed}>
                <Save size={14} className="mr-1" />
                {t('common.save', { defaultValue: 'Save' })}
              </Button>
            </div>
          )}
        </div>

        {!canWrite ? (
          <div className="space-y-3">
            <PolicySummary policy={data.policy} />
            <p className="flex items-center gap-1.5 text-xs text-text-muted">
              <Lock size={12} />
              {t('policies.banPolicyReadOnly', { defaultValue: 'Only a platform administrator, in the Default tenant, can change this policy.' })}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="ban-policy-base-value" className="block text-sm font-medium text-text-secondary">
                {t('policies.banPolicyFirstOffence', { defaultValue: 'First offence' })}
              </label>
              <DurationEditor
                idPrefix="ban-policy-base"
                value={draft.base}
                onChange={(base) => setDraft({ ...draft, base })}
                disabled={saving}
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-text-secondary">
                {t('policies.banPolicyLadder', { defaultValue: 'Repeat offenders' })}
              </div>
              {draft.ladder.length === 0 ? (
                <p className="text-xs text-text-muted">
                  {t('policies.banPolicyLadderEmpty', { defaultValue: 'No escalation: every auto-ban gets the first-offence duration.' })}
                </p>
              ) : (
                <ul className="space-y-2">
                  {draft.ladder.map((s, i) => (
                    <li key={s.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
                      <label htmlFor={`ban-policy-step-${s.key}`} className="text-sm text-text-secondary">
                        {t('policies.banPolicyAfter', { defaultValue: 'After' })}
                      </label>
                      <input
                        id={`ban-policy-step-${s.key}`}
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={s.priorBans}
                        onChange={(e) => setStep(s.key, { priorBans: e.target.value })}
                        disabled={saving}
                        className={inputCls}
                      />
                      <span className="text-sm text-text-secondary">
                        {t('policies.banPolicyEarlierBans', { defaultValue: 'earlier ban(s):' })}
                      </span>
                      <DurationEditor
                        idPrefix={`ban-policy-step-${s.key}-ttl`}
                        value={s.duration}
                        onChange={(duration) => setStep(s.key, { duration })}
                        disabled={saving}
                      />
                      <IconButton
                        icon={<Trash2 size={14} />}
                        variant="danger"
                        label={t('policies.banPolicyRemoveStep', { n: i + 1, defaultValue: 'Remove step {{n}}' })}
                        onClick={() => removeStep(s.key)}
                        disabled={saving}
                        className="ml-auto"
                      />
                    </li>
                  ))}
                </ul>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={addStep}
                disabled={saving || draft.ladder.length >= data.limits.maxSteps}
              >
                <Plus size={14} className="mr-1" />
                {t('policies.banPolicyAddStep', { defaultValue: 'Add a step' })}
              </Button>
            </div>

            {parsed && 'error' in parsed && (
              <p role="alert" className="text-xs text-status-down">{parsed.error}</p>
            )}

            {parsed && 'policy' in parsed && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-text-secondary">
                  {t('policies.banPolicyPreview', { defaultValue: 'Summary' })}
                </div>
                <PolicySummary policy={parsed.policy} />
              </div>
            )}

            {data.source === 'platform' && (
              <div>
                <Button variant="ghost" size="sm" onClick={() => void resetToDefault()} disabled={saving}>
                  {t('policies.banPolicyReset', { defaultValue: 'Reset to default' })}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
