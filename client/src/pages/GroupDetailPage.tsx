import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Pencil, Pause, Play, Trash2, ArrowLeft, FolderOpen, RotateCcw, Bell, Globe,
  Server, Settings2, Thermometer, X,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { groupsApi } from '@/api/groups.api';
import { monitorsApi } from '@/api/monitors.api';
import { MONITOR_TYPE_LABELS } from '@obliview/shared';
import type {
  MonitorGroup, Monitor, Heartbeat,
  AgentThresholds, AgentMetricThreshold, AgentTempThreshold,
} from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS } from '@obliview/shared';
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
    try { await onSave({ ...values, temp: tempValues }); toast.success('Thresholds saved'); }
    catch { toast.error('Failed to save thresholds'); }
    finally { setSaving(false); }
  };

  const metricRows: Array<{ key: keyof Omit<AgentThresholds, 'temp'>; label: string; unit: string; scale?: number }> = [
    { key: 'cpu',    label: 'CPU',        unit: '%' },
    { key: 'memory', label: 'Memory',     unit: '%' },
    { key: 'disk',   label: 'Disk (any)', unit: '%' },
    { key: 'netIn',  label: 'Net In',     unit: 'Mbps', scale: BYTES_PER_MBIT },
    { key: 'netOut', label: 'Net Out',    unit: 'Mbps', scale: BYTES_PER_MBIT },
  ];

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase text-text-muted border-b border-border">
            <th className="text-left pb-2 font-medium">Metric</th>
            <th className="text-center pb-2 font-medium w-12">On</th>
            <th className="text-center pb-2 font-medium w-16">Op</th>
            <th className="text-left pb-2 font-medium">Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {metricRows.map(({ key, label, unit, scale }) => (
            <tr key={key} className={values[key].enabled ? '' : 'opacity-50'}>
              <td className="py-2.5 font-medium text-text-secondary">{label}</td>
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
          <Thermometer size={11} /> Temperatures
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase text-text-muted border-b border-border">
              <th className="text-left pb-2 font-medium">Metric</th>
              <th className="text-center pb-2 font-medium w-12">On</th>
              <th className="text-center pb-2 font-medium w-16">Op</th>
              <th className="text-left pb-2 font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            <tr className={tempValues.globalEnabled ? '' : 'opacity-50'}>
              <td className="py-2.5 font-medium text-text-secondary">Temperature (global)</td>
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
          {saving ? 'Saving…' : 'Save Thresholds'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Group Settings Panel
// ─────────────────────────────────────────────────────────────────────────────

function AgentGroupSettingsPanel({ group, onUpdate }: { group: MonitorGroup; onUpdate: (g: MonitorGroup) => void }) {
  const cfg = group.agentGroupConfig ?? { pushIntervalSeconds: null, heartbeatMonitoring: null, maxMissedPushes: null };
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
        },
      });
      onUpdate(updated);
      toast.success('Agent group settings saved');
    } catch { toast.error('Failed to save settings'); }
    finally { setSaving(false); }
  };

  const handleSaveThresholds = async (t: AgentThresholds) => {
    const updated = await groupsApi.updateAgentGroupConfig(group.id, { agentThresholds: t });
    onUpdate(updated);
  };

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-6">
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
        Agent Group Settings
      </h2>

      {/* Push Interval */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-text-primary">Default Push Interval</div>
          <div className="text-xs text-text-muted">Applied to new agents in this group (empty = device default)</div>
        </div>
        <div className="flex items-center gap-2">
          <input type="number" value={interval} min={1} max={86400}
            onChange={e => setInterval(e.target.value)}
            placeholder="60"
            className="w-24 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-right placeholder:text-text-muted" />
          <span className="text-xs text-text-muted">s</span>
        </div>
      </div>

      {/* Heartbeat Monitoring */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-text-primary">Default Heartbeat Monitoring</div>
          <div className="text-xs text-text-muted">Alert when agents go offline (null = device default)</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">{heartbeat === null ? 'Inherit' : heartbeat ? 'On' : 'Off'}</span>
          <Switch on={heartbeat ?? false} onChange={v => setHeartbeat(v)} />
          {heartbeat !== null && (
            <button onClick={() => setHeartbeat(null)} className="text-xs text-text-muted hover:text-text-primary" title="Reset to inherit">
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Max Missed Pushes */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-text-primary">Max Missed Pushes</div>
          <div className="text-xs text-text-muted">Consecutive missed pushes before marking offline (empty = 2)</div>
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
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>

      {/* Divider */}
      <div className="border-t border-border pt-4">
        <div className="text-xs font-medium text-text-muted uppercase tracking-wide mb-4 flex items-center gap-1.5">
          <Settings2 size={11} /> Default Alert Thresholds
          <span className="ml-1 text-text-muted font-normal normal-case">Inherited by agents in this group (overridable per agent)</span>
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
        <p className="text-text-muted">Group not found</p>
        <Link to="/" className="mt-4">
          <Button variant="secondary">Back to Dashboard</Button>
        </Link>
      </div>
    );
  }

  const handleDelete = async () => {
    if (!confirm(`Delete group "${group.name}" and all its sub-groups? Monitors will become ungrouped.`)) return;
    try {
      await groupsApi.delete(groupId);
      removeGroup(groupId);
      fetchGroups();
      fetchTree();
      toast.success('Group deleted');
      navigate('/');
    } catch {
      toast.error('Failed to delete group');
    }
  };

  const handlePauseAll = async () => {
    const active = monitors.filter((m) => m.status !== 'paused');
    if (active.length === 0) { toast('No active monitors to pause'); return; }
    try {
      await Promise.all(active.map((m) => monitorsApi.pause(m.id)));
      toast.success(`Paused ${active.length} monitors`);
      const m = await groupsApi.getMonitors(groupId, true);
      setMonitors(m);
    } catch { toast.error('Failed to pause monitors'); }
  };

  const handleResumeAll = async () => {
    const paused = monitors.filter((m) => m.status === 'paused');
    if (paused.length === 0) { toast('No paused monitors to resume'); return; }
    try {
      await Promise.all(paused.map((m) => monitorsApi.pause(m.id)));
      toast.success(`Resumed ${paused.length} monitors`);
      const m = await groupsApi.getMonitors(groupId, true);
      setMonitors(m);
    } catch { toast.error('Failed to resume monitors'); }
  };

  const handleClearHeartbeats = async () => {
    if (!confirm(`Clear all heartbeat/uptime data for group "${group.name}" and all its sub-groups? This cannot be undone.`)) return;
    try {
      const result = await groupsApi.clearHeartbeats(groupId);
      toast.success(`Cleared ${result.deleted} heartbeats from ${result.monitorCount} monitors`);
      setPeriodHeartbeats([]);
    } catch { toast.error('Failed to clear heartbeats'); }
  };

  const pausedCount = monitors.filter((m) => m.status === 'paused').length;
  const hasPaused = pausedCount > 0;
  const agentStats = isAgentGroup ? computeAgentGroupStats(monitors) : null;

  return (
    <div className="p-6">
      {/* Back button */}
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4">
        <ArrowLeft size={14} />
        Back to Dashboard
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
                  Agent Group
                </span>
              )}
              {group.isGeneral && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                  <Globe size={10} />
                  General
                </span>
              )}
              {group.groupNotifications && (
                <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/10 px-2 py-0.5 text-[10px] font-medium text-yellow-500">
                  <Bell size={10} />
                  Grouped Notifications
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
                Edit
              </Button>
            </Link>
            {!isAgentGroup && (hasPaused ? (
              <Button variant="secondary" size="sm" onClick={handleResumeAll}>
                <Play size={14} className="mr-1.5" />
                Resume All
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={handlePauseAll}>
                <Pause size={14} className="mr-1.5" />
                Pause All
              </Button>
            ))}
            <Button variant="secondary" size="sm" onClick={handleClearHeartbeats}>
              <RotateCcw size={14} className="mr-1.5" />
              Clear Data
            </Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>
              <Trash2 size={14} className="mr-1.5" />
              Delete
            </Button>
          </div>
        )}
      </div>

      {/* ── Agent group stats ── */}
      {isAgentGroup && agentStats && (
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">Total Agents</div>
            <div className="text-xl font-mono font-semibold text-text-primary">{agentStats.total}</div>
          </div>
          <div className="rounded-lg border border-status-up/30 bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">Online</div>
            <div className="text-xl font-mono font-semibold text-status-up">{agentStats.online}</div>
          </div>
          {agentStats.alert > 0 && (
            <div className="rounded-lg border border-orange-500/30 bg-bg-secondary p-4">
              <div className="text-sm text-text-secondary mb-1">Alert</div>
              <div className="text-xl font-mono font-semibold text-orange-400">{agentStats.alert}</div>
              <div className="text-xs text-text-muted mt-0.5 truncate">{agentStats.alertAgentNames.join(', ')}</div>
            </div>
          )}
          {agentStats.offline > 0 && (
            <div className="rounded-lg border border-status-down/30 bg-bg-secondary p-4">
              <div className="text-sm text-text-secondary mb-1">Offline</div>
              <div className="text-xl font-mono font-semibold text-status-down">{agentStats.offline}</div>
              <div className="text-xs text-text-muted mt-0.5 truncate">{agentStats.offlineAgentNames.join(', ')}</div>
            </div>
          )}
          {agentStats.pending > 0 && (
            <div className="rounded-lg border border-yellow-500/30 bg-bg-secondary p-4">
              <div className="text-sm text-text-secondary mb-1">Pending</div>
              <div className="text-xl font-mono font-semibold text-yellow-400">{agentStats.pending}</div>
            </div>
          )}
        </div>
      )}

      {/* ── Monitor group stats ── */}
      {!isAgentGroup && stats && (
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">Uptime</div>
            <div className={cn('text-xl font-mono font-semibold',
              stats.uptimePct >= 99 ? 'text-status-up' : stats.uptimePct >= 95 ? 'text-yellow-500' : 'text-status-down'
            )}>
              {stats.uptimePct}%
            </div>
          </div>
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">Monitors</div>
            <div className="text-xl font-mono font-semibold text-text-primary">{stats.monitorCount}</div>
            <div className="text-xs text-text-muted mt-0.5">
              {stats.monitorCount - stats.downMonitorNames.length} up / {stats.downMonitorNames.length} down
            </div>
          </div>
          {stats.downMonitorNames.length > 0 && (
            <div className="rounded-lg border border-status-down/30 bg-status-down-bg p-4">
              <div className="text-sm text-text-secondary mb-1">Down Monitors</div>
              <div className="text-xl font-mono font-semibold text-status-down">{stats.downMonitorNames.length}</div>
              <div className="text-xs text-text-muted mt-0.5 truncate">{stats.downMonitorNames.join(', ')}</div>
            </div>
          )}
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">Avg Response Time</div>
            <div className="text-xl font-mono font-semibold text-text-primary">
              {stats.avgResponseTime ? `${stats.avgResponseTime}ms` : 'N/A'}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">Total Checks</div>
            <div className="text-xl font-mono font-semibold text-text-primary">{stats.total.toLocaleString()}</div>
          </div>
        </div>
      )}

      {/* ── Monitor group charts ── */}
      {!isAgentGroup && (
        <>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">History</h3>
            <PeriodSelector value={period} onChange={setPeriod} />
          </div>
          <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Heartbeat History</h3>
            <HeartbeatBar heartbeats={periodHeartbeats} />
          </div>
          <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Response Time</h3>
            <HeartbeatChart heartbeats={periodHeartbeats} height={250} period={period} />
          </div>
        </>
      )}

      {/* ── Agent list (for agent groups) ── */}
      {isAgentGroup && monitors.length > 0 && (
        <div className="mb-6 rounded-lg border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Agents ({monitors.filter(m => m.type === 'agent').length})</h3>
          </div>
          <div className="divide-y divide-border">
            {monitors.filter(m => m.type === 'agent').map(m => (
              <Link
                key={m.id}
                to={m.agentDeviceId ? `/agents/${m.agentDeviceId}` : '#'}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors"
              >
                <MonitorStatusBadge status={m.status} size="sm" />
                <span className="flex-1 text-sm text-text-primary truncate">{m.name}</span>
                <span className="text-xs text-text-muted">Agent</span>
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
              Monitors ({monitors.length})
            </h3>
          </div>
          <div className="divide-y divide-border">
            {monitors.map((m) => (
              <Link
                key={m.id}
                to={`/monitor/${m.id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors"
              >
                <MonitorStatusBadge status={m.status} size="sm" />
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
            title="Notification Channels"
          />
        </div>
      )}

      {/* Remediation Bindings (admin only) */}
      {isAdmin() && (
        <div className="mt-6">
          <RemediationBindingsPanel
            scope="group"
            scopeId={groupId}
            title="Remediations"
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
            title="Group Settings"
          />
        </div>
      )}
    </div>
  );
}
