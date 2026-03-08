import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Pencil, Pause, Play, Trash2, ArrowLeft, FolderOpen, RotateCcw, Bell, Globe,
  Server, Settings2, Thermometer, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { groupsApi } from '@/api/groups.api';
import { monitorsApi } from '@/api/monitors.api';
import { MONITOR_TYPE_LABELS } from '@obliview/shared';
import type {
  MonitorGroup, Monitor, Heartbeat,
  AgentThresholds, AgentMetricThreshold, AgentTempThreshold,
  NotificationTypeConfig,
} from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS, DEFAULT_NOTIFICATION_TYPES } from '@obliview/shared';
import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';
import { HeartbeatChart } from '@/components/monitors/HeartbeatChart';
import { HeartbeatBar } from '@/components/monitors/HeartbeatBar';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PeriodSelector } from '@/components/common/PeriodSelector';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { NotificationBindingsPanel } from '@/components/notifications/NotificationBindingsPanel';
import { RemediationBindingsPanel } from '@/components/remediation/RemediationBindingsPanel';
import { MaintenanceWindowList } from '@/components/maintenance/MaintenanceWindowList';
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
// Agent Group Stats
// ─────────────────────────────────────────────────────────────────────────────

interface AgentGroupStats {
  total: number;
  online: number;   // up status
  alert: number;    // alert status
  offline: number;  // down status
  pending: number;  // pending status
  alertAgentNames: string[];
  offlineAgentNames: string[];
}

function computeAgentGroupStats(monitors: Monitor[]): AgentGroupStats {
  const agentMonitors = monitors.filter(m => m.type === 'agent' || m.agentDeviceId !== null);
  const stats: AgentGroupStats = { total: 0, online: 0, alert: 0, offline: 0, pending: 0, alertAgentNames: [], offlineAgentNames: [] };
  for (const m of agentMonitors) {
    stats.total++;
    if (m.status === 'up') stats.online++;
    else if (m.status === 'alert') { stats.alert++; stats.alertAgentNames.push(m.name); }
    else if (m.status === 'down' || m.status === 'inactive') { stats.offline++; stats.offlineAgentNames.push(m.name); }
    else { stats.pending++; }
  }
  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Group Threshold Editor (inline, not a modal)
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

/** Notification type switch rows */
const NOTIF_TYPE_ROWS: Array<{
  key: keyof NotificationTypeConfig;
  label: string;
  desc: string;
}> = [
  { key: 'global', label: 'Global', desc: 'Master switch — disabling stops all notifications (channels remain bound)' },
  { key: 'down',   label: 'Down',   desc: 'Notify when the agent/monitor goes offline or down' },
  { key: 'up',     label: 'Up',     desc: 'Notify when the agent/monitor recovers' },
  { key: 'alert',  label: 'Alert',  desc: 'Notify when a threshold is breached' },
  { key: 'update', label: 'Update', desc: 'Notify when the agent starts a self-update (off by default)' },
];

function AgentGroupSettingsPanel({ group, onUpdate }: { group: MonitorGroup; onUpdate: (g: MonitorGroup) => void }) {
  const { t } = useTranslation();
  const cfg = group.agentGroupConfig ?? { pushIntervalSeconds: null, heartbeatMonitoring: null, maxMissedPushes: null, notificationTypes: null };
  const thr = group.agentThresholds ?? DEFAULT_AGENT_THRESHOLDS;

  const [interval, setInterval] = useState<string>(cfg.pushIntervalSeconds !== null ? String(cfg.pushIntervalSeconds) : '');
  const [heartbeat, setHeartbeat] = useState<boolean | null>(cfg.heartbeatMonitoring);
  const [maxMissed, setMaxMissed] = useState<string>(cfg.maxMissedPushes !== null ? String(cfg.maxMissedPushes) : '');
  const [saving, setSaving] = useState(false);

  // Notification types draft: null = inherit from parent / system defaults
  const [notifTypes, setNotifTypes] = useState<NotificationTypeConfig | null>(cfg.notificationTypes ?? null);
  const [savingNotif, setSavingNotif] = useState(false);

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const updated = await groupsApi.updateAgentGroupConfig(group.id, {
        agentGroupConfig: {
          pushIntervalSeconds: interval.trim() ? Number(interval) : null,
          heartbeatMonitoring: heartbeat,
          maxMissedPushes: maxMissed.trim() ? Number(maxMissed) : null,
          notificationTypes: cfg.notificationTypes, // preserve existing notifTypes
        },
      });
      onUpdate(updated);
      toast.success(t('groups.detail.saveSettings'));
    } catch { toast.error(t('groups.failedUpdate')); }
    finally { setSaving(false); }
  };

  const handleSaveNotifTypes = async (override?: NotificationTypeConfig | null) => {
    const typesToSave = override !== undefined ? override : notifTypes;
    setSavingNotif(true);
    try {
      const updated = await groupsApi.updateAgentGroupConfig(group.id, {
        agentGroupConfig: {
          pushIntervalSeconds: cfg.pushIntervalSeconds,
          heartbeatMonitoring: cfg.heartbeatMonitoring,
          maxMissedPushes: cfg.maxMissedPushes,
          notificationTypes: typesToSave,
        },
      });
      onUpdate(updated);
      toast.success(t('groups.detail.saveSettings'));
    } catch { toast.error(t('groups.failedUpdate')); }
    finally { setSavingNotif(false); }
  };

  const handleSaveThresholds = async (thresholds: AgentThresholds) => {
    const updated = await groupsApi.updateAgentGroupConfig(group.id, { agentThresholds: thresholds });
    onUpdate(updated);
  };

  // When override is activated: start with system defaults
  const handleEnableNotifOverride = () => {
    setNotifTypes({
      global: DEFAULT_NOTIFICATION_TYPES.global,
      down:   DEFAULT_NOTIFICATION_TYPES.down,
      up:     DEFAULT_NOTIFICATION_TYPES.up,
      alert:  DEFAULT_NOTIFICATION_TYPES.alert,
      update: DEFAULT_NOTIFICATION_TYPES.update,
    });
  };

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-6">
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
        {t('groups.detail.agentSettings')}
      </h2>

      {/* Push Interval */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-text-primary">{t('groups.detail.pushInterval')}</div>
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
          <div className="text-sm font-medium text-text-primary">{t('groups.detail.heartbeatMonitoring')}</div>
          <div className="text-xs text-text-muted">{t('groups.detail.heartbeatMonitoringDesc')}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">{heartbeat === null ? t('common.inherit') : heartbeat ? t('common.on') : t('common.off')}</span>
          <Switch on={heartbeat ?? false} onChange={v => setHeartbeat(v)} />
          {heartbeat !== null && (
            <button onClick={() => setHeartbeat(null)} className="text-xs text-text-muted hover:text-text-primary" title={t('common.reset')}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Max Missed Pushes */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-text-primary">{t('groups.detail.maxMissedPushes')}</div>
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

      {/* ── Notification Types ── */}
      <div className="border-t border-border pt-4">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wide flex items-center gap-1.5">
            <Bell size={11} /> Notification Types
          </div>
          {notifTypes === null ? (
            <button
              onClick={handleEnableNotifOverride}
              className="px-2.5 py-1 text-xs rounded border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors"
            >
              Override
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => { setNotifTypes(null); await handleSaveNotifTypes(null); }}
                className="text-xs text-text-muted hover:text-text-primary transition-colors"
                title="Reset to inherited"
              >
                <X size={12} />
              </button>
              <button
                onClick={() => handleSaveNotifTypes()}
                disabled={savingNotif}
                className="px-2.5 py-1 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors"
              >
                {savingNotif ? t('common.saving') : t('common.save')}
              </button>
            </div>
          )}
        </div>

        {notifTypes === null ? (
          <p className="text-xs text-text-muted italic">
            Inheriting from parent group or system defaults (Global: on, Down: on, Up: on, Alert: on, Update: off)
          </p>
        ) : (
          <div className="space-y-3">
            {NOTIF_TYPE_ROWS.map(({ key, label, desc }) => {
              const val = notifTypes[key] ?? DEFAULT_NOTIFICATION_TYPES[key];
              return (
                <div key={key} className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-text-primary">{label}</div>
                    <div className="text-xs text-text-muted">{desc}</div>
                  </div>
                  <Switch
                    on={val}
                    onChange={v => setNotifTypes(prev => ({ ...prev!, [key]: v }))}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Divider */}
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

interface GroupStats {
  total: number;
  up: number;
  down: number;
  uptimePct: number;
  avgResponseTime: number | null;
  monitorCount: number;
  downMonitorNames: string[];
}

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
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('24h');
  const [periodHeartbeats, setPeriodHeartbeats] = useState<Heartbeat[]>([]);
  const [stats, setStats] = useState<GroupStats | null>(null);

  const isAgentGroup = group?.kind === 'agent';

  // Fetch group + monitors on mount
  useEffect(() => {
    async function loadData() {
      try {
        const [g, m] = await Promise.all([
          groupsApi.getById(groupId),
          groupsApi.getMonitors(groupId, true),
        ]);
        setGroup(g);
        setMonitors(m);
      } catch {
        // group may come from store
      }
      setLoading(false);
    }
    loadData();
  }, [groupId]);

  // Fetch heartbeats + stats by period (only for monitor groups)
  useEffect(() => {
    if (isAgentGroup) return;
    Promise.all([
      groupsApi.getHeartbeats(groupId, period),
      groupsApi.getDetailStats(groupId, period),
    ]).then(([hbs, s]) => {
      setPeriodHeartbeats(hbs);
      setStats(s);
    }).catch(() => {
      setPeriodHeartbeats([]);
      setStats(null);
    });
  }, [groupId, period, isAgentGroup]);

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

  const handlePauseAll = async () => {
    const active = monitors.filter((m) => m.status !== 'paused');
    if (active.length === 0) { toast(t('groups.noActive')); return; }
    try {
      await Promise.all(active.map((m) => monitorsApi.pause(m.id)));
      toast.success(t('groups.pausedAll', { count: active.length }));
      const m = await groupsApi.getMonitors(groupId, true);
      setMonitors(m);
    } catch { toast.error(t('groups.failedPause')); }
  };

  const handleResumeAll = async () => {
    const paused = monitors.filter((m) => m.status === 'paused');
    if (paused.length === 0) { toast(t('groups.noPaused')); return; }
    try {
      await Promise.all(paused.map((m) => monitorsApi.pause(m.id)));
      toast.success(t('groups.resumedAll', { count: paused.length }));
      const m = await groupsApi.getMonitors(groupId, true);
      setMonitors(m);
    } catch { toast.error(t('groups.failedResume')); }
  };

  const handleClearHeartbeats = async () => {
    if (!confirm(t('groups.confirmClear', { name: group.name }))) return;
    try {
      const result = await groupsApi.clearHeartbeats(groupId);
      toast.success(t('groups.cleared', { heartbeats: result.deleted, monitors: result.monitorCount }));
      setPeriodHeartbeats([]);
    } catch { toast.error(t('groups.failedClear')); }
  };

  const pausedCount = monitors.filter((m) => m.status === 'paused').length;
  const hasPaused = pausedCount > 0;
  const agentStats = isAgentGroup ? computeAgentGroupStats(monitors) : null;

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
            {!isAgentGroup && (hasPaused ? (
              <Button variant="secondary" size="sm" onClick={handleResumeAll}>
                <Play size={14} className="mr-1.5" />
                {t('groups.detail.resumeAll')}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={handlePauseAll}>
                <Pause size={14} className="mr-1.5" />
                {t('groups.detail.pauseAll')}
              </Button>
            ))}
            <Button variant="secondary" size="sm" onClick={handleClearHeartbeats}>
              <RotateCcw size={14} className="mr-1.5" />
              {t('groups.detail.clearData')}
            </Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>
              <Trash2 size={14} className="mr-1.5" />
              {t('common.delete')}
            </Button>
          </div>
        )}
      </div>

      {/* ── Agent group stats ── */}
      {isAgentGroup && agentStats && (
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('groups.detail.totalAgents')}</div>
            <div className="text-xl font-mono font-semibold text-text-primary">{agentStats.total}</div>
          </div>
          <div className="rounded-lg border border-status-up/30 bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('groups.detail.online')}</div>
            <div className="text-xl font-mono font-semibold text-status-up">{agentStats.online}</div>
          </div>
          {agentStats.alert > 0 && (
            <div className="rounded-lg border border-orange-500/30 bg-bg-secondary p-4">
              <div className="text-sm text-text-secondary mb-1">{t('groups.detail.alert')}</div>
              <div className="text-xl font-mono font-semibold text-orange-400">{agentStats.alert}</div>
              <div className="text-xs text-text-muted mt-0.5 truncate">{agentStats.alertAgentNames.join(', ')}</div>
            </div>
          )}
          {agentStats.offline > 0 && (
            <div className="rounded-lg border border-status-down/30 bg-bg-secondary p-4">
              <div className="text-sm text-text-secondary mb-1">{t('groups.detail.offline')}</div>
              <div className="text-xl font-mono font-semibold text-status-down">{agentStats.offline}</div>
              <div className="text-xs text-text-muted mt-0.5 truncate">{agentStats.offlineAgentNames.join(', ')}</div>
            </div>
          )}
          {agentStats.pending > 0 && (
            <div className="rounded-lg border border-yellow-500/30 bg-bg-secondary p-4">
              <div className="text-sm text-text-secondary mb-1">{t('groups.detail.pending')}</div>
              <div className="text-xl font-mono font-semibold text-yellow-400">{agentStats.pending}</div>
            </div>
          )}
        </div>
      )}

      {/* ── Monitor group stats ── */}
      {!isAgentGroup && stats && (
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('groups.detail.uptime')}</div>
            <div className={cn('text-xl font-mono font-semibold',
              stats.uptimePct >= 99 ? 'text-status-up' : stats.uptimePct >= 95 ? 'text-yellow-500' : 'text-status-down'
            )}>
              {stats.uptimePct}%
            </div>
          </div>
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('groups.detail.monitors')}</div>
            <div className="text-xl font-mono font-semibold text-text-primary">{stats.monitorCount}</div>
            <div className="text-xs text-text-muted mt-0.5">
              {stats.monitorCount - stats.downMonitorNames.length} up / {stats.downMonitorNames.length} down
            </div>
          </div>
          {stats.downMonitorNames.length > 0 && (
            <div className="rounded-lg border border-status-down/30 bg-status-down-bg p-4">
              <div className="text-sm text-text-secondary mb-1">{t('groups.detail.downMonitors')}</div>
              <div className="text-xl font-mono font-semibold text-status-down">{stats.downMonitorNames.length}</div>
              <div className="text-xs text-text-muted mt-0.5 truncate">{stats.downMonitorNames.join(', ')}</div>
            </div>
          )}
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('groups.detail.avgResponse')}</div>
            <div className="text-xl font-mono font-semibold text-text-primary">
              {stats.avgResponseTime ? `${stats.avgResponseTime}ms` : t('common.na')}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('groups.detail.totalChecks')}</div>
            <div className="text-xl font-mono font-semibold text-text-primary">{stats.total.toLocaleString()}</div>
          </div>
        </div>
      )}

      {/* ── Monitor group charts ── */}
      {!isAgentGroup && (
        <>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">{t('monitors.history')}</h3>
            <PeriodSelector value={period} onChange={setPeriod} />
          </div>
          <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">{t('monitors.heartbeatHistory')}</h3>
            <HeartbeatBar heartbeats={periodHeartbeats} />
          </div>
          <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">{t('monitors.responseTime')}</h3>
            <HeartbeatChart heartbeats={periodHeartbeats} height={250} period={period} />
          </div>
        </>
      )}

      {/* ── Agent list (for agent groups) ── */}
      {isAgentGroup && monitors.length > 0 && (
        <div className="mb-6 rounded-lg border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">{t('groups.detail.agentList', { count: monitors.filter(m => m.type === 'agent').length })}</h3>
          </div>
          <div className="divide-y divide-border">
            {monitors.filter(m => m.type === 'agent').map(m => (
              <Link
                key={m.id}
                to={m.agentDeviceId ? `/agents/${m.agentDeviceId}` : '#'}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors"
              >
                <MonitorStatusBadge status={m.status} size="sm" inMaintenance={m.inMaintenance} />
                <span className="flex-1 text-sm text-text-primary truncate">{m.name}</span>
                <span className="text-xs text-text-muted">{t('common.agent')}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Monitor list (for monitor groups) ── */}
      {!isAgentGroup && monitors.length > 0 && (
        <div className="mb-6 rounded-lg border border-border bg-bg-secondary">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              {t('groups.detail.monitorList', { count: monitors.length })}
            </h3>
          </div>
          <div className="divide-y divide-border">
            {monitors.map((m) => (
              <Link
                key={m.id}
                to={`/monitor/${m.id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors"
              >
                <MonitorStatusBadge status={m.status} size="sm" inMaintenance={m.inMaintenance} />
                <span className="flex-1 text-sm text-text-primary truncate">{m.name}</span>
                <span className="text-xs text-text-muted">{MONITOR_TYPE_LABELS[m.type]}</span>
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

      {/* Remediation Bindings (admin only) */}
      {isAdmin() && (
        <div className="mt-6">
          <RemediationBindingsPanel
            scope="group"
            scopeId={groupId}
            title={t('monitors.sectionRemediations')}
          />
        </div>
      )}

      {/* Maintenance Windows (admin only) */}
      {isAdmin() && (
        <div className="mt-4 rounded-lg border border-border bg-bg-secondary p-4">
          <MaintenanceWindowList
            scopeType="group"
            scopeId={groupId}
            channels={[]}
            defaultScopeType="group"
            defaultScopeId={groupId}
          />
        </div>
      )}

      {/* ── Agent group settings ── */}
      {isAdmin() && isAgentGroup && (
        <div className="mt-6">
          <AgentGroupSettingsPanel group={group} onUpdate={setGroup} />
        </div>
      )}

      {/* ── Monitor group settings ── */}
      {isAdmin() && !isAgentGroup && (
        <div className="mt-6">
          <SettingsPanel
            scope="group"
            scopeId={groupId}
            title={t('monitors.sectionSettings')}
          />
        </div>
      )}
    </div>
  );
}
