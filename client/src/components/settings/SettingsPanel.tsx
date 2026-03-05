import { useState, useEffect } from 'react';
import type { ResolvedSettings, SettingsScope } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';
import { SETTINGS_DEFINITIONS } from '@obliview/shared';
import { settingsApi } from '@/api/settings.api';
import { SettingField } from './SettingField';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import toast from 'react-hot-toast';

interface SettingsPanelProps {
  scope: SettingsScope;
  scopeId: number | null;
  title?: string;
}

export function SettingsPanel({ scope, scopeId, title }: SettingsPanelProps) {
  const [resolved, setResolved] = useState<ResolvedSettings | null>(null);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const fetchSettings = async () => {
    setLoading(true);
    try {
      let data;
      if (scope === 'global') {
        data = await settingsApi.getGlobalResolved();
      } else if (scope === 'group') {
        data = await settingsApi.getGroupResolved(scopeId!);
      } else {
        data = await settingsApi.getMonitorResolved(scopeId!);
      }
      setResolved(data.resolved);
      setOverrides(data.overrides);
    } catch {
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, [scope, scopeId]);

  const handleSave = async (key: SettingsKey, value: number) => {
    const scopeIdStr = scopeId !== null ? String(scopeId) : 'null';
    try {
      await settingsApi.set(scope, scopeIdStr, key, value);
      toast.success('Setting saved');
      await fetchSettings();
    } catch {
      toast.error('Failed to save setting');
    }
  };

  const handleReset = async (key: SettingsKey) => {
    const scopeIdStr = scopeId !== null ? String(scopeId) : 'null';
    try {
      await settingsApi.remove(scope, scopeIdStr, key);
      toast.success('Reset to inherited');
      await fetchSettings();
    } catch {
      toast.error('Failed to reset setting');
    }
  };

  if (loading || !resolved) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-5">
      {title && (
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-4">
          {title}
        </h2>
      )}
      <div>
        {SETTINGS_DEFINITIONS.map((def) => (
          <SettingField
            key={def.key}
            definition={def}
            inheritedValue={resolved[def.key]}
            overrideValue={overrides[def.key]}
            scope={scope}
            onSave={handleSave}
            onReset={handleReset}
          />
        ))}
      </div>
    </div>
  );
}
