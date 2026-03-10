import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Pencil, Trash2, ArrowLeft, FolderOpen,
  Server, Bell, Globe, RotateCcw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { groupsApi } from '@/api/groups.api';
import { agentApi } from '@/api/agent.api';
import type {
  MonitorGroup, AgentDevice, AgentGroupConfig,
  NotificationTypeConfig,
} from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { NotificationBindingsPanel } from '@/components/notifications/NotificationBindingsPanel';
import { NotificationTypesPanel } from '@/components/agent/NotificationTypesPanel';
import { ServiceTemplatesPanel } from '@/components/agent/ServiceTemplatesPanel';
import toast from 'react-hot-toast';

// ─────────────────────────────────────────────────────────────────────────────
// Agent Group Settings Panel
// ─────────────────────────────────────────────────────────────────────────────

function AgentGroupSettingsPanel({ group, onUpdate }: { group: MonitorGroup; onUpdate: (g: MonitorGroup) => void }) {
  const { t } = useTranslation();

  const cfg: AgentGroupConfig = group.agentGroupConfig ?? {
    pushIntervalSeconds: null,
    maxMissedPushes: null,
    notificationTypes: null,
  };

  const [intervalVal, setIntervalVal] = useState<string>(
    cfg.pushIntervalSeconds !== null ? String(cfg.pushIntervalSeconds) : '',
  );
  const [maxMissedVal, setMaxMissedVal] = useState<string>(
    cfg.maxMissedPushes !== null ? String(cfg.maxMissedPushes) : '',
  );
  const [savingInterval, setSavingInterval] = useState(false);
  const [savingMaxMissed, setSavingMaxMissed] = useState(false);

  const isOverridingInterval = cfg.pushIntervalSeconds !== null;
  const isOverridingMaxMissed = cfg.maxMissedPushes !== null;

  async function saveConfig(patch: Partial<AgentGroupConfig>, setSaving: (v: boolean) => void) {
    setSaving(true);
    try {
      const updated = await groupsApi.updateAgentGroupConfig(group.id, {
        agentGroupConfig: {
          pushIntervalSeconds: cfg.pushIntervalSeconds,
          maxMissedPushes: cfg.maxMissedPushes,
          notificationTypes: cfg.notificationTypes,
          ...patch,
        },
      });
      onUpdate(updated);
    } catch {
      toast.error(t('groups.failedUpdate'));
    } finally {
      setSaving(false);
    }
  }

  // ── Push Interval handlers ──

  const handleOverrideInterval = () => {
    setIntervalVal('60');
    void saveConfig({ pushIntervalSeconds: 60 }, setSavingInterval);
  };

  const handleResetInterval = () => {
    setIntervalVal('');
    void saveConfig({ pushIntervalSeconds: null }, setSavingInterval);
  };

  const handleSaveInterval = () => {
    void saveConfig({ pushIntervalSeconds: Number(intervalVal) || 60 }, setSavingInterval);
  };

  // ── Max Missed Pushes handlers ──

  const handleOverrideMaxMissed = () => {
    setMaxMissedVal('2');
    void saveConfig({ maxMissedPushes: 2 }, setSavingMaxMissed);
  };

  const handleResetMaxMissed = () => {
    setMaxMissedVal('');
    void saveConfig({ maxMissedPushes: null }, setSavingMaxMissed);
  };

  const handleSaveMaxMissed = () => {
    void saveConfig({ maxMissedPushes: Number(maxMissedVal) || 2 }, setSavingMaxMissed);
  };

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-5">
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-1">
        {t('groups.detail.agentSettings')}
      </h2>
      <p className="text-xs text-text-muted mb-4">{t('groups.detail.agentSettingsDesc')}</p>

      <div className="divide-y divide-border">

        {/* ── Push Interval ── */}
        <div className="flex items-center gap-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">{t('groups.detail.pushInterval')}</span>
              {isOverridingInterval ? (
                <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                  Override
                </span>
              ) : (
                <span className="text-xs text-text-muted">Default</span>
              )}
            </div>
            <p className="text-xs text-text-muted mt-0.5">{t('groups.detail.pushIntervalDesc')}</p>
          </div>

          {isOverridingInterval ? (
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                value={intervalVal}
                min={1}
                max={86400}
                onChange={e => setIntervalVal(e.target.value)}
                className="w-20 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-right"
              />
              <span className="text-xs text-text-muted">s</span>
              <button
                onClick={handleSaveInterval}
                disabled={savingInterval}
                className="rounded-md px-2 py-1 text-xs font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                {t('common.save')}
              </button>
              <button
                onClick={handleResetInterval}
                disabled={savingInterval}
                className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/10 disabled:opacity-50 transition-colors flex items-center gap-1"
              >
                <RotateCcw size={12} />
                {t('common.reset')}
              </button>
            </div>
          ) : (
            <button
              onClick={handleOverrideInterval}
              disabled={savingInterval}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 transition-colors"
            >
              {t('common.override')}
            </button>
          )}
        </div>

        {/* ── Max Missed Pushes ── */}
        <div className="flex items-center gap-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">{t('groups.detail.maxMissedPushes')}</span>
              {isOverridingMaxMissed ? (
                <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                  Override
                </span>
              ) : (
                <span className="text-xs text-text-muted">Default</span>
              )}
            </div>
            <p className="text-xs text-text-muted mt-0.5">{t('groups.detail.maxMissedPushesDesc')}</p>
          </div>

          {isOverridingMaxMissed ? (
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                value={maxMissedVal}
                min={1}
                max={20}
                onChange={e => setMaxMissedVal(e.target.value)}
                className="w-16 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-right"
              />
              <button
                onClick={handleSaveMaxMissed}
                disabled={savingMaxMissed}
                className="rounded-md px-2 py-1 text-xs font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                {t('common.save')}
              </button>
              <button
                onClick={handleResetMaxMissed}
                disabled={savingMaxMissed}
                className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/10 disabled:opacity-50 transition-colors flex items-center gap-1"
              >
                <RotateCcw size={12} />
                {t('common.reset')}
              </button>
            </div>
          ) : (
            <button
              onClick={handleOverrideMaxMissed}
              disabled={savingMaxMissed}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 transition-colors"
            >
              {t('common.override')}
            </button>
          )}
        </div>

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

      {/* ── Notification Bindings (admin only) ── */}
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
              const cfg: AgentGroupConfig = group.agentGroupConfig ?? {
                pushIntervalSeconds: null,
                maxMissedPushes: null,
                notificationTypes: null,
              };
              const updated = await groupsApi.updateAgentGroupConfig(group.id, {
                agentGroupConfig: { ...cfg, notificationTypes: notifTypes },
              });
              setGroup(updated);
            }}
          />
        </div>
      )}

      {/* ── Service Templates — bind/unbind at group level ── */}
      {isAdmin() && isAgentGroup && (
        <div className="mt-6">
          <ServiceTemplatesPanel scope="group" scopeId={groupId} />
        </div>
      )}

      {/* ── Agent group settings (push interval, max missed pushes) ── */}
      {isAdmin() && isAgentGroup && (
        <div className="mt-6">
          <AgentGroupSettingsPanel group={group} onUpdate={setGroup} />
        </div>
      )}
    </div>
  );
}
