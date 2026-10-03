import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { ApiResponse, ScopeSettingsView, SettingLevel, SettingRawValue, SettingsKey } from '@obliview/shared';
import { SETTINGS_DEFINITIONS } from '@obliview/shared';
import apiClient from '@/api/client';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SettingField } from './SettingField';

/**
 * IPS settings cascade API (W13-1): /api/settings/<level>/... Levels below
 * global resolve the operating tenant / the group / the agent server-side.
 */
export const ipsSettingsApi = {
  async get(level: SettingLevel, scopeId: number | null): Promise<ScopeSettingsView> {
    const path = level === 'global' ? '/settings/global/resolved'
      : level === 'tenant' ? '/settings/tenant/resolved'
      : `/settings/${level}/${scopeId}/resolved`;
    const res = await apiClient.get<ApiResponse<ScopeSettingsView>>(path);
    return res.data.data!;
  },
  async set(level: SettingLevel, scopeId: number | null, key: SettingsKey, value: SettingRawValue): Promise<ScopeSettingsView> {
    const res = await apiClient.put<ApiResponse<ScopeSettingsView>>(`/settings/${level}/${scopeId ?? 0}`, { key, value });
    return res.data.data!;
  },
  async reset(level: SettingLevel, scopeId: number | null, key: SettingsKey): Promise<ScopeSettingsView> {
    const res = await apiClient.delete<ApiResponse<ScopeSettingsView>>(`/settings/${level}/${scopeId ?? 0}/${key}`);
    return res.data.data!;
  },
};

function apiError(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

interface SettingsPanelProps {
  level: SettingLevel;
  /** Group / agent id; null for global and tenant (the operating tenant). */
  scopeId: number | null;
  title?: string;
  description?: string;
  /** Keys edited elsewhere on the page (their dedicated controls). */
  hide?: readonly SettingsKey[];
  /** No write access: every control is disabled. */
  readOnly?: boolean;
  /** Where the update policy (display only here) is managed. */
  updatePolicyHref?: string | null;
  /** Called with the new view after each write (e.g. to refresh a device). */
  onChange?: (view: ScopeSettingsView) => void;
  className?: string;
}

/**
 * The IPS settings of one level (Obliance SettingsPanel): every key that may
 * be set there, with the inherited value and its source (InheritanceBadge).
 */
export function SettingsPanel({
  level, scopeId, title, description, hide = [], readOnly = false, updatePolicyHref = null, onChange, className,
}: SettingsPanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<ScopeSettingsView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setView(await ipsSettingsApi.get(level, scopeId));
    } catch {
      setFailed(true);
    }
  }, [level, scopeId]);

  useEffect(() => { setView(null); void load(); }, [load]);

  const apply = (v: ScopeSettingsView) => { setView(v); onChange?.(v); };

  const handleSave = async (key: SettingsKey, value: SettingRawValue) => {
    try {
      apply(await ipsSettingsApi.set(level, view?.scopeId ?? scopeId, key, value));
      toast.success(t('settings.saved', { defaultValue: 'Setting saved' }));
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.saveFailed', { defaultValue: 'Failed to save the setting' }));
      void load();
    }
  };

  const handleReset = async (key: SettingsKey) => {
    try {
      apply(await ipsSettingsApi.reset(level, view?.scopeId ?? scopeId, key));
      toast.success(t('settings.resetDone', { defaultValue: 'Back to the inherited value' }));
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.saveFailed', { defaultValue: 'Failed to save the setting' }));
      void load();
    }
  };

  const defs = SETTINGS_DEFINITIONS.filter((d) =>
    !hide.includes(d.key) && (d.resolution === 'external' || d.scopes.includes(level)));

  return (
    <section className={className ?? 'rounded-lg border border-border bg-bg-secondary p-5 max-sm:p-4'}>
      {title && <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-1">{title}</h2>}
      {description && <p className="text-xs text-text-muted mb-3">{description}</p>}
      {failed ? (
        <p className="text-sm text-text-muted py-4">
          {t('settings.loadFailed', { defaultValue: 'Failed to load some settings' })}{' '}
          <button type="button" onClick={() => void load()} className="text-accent hover:underline">
            {t('common.retry', { defaultValue: 'Retry' })}
          </button>
        </p>
      ) : !view ? (
        <div className="flex justify-center py-6"><LoadingSpinner /></div>
      ) : (
        <div className="divide-y divide-border">
          {defs.map((def) => (
            <SettingField
              key={`${def.key}:${view.scopeId ?? 'g'}`}
              definition={def}
              level={level}
              inherited={view.resolved[def.key]}
              effective={view.effective[def.key]}
              override={view.overrides[def.key]}
              readOnly={readOnly}
              manageHref={def.resolution === 'external' ? updatePolicyHref : undefined}
              onSave={handleSave}
              onReset={handleReset}
            />
          ))}
        </div>
      )}
    </section>
  );
}
