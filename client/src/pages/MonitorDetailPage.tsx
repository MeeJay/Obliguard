import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Pencil, Pause, Play, Trash2, ArrowLeft, Copy, ShieldAlert, ShieldX, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useMonitorStore } from '@/store/monitorStore';
import { useAuthStore } from '@/store/authStore';
import { monitorsApi } from '@/api/monitors.api';
import { MONITOR_TYPE_LABELS } from '@obliview/shared';
import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';
import { HeartbeatChart } from '@/components/monitors/HeartbeatChart';
import { HeartbeatBar } from '@/components/monitors/HeartbeatBar';
import { UptimePercentage } from '@/components/monitors/UptimePercentage';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PeriodSelector } from '@/components/common/PeriodSelector';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { NotificationBindingsPanel } from '@/components/notifications/NotificationBindingsPanel';
import { RemediationBindingsPanel } from '@/components/remediation/RemediationBindingsPanel';
import { MaintenanceWindowList } from '@/components/maintenance/MaintenanceWindowList';
import type { Heartbeat, NotificationChannel } from '@obliview/shared';
import toast from 'react-hot-toast';

export function MonitorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { isAdmin, canWriteMonitor } = useAuthStore();
  const { getMonitor, getRecentHeartbeats, setHeartbeats, updateMonitor, removeMonitor } =
    useMonitorStore();

  const monitorId = parseInt(id!, 10);
  const monitor = getMonitor(monitorId);
  const heartbeats = getRecentHeartbeats(monitorId);
  const canWrite = monitor ? canWriteMonitor(monitorId, monitor.groupId ?? null) : false;
  const [loading, setLoading] = useState(!monitor);
  const [period, setPeriod] = useState('24h');
  const [maintenanceScopeOptions, setMaintenanceScopeOptions] = useState<Array<{ id: number; name: string; type: 'monitor' | 'agent' | 'group' }>>([]);
  const [maintenanceChannels, setMaintenanceChannels] = useState<NotificationChannel[]>([]);
  const [periodHeartbeats, setPeriodHeartbeats] = useState<Heartbeat[]>([]);
  const [zoomRange, setZoomRange] = useState<{ from: Date; to: Date } | null>(null);
  const [zoomHeartbeats, setZoomHeartbeats] = useState<Heartbeat[]>([]);

  // Fetch heartbeat history on mount (for store)
  useEffect(() => {
    async function loadData() {
      try {
        const hbs = await monitorsApi.getHeartbeats(monitorId, 100);
        // API returns DESC (newest first), reverse to chronological (oldest → newest)
        setHeartbeats(monitorId, hbs.reverse());
      } catch {
        // Monitor data might come from store via socket
      }
      setLoading(false);
    }
    loadData();
  }, [monitorId, setHeartbeats]);

  // Fetch maintenance scope options + channels (admin only)
  useEffect(() => {
    if (!isAdmin()) return;
    Promise.all([
      fetch('/api/monitors').then((r) => r.json()),
      fetch('/api/notifications/channels').then((r) => r.json()),
    ]).then(([mon, ch]) => {
      if (mon.success) setMaintenanceScopeOptions(mon.data.map((m: { id: number; name: string }) => ({ id: m.id, name: m.name, type: 'monitor' as const })));
      if (ch.success) setMaintenanceChannels(ch.data);
    }).catch(() => {});
  }, [isAdmin]);

  // Fetch heartbeats by period for chart/bar display
  useEffect(() => {
    monitorsApi
      .getHeartbeatsByPeriod(monitorId, period as '1h' | '24h' | '7d' | '30d' | '365d')
      .then(setPeriodHeartbeats)
      .catch(() => setPeriodHeartbeats([]));
    // Changing period always resets zoom
    setZoomRange(null);
    setZoomHeartbeats([]);
  }, [monitorId, period]);

  // Fetch zoomed heartbeats when zoom range changes
  useEffect(() => {
    if (!zoomRange) return;
    monitorsApi
      .getHeartbeatsByRange(monitorId, zoomRange.from, zoomRange.to)
      .then(setZoomHeartbeats)
      .catch(() => setZoomHeartbeats([]));
  }, [monitorId, zoomRange]);

  if (loading && !monitor) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!monitor) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-text-muted">{t('monitors.notFound')}</p>
        <Link to="/" className="mt-4">
          <Button variant="secondary">{t('monitors.backToDashboard')}</Button>
        </Link>
      </div>
    );
  }

  const handlePause = async () => {
    try {
      const result = await monitorsApi.pause(monitorId);
      updateMonitor(monitorId, { status: result.status as any });
      toast.success(result.status === 'paused' ? t('monitors.paused') : t('monitors.resumed'));
    } catch {
      toast.error(t('monitors.failedPause'));
    }
  };

  const handleClone = () => {
    // Copy monitor data, strip unique fields, add "(Copy)" to name
    const { id: _id, createdAt: _ca, updatedAt: _ua, pushToken: _pt, status: _st, createdBy: _cb, ...cloneData } = monitor;
    navigate('/monitor/new', {
      state: { cloneData: { ...cloneData, name: `${monitor.name}${t('monitors.cloneSuffix')}` } },
    });
  };

  const handleDelete = async () => {
    if (!confirm(t('monitors.confirmDelete', { name: monitor.name }))) return;
    try {
      await monitorsApi.delete(monitorId);
      removeMonitor(monitorId);
      toast.success(t('monitors.deleted'));
      navigate('/');
    } catch {
      toast.error(t('monitors.failedDelete'));
    }
  };

  const lastHeartbeat = heartbeats[heartbeats.length - 1];

  // Determine if this monitor checks SSL certificates
  const isHttps =
    (monitor.type === 'http' || monitor.type === 'json_api') &&
    monitor.url?.startsWith('https://') &&
    !monitor.ignoreSsl;

  // Parse SSL info from the heartbeat message
  // Messages look like: "... | SSL OK, expires in 45 days (2025-08-15)"
  // or "SSL certificate expires in 12 days (2025-04-01) — threshold: 30 days"
  // or "SSL certificate expired 5 days ago (2025-02-01)"
  let sslDaysRemaining: number | null = null;
  let sslExpiryDate: string | null = null;
  if (isHttps && lastHeartbeat?.message) {
    const msg = lastHeartbeat.message;
    const expiresIn = msg.match(/expires in (\d+) days? \((\d{4}-\d{2}-\d{2})\)/);
    const expiredAgo = msg.match(/expired (\d+) days? ago \((\d{4}-\d{2}-\d{2})\)/);
    if (expiresIn) {
      sslDaysRemaining = parseInt(expiresIn[1], 10);
      sslExpiryDate = expiresIn[2];
    } else if (expiredAgo) {
      sslDaysRemaining = -parseInt(expiredAgo[1], 10);
      sslExpiryDate = expiredAgo[2];
    }
  }

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
          <MonitorStatusBadge status={monitor.status} size="lg" inMaintenance={monitor.inMaintenance} />
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{monitor.name}</h1>
            <p className="text-sm text-text-secondary">
              {MONITOR_TYPE_LABELS[monitor.type]}
              {(monitor.type === 'http' || monitor.type === 'json_api') && monitor.url && ` - ${monitor.url}`}
              {(['ping', 'tcp', 'dns', 'ssl', 'smtp'].includes(monitor.type)) && monitor.hostname && ` - ${monitor.hostname}${monitor.port ? `:${monitor.port}` : ''}`}
              {monitor.type === 'docker' && monitor.dockerContainerName && ` - ${monitor.dockerContainerName}`}
              {monitor.type === 'game_server' && monitor.gameHost && ` - ${monitor.gameHost}${monitor.gamePort ? `:${monitor.gamePort}` : ''}`}
              {monitor.type === 'push' && ' - Push'}
              {monitor.type === 'script' && monitor.scriptCommand && ` - ${monitor.scriptCommand}`}
              {monitor.type === 'browser' && monitor.browserUrl && ` - ${monitor.browserUrl}`}
              {monitor.type === 'value_watcher' && monitor.valueWatcherUrl && ` - ${monitor.valueWatcherUrl}`}
            </p>
          </div>
        </div>

        {canWrite && (
          <div className="flex items-center gap-2">
            <Link to={`/monitor/${monitorId}/edit`}>
              <Button variant="secondary" size="sm">
                <Pencil size={14} className="mr-1.5" />
                {t('monitors.edit')}
              </Button>
            </Link>
            <Button variant="secondary" size="sm" onClick={handleClone}>
              <Copy size={14} className="mr-1.5" />
              {t('monitors.clone')}
            </Button>
            <Button variant="secondary" size="sm" onClick={handlePause}>
              {monitor.status === 'paused' ? (
                <><Play size={14} className="mr-1.5" />{t('monitors.resumeMonitor')}</>
              ) : (
                <><Pause size={14} className="mr-1.5" />{t('monitors.pauseMonitor')}</>
              )}
            </Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>
              <Trash2 size={14} className="mr-1.5" />
              {t('monitors.deleteMonitor')}
            </Button>
          </div>
        )}
      </div>

      {/* SSL Warning/Expired banner */}
      {monitor.status === 'ssl_warning' && lastHeartbeat?.message && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-status-ssl-warning/30 bg-status-ssl-warning-bg px-4 py-3">
          <ShieldAlert size={20} className="shrink-0 text-status-ssl-warning" />
          <div>
            <p className="text-sm font-semibold text-status-ssl-warning">{t('monitors.stats.sslWarn')}</p>
            <p className="text-sm text-text-secondary">{lastHeartbeat.message}</p>
          </div>
        </div>
      )}
      {monitor.status === 'ssl_expired' && lastHeartbeat?.message && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-status-ssl-expired/30 bg-status-ssl-expired-bg px-4 py-3">
          <ShieldX size={20} className="shrink-0 text-status-ssl-expired" />
          <div>
            <p className="text-sm font-semibold text-status-ssl-expired">{t('monitors.stats.sslExpired')}</p>
            <p className="text-sm text-text-secondary">{lastHeartbeat.message}</p>
          </div>
        </div>
      )}

      {/* Stats row — responsive auto-fit grid */}
      <div
        className="grid gap-4 mb-6"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
      >
        {monitor.type === 'value_watcher' ? (
          <div className="rounded-lg border border-accent/30 bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('monitors.stats.currentValue')}</div>
            <div className="text-xl font-mono font-semibold text-accent">
              {lastHeartbeat?.value != null
                ? (() => { const n = Number(lastHeartbeat.value); return isNaN(n) ? lastHeartbeat.value : n.toLocaleString(); })()
                : t('common.na')}
            </div>
            {monitor.valueWatcherJsonPath && (
              <div className="text-xs text-text-muted mt-0.5">{monitor.valueWatcherJsonPath}</div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('monitors.stats.responseTime')}</div>
            <div className="text-xl font-mono font-semibold text-text-primary">
              {lastHeartbeat?.responseTime ? `${lastHeartbeat.responseTime}ms` : t('common.na')}
            </div>
          </div>
        )}
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <UptimePercentage heartbeats={heartbeats} label={t('monitors.stats.uptime')} />
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="text-sm text-text-secondary mb-1">{t('monitors.stats.totalChecks')}</div>
          <div className="text-xl font-mono font-semibold text-text-primary">
            {heartbeats.length}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="text-sm text-text-secondary mb-1">{t('monitors.stats.lastCheck')}</div>
          <div className="text-sm font-mono text-text-primary">
            {lastHeartbeat ? new Date(lastHeartbeat.createdAt).toLocaleString() : t('common.never')}
          </div>
        </div>
        {isHttps && (
          <div
            className={cn(
              'rounded-lg border p-4',
              sslDaysRemaining !== null && sslDaysRemaining < 0
                ? 'border-status-ssl-expired/30 bg-status-ssl-expired-bg'
                : sslDaysRemaining !== null && sslDaysRemaining < (monitor.sslWarnDays ?? 30)
                  ? 'border-status-ssl-warning/30 bg-status-ssl-warning-bg'
                  : 'border-border bg-bg-secondary',
            )}
          >
            <div className="flex items-center gap-1.5 text-sm text-text-secondary mb-1">
              {sslDaysRemaining !== null && sslDaysRemaining < 0 ? (
                <ShieldX size={14} className="text-status-ssl-expired" />
              ) : sslDaysRemaining !== null && sslDaysRemaining < (monitor.sslWarnDays ?? 30) ? (
                <ShieldAlert size={14} className="text-status-ssl-warning" />
              ) : (
                <ShieldCheck size={14} className="text-status-up" />
              )}
              {t('monitors.stats.sslCert')}
            </div>
            <div
              className={cn(
                'text-xl font-mono font-semibold',
                sslDaysRemaining !== null && sslDaysRemaining < 0
                  ? 'text-status-ssl-expired'
                  : sslDaysRemaining !== null && sslDaysRemaining < (monitor.sslWarnDays ?? 30)
                    ? 'text-status-ssl-warning'
                    : 'text-status-up',
              )}
            >
              {sslDaysRemaining !== null
                ? sslDaysRemaining < 0
                  ? `Expired ${Math.abs(sslDaysRemaining)}d ago`
                  : `${sslDaysRemaining}d left`
                : t('common.na')}
            </div>
            {sslExpiryDate && (
              <div className="text-xs text-text-muted mt-0.5">{sslExpiryDate}</div>
            )}
          </div>
        )}
      </div>

      {/* Period selector */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
          {t('monitors.history')}{zoomRange && <span className="ml-2 text-xs text-cyan-400 font-normal normal-case tracking-normal">— {t('monitors.zoomed')}</span>}
        </h3>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {/* Heartbeat Bar */}
      <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">{t('monitors.heartbeatHistory')}</h3>
        <HeartbeatBar heartbeats={periodHeartbeats.length > 0 ? periodHeartbeats : heartbeats} />
      </div>

      {/* Response Time / Value Chart */}
      <div className="rounded-lg border border-border bg-bg-secondary p-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
          {monitor.type === 'value_watcher' ? t('monitors.valueHistory') : t('monitors.responseTime')}
        </h3>
        <HeartbeatChart
          heartbeats={
            zoomRange
              ? zoomHeartbeats
              : (periodHeartbeats.length > 0 ? periodHeartbeats : heartbeats)
          }
          height={250}
          period={period}
          valueMode={monitor.type === 'value_watcher'}
          onZoom={monitor.type !== 'value_watcher'
            ? (from, to) => setZoomRange({ from, to })
            : undefined}
          isZoomed={!!zoomRange}
          onZoomReset={() => { setZoomRange(null); setZoomHeartbeats([]); }}
          customRange={zoomRange ?? undefined}
        />
      </div>

      {/* Monitor Info */}
      {monitor.description && (
        <div className="mt-6 rounded-lg border border-border bg-bg-secondary p-4">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">{t('monitors.sectionDescription')}</h3>
          <p className="text-sm text-text-primary">{monitor.description}</p>
        </div>
      )}

      {/* Notification Bindings (admin only) */}
      {isAdmin() && (
        <div className="mt-6">
          <NotificationBindingsPanel
            scope="monitor"
            scopeId={monitorId}
            title={t('monitors.sectionNotifications')}
          />
        </div>
      )}

      {/* Remediation Bindings (admin only) */}
      {isAdmin() && (
        <div className="mt-4">
          <RemediationBindingsPanel
            scope="monitor"
            scopeId={monitorId}
            groupId={monitor?.groupId ?? null}
          />
        </div>
      )}

      {/* Maintenance Windows (admin only) */}
      {isAdmin() && (
        <div className="mt-4 rounded-lg border border-border bg-bg-secondary p-4">
          <MaintenanceWindowList
            scopeType="monitor"
            scopeId={monitorId}
            scopeOptions={maintenanceScopeOptions}
            channels={maintenanceChannels}
            defaultScopeType="monitor"
            defaultScopeId={monitorId}
          />
        </div>
      )}

      {/* Settings (admin only) */}
      {isAdmin() && (
        <div className="mt-6">
          <SettingsPanel
            scope="monitor"
            scopeId={monitorId}
            title={t('monitors.sectionSettings')}
          />
        </div>
      )}
    </div>
  );
}
