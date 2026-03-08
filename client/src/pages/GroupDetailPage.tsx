import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Pencil, Trash2, ArrowLeft, FolderOpen,
  Server, Settings2, Thermometer, Bell, Globe, RotateCcw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { groupsApi } from '@/api/groups.api';
import { agentApi } from '@/api/agent.api';
import type {
  MonitorGroup, AgentDevice,
  AgentThresholds, AgentMetricThreshold, AgentTempThreshold,
  NotificationTypeConfig,
} from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS } from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { NotificationBindingsPanel } from '@/components/notifications/NotificationBindingsPanel';
import { NotificationTypesPanel } from '@/components/agent/NotificationTypesPanel';
import toast from 'react-hot-toast';

// ─────────────────────────────────────────────────────────────────────────────
// Toggle switch helper
// ─────────────────────────────────────────────────────────────────────────────

function Switch({ on, onChange, disabled = false }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        on ? 'bg-accent' : 'bg-bg-tertiary border border-border',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className={cn('inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
        on ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Group Threshold Editor
// ─────────────────────────────────────────────────────────────────────────────

const OPS = ['>', '>=', '<', '<='] as const;
const BYTES_PER_MBIT = 125_000;

function AgentGroupThresholdEditor({
  thresholds, onSave,
}: {
  thresholds: AgentThresholds;
  onSave: (t: AgentThresholds) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<AgentThresholds>({ ...thresholds });
  const [tempValues, setTempValues] = useState<AgentTempThreshold>(() => ({
    globalEnabled: false, op: '>', threshold: 85, overrides: {},
    ...(thresholds.temp ?? {}),
  }));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValues({ ...thresholds });
    setTempValues({ globalEnabled: false, op: '>', threshold: 85, overrides: {}, ...(thresholds.temp ?? {}) });
  }, [thresholds]);

  const upd = (key: keyof Omit<AgentThresholds, 'temp'>, field: keyof AgentMetricThreshold, value: unknown) =>
    setValues(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));

  const updTemp = (field: keyof AgentTempThreshold, value: unknown) =>
    setTempValues(prev => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    setSaving(true);
    try { await onSave({ ...values, temp: tempValues }); toast.success(t('groups.detail.thresholdsSaved')); }
    catch { toast.error(t('groups.detail.failedThresholds')); }
    finally { setSaving(false); }
  };

  const metricRows: Array<{ key: keyof Omit<AgentThresholds, 'temp'>; labelKey: string; unit: string; scale?: number }> = [
    { key: 'cpu',    labelKey: 'groups.detail.cpu',    unit: '%' },
    { key: 'memory', labelKey: 'groups.detail.memory', unit: '%' },
    { key: 'disk',   labelKey: 'groups.detail.disk',   unit: '%' },
    { key: 'netIn',  labelKey: 'groups.detail.netIn',  unit: 'Mbps', scale: BYTES_PER_MBIT },
    { key: 'netOut', labelKey: 'groups.detail.netOut', unit: 'Mbps', scale: BYTES_PER_MBIT },
  ];

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase text-text-muted border-b border-border">
            <th className="text-left pb-2 font-medium">{t('groups.detail.metricCol')}</th>
            <th className="text-center pb-2 font-medium w-12">{t('groups.detail.onCol')}</th>
            <th className="text-center pb-2 font-medium w-16">{t('groups.detail.opCol')}</th>
            <th className="text-left pb-2 font-medium">{t('groups.detail.valueCol')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {metricRows.map(({ key, labelKey, unit, scale }) => (
            <tr key={key} className={values[key].enabled ? '' : 'opacity-50'}>
              <td className="py-2.5 font-medium text-text-secondary">{t(labelKey)}</td>
              <td className="py-2.5 text-center">
                <Switch on={values[key].enabled} onChange={v => upd(key, 'enabled', v)} />
              </td>
              <td className="py-2.5 text-center">
                <select value={values[key].op} onChange={e => upd(key, 'op', e.target.value)}
                  disabled={!values[key].enabled}
                  className="text-xs border border-border rounded bg-bg-tertiary text-text-primary px-1.5 py-1 disabled:opacity-40">
                  {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </td>
              <td className="py-2.5">
                <div className="flex items-center gap-1.5">
                  <input type="number"
                    value={scale ? Math.round(values[key].threshold / scale) : values[key].threshold}
                    onChange={e => upd(key, 'threshold', scale ? Math.round(Number(e.target.value) * scale) : Number(e.target.value))}
                    disabled={!values[key].enabled} min={0}
                    className="w-24 text-xs border border-border rounded bg-bg-tertiary text-text-primary px-2 py-1 disabled:opacity-40" />
                  <span className="text-xs text-text-muted">{unit}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Temperature global threshold */}
      <div>
        <div className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <Thermometer size={11} /> {t('groups.detail.temperatures')}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase text-text-muted border-b border-border">
              <th className="text-left pb-2 font-medium">{t('groups.detail.metricCol')}</th>
              <th className="text-center pb-2 font-medium w-12">{t('groups.detail.onCol')}</th>
              <th className="text-center pb-2 font-medium w-16">{t('groups.detail.opCol')}</th>
              <th className="text-left pb-2 font-medium">{t('groups.detail.valueCol')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            <tr className={tempValues.globalEnabled ? '' : 'opacity-50'}>
              <td className="py-2.5 font-medium text-text-secondary">{t('groups.detail.tempGlobal')}</td>
              <td className="py-2.5 text-center">
                <Switch on={tempValues.globalEnabled} onChange={v => updTemp('globalEnabled', v)} />
              </td>
              <td className="py-2.5 text-center">
                <select value={tempValues.op} onChange={e => updTemp('op', e.target.value)}
                  disabled={!tempValues.globalEnabled}
                  className="text-xs border border-border rounded bg-bg-tertiary text-text-primary px-1.5 py-1 disabled:opacity-40">
                  {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </td>
              <td className="py-2.5">
                <div className="flex items-center gap-1.5">
                  <input type="number" value={tempValues.threshold}
                    onChange={e => updTemp('threshold', Number(e.target.value))}
                    disabled={!tempValues.globalEnabled} min={0} max={200}
                    className="w-24 text-xs border border-border rounded bg-bg-tertiary text-text-primary px-2 py-1 disabled:opacity-40" />
                  <span className="text-xs text-text-muted">°C</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
          {saving ? t('common.saving') : t('groups.detail.saveSettings')}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Group Settings Panel
// ─────────────────────────────────────────────────────────────────────────────

function AgentGroupSettingsPanel({ group, onUpdate }: { group: MonitorGroup; onUpdate: (g: MonitorGroup) => void }) {
  const { t } = useTranslation();
  const cfg = group.agentGroupConfig ?? { pushIntervalSeconds: null, heartbeatMonitoring: null, maxMissedPushes: null, notificationTypes: null };
  const thr = group.agentThresholds ?? DEFAULT_AGENT_THRESHOLDS;

  const [interval, setInterval] = useState<string>(cfg.pushIntervalSeconds !== null ? String(cfg.pushIntervalSeconds) : '');
  const [heartbeat, setHeartbeat] = useState<boolean | null>(cfg.heartbeatMonitoring);
  const [maxMissed, setMaxMissed] = useState<string>(cfg.maxMissedPushes !== null ? String(cfg.maxMissedPushes) : '');
  const [saving, setSaving] = useState(false);

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const updated = await groupsApi.updateAgentGroupConfig(group.id, {
        agentGroupConfig: {
          pushIntervalSeconds: interval.trim() ? Number(interval) : null,
          heartbeatMonitoring: heartbeat,
          maxMissedPushes: maxMissed.trim() ? Number(maxMissed) : null,
          notificationTypes: cfg.notificationTypes,
        },
      });
      onUpdate(updated);
      toast.success(t('groups.detail.saveSettings'));
    } catch { toast.error(t('groups.failedUpdate')); }
    finally { setSaving(false); }
  };

  const handleSaveThresholds = async (thresholds: AgentThresholds) => {
    const updated = await groupsApi.updateAgentGroupConfig(group.id, { agentThresholds: thresholds });
    onUpdate(updated);
  };

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-6">
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
        {t('groups.detail.agentSettings')}
      </h2>

      {/* Push Interval */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-text-primary flex items-center gap-2">
            {t('groups.detail.pushInterval')}
            {cfg.pushIntervalSeconds === null && (
              <span className="text-xs text-text-muted">Default</span>
            )}
          </div>
          <div className="text-xs text-text-muted">{t('groups.detail.pushIntervalDesc')}</div>
        </div>
        <div className="flex items-center gap-2">
          <input type="number" value={interval} min={1} max={86400}
            onChange={e => setInterval(e.target.value)}
            placeholder="60"
            className="w-24 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-right placeholder:text-text-muted" />
          <span className="text-xs text-text-muted">{t('groups.detail.seconds')}</span>
        </div>
      </div>

      {/* Heartbeat Monitoring */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-text-primary flex items-center gap-2">
            {t('groups.detail.heartbeatMonitoring')}
            {heartbeat === null && (
              <span className="text-xs text-text-muted">Default</span>
            )}
            {heartbeat !== null && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">Override</span>
            )}
          </div>
          <div className="text-xs text-text-muted">{t('groups.detail.heartbeatMonitoringDesc')}</div>
        </div>
        <div className="flex items-center gap-2">
          <Switch on={heartbeat ?? true} onChange={v => setHeartbeat(v)} disabled={heartbeat === null} />
          {heartbeat === null ? (
            <button
              onClick={() => setHeartbeat(true)}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              {t('common.override')}
            </button>
          ) : (
            <button
              onClick={() => setHeartbeat(null)}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/10 transition-colors flex items-center gap-1"
              title={t('common.reset')}
            >
              <RotateCcw size={12} />
              {t('common.reset')}
            </button>
          )}
        </div>
      </div>

      {/* Max Missed Pushes */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-text-primary flex items-center gap-2">
            {t('groups.detail.maxMissedPushes')}
            {cfg.maxMissedPushes === null && (
              <span className="text-xs text-text-muted">Default</span>
            )}
          </div>
          <div className="text-xs text-text-muted">{t('groups.detail.maxMissedPushesDesc')}</div>
        </div>
        <div className="flex items-center gap-2">
          <input type="number" value={maxMissed} min={1} max={20}
            onChange={e => setMaxMissed(e.target.value)}
            placeholder="2"
            className="w-20 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-right placeholder:text-text-muted" />
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={handleSaveConfig} disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
          {saving ? t('common.saving') : t('groups.detail.saveSettings')}
        </button>
      </div>

      {/* Thresholds */}
      <div className="border-t border-border pt-4">
        <div className="text-xs font-medium text-text-muted uppercase tracking-wide mb-4 flex items-center gap-1.5">
          <Settings2 size={11} /> {t('groups.detail.thresholds')}
          <span className="ml-1 text-text-muted font-normal normal-case">{t('groups.detail.thresholdsDesc')}</span>
        </div>
        <AgentGroupThresholdEditor thresholds={thr} onSave={handleSaveThresholds} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main GroupDetailPage
// ─────────────────────────────────────────────────────────────────────────────

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { isAdmin, canWriteGroup } = useAuthStore();
  const { getGroup, removeGroup, fetchGroups, fetchTree } = useGroupStore();

  const groupId = parseInt(id!, 10);
  const storeGroup = getGroup(groupId);
  const canWrite = canWriteGroup(groupId);

  const [group, setGroup] = useState<MonitorGroup | null>(storeGroup ?? null);
  const [devices, setDevices] = useState<AgentDevice[]>([]);
  const [loading, setLoading] = useState(true);

  const isAgentGroup = group?.kind === 'agent';

  // Fetch group + agent devices on mount
  useEffect(() => {
    async function loadData() {
      try {
        const g = await groupsApi.getById(groupId);
        setGroup(g);

        if (g.kind === 'agent') {
          const all = await agentApi.listDevices('approved');
          setDevices(all.filter(d => d.groupId === groupId));
        }
      } catch {
        // group may come from store
      }
      setLoading(false);
    }
    loadData();
  }, [groupId]);

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
        <p className="text-text-muted">{t('monitors.notFound')}</p>
        <Link to="/" className="mt-4">
          <Button variant="secondary">{t('monitors.backToDashboard')}</Button>
        </Link>
      </div>
    );
  }

  const handleDelete = async () => {
    if (!confirm(t('groups.confirmDelete', { name: group.name }))) return;
    try {
      await groupsApi.delete(groupId);
      removeGroup(groupId);
      fetchGroups();
      fetchTree();
      toast.success(t('groups.deleted'));
      navigate('/');
    } catch {
      toast.error(t('groups.failedDelete'));
    }
  };

  // Agent device stats
  const onlineCount = devices.filter(d => d.status === 'approved').length;

  return (
    <div className="p-6">
      {/* Back button */}
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4">
        <ArrowLeft size={14} />
        {t('monitors.backToDashboard')}
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10">
            {isAgentGroup
              ? <Server size={24} className="text-accent" />
              : <FolderOpen size={24} className="text-accent" />
            }
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{group.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              {isAgentGroup && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                  <Server size={10} />
                  {t('groups.agentGroup')}
                </span>
              )}
              {group.isGeneral && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                  <Globe size={10} />
                  {t('groups.generalBadge')}
                </span>
              )}
              {group.groupNotifications && (
                <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/10 px-2 py-0.5 text-[10px] font-medium text-yellow-500">
                  <Bell size={10} />
                  {t('groups.groupedBadge')}
                </span>
              )}
              {group.description && (
                <span className="text-sm text-text-muted">{group.description}</span>
              )}
            </div>
          </div>
        </div>

        {canWrite && (
          <div className="flex items-center gap-2">
            <Link to={`/group/${groupId}/edit`}>
              <Button variant="secondary" size="sm">
                <Pencil size={14} className="mr-1.5" />
                {t('common.edit')}
              </Button>
            </Link>
            <Button variant="danger" size="sm" onClick={handleDelete}>
              <Trash2 size={14} className="mr-1.5" />
              {t('common.delete')}
            </Button>
          </div>
        )}
      </div>

      {/* ── Agent group stats ── */}
      {isAgentGroup && (
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('groups.detail.totalAgents')}</div>
            <div className="text-xl font-mono font-semibold text-text-primary">{devices.length}</div>
          </div>
          <div className="rounded-lg border border-status-up/30 bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('groups.detail.online')}</div>
            <div className="text-xl font-mono font-semibold text-status-up">{onlineCount}</div>
          </div>
        </div>
      )}

      {/* ── Agent devices list ── */}
      {isAgentGroup && devices.length > 0 && (
        <div className="mb-6 rounded-lg border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              {t('groups.detail.agentList', { count: devices.length })}
            </h3>
          </div>
          <div className="divide-y divide-border">
            {devices.map(device => (
              <Link
                key={device.id}
                to={`/agents/${device.id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors"
              >
                <span className={cn(
                  'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                  device.status === 'approved' ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-400',
                )}>
                  {device.status.toUpperCase()}
                </span>
                <span className="flex-1 text-sm text-text-primary truncate">
                  {device.name ?? device.hostname}
                </span>
                <span className="text-xs text-text-muted">{device.hostname}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Notification Bindings (admin only) */}
      {isAdmin() && (
        <div className="mt-6">
          <NotificationBindingsPanel
            scope="group"
            scopeId={groupId}
            title={t('monitors.sectionNotifications')}
          />
        </div>
      )}

      {/* ── Agent group: Notification Types ── */}
      {isAdmin() && isAgentGroup && (
        <div className="mt-6">
          <NotificationTypesPanel
            config={group.agentGroupConfig?.notificationTypes ?? null}
            scope="group"
            onSave={async (notifTypes: NotificationTypeConfig | null) => {
              const cfg = group.agentGroupConfig ?? { pushIntervalSeconds: null, heartbeatMonitoring: null, maxMissedPushes: null, notificationTypes: null };
              const updated = await groupsApi.updateAgentGroupConfig(group.id, {
                agentGroupConfig: { ...cfg, notificationTypes: notifTypes },
              });
              setGroup(updated);
            }}
          />
        </div>
      )}

      {/* ── Agent group settings ── */}
      {isAdmin() && isAgentGroup && (
        <div className="mt-6">
          <AgentGroupSettingsPanel group={group} onUpdate={setGroup} />
        </div>
      )}
    </div>
  );
}
