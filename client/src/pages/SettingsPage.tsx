import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { Shield, Server, Plus, Pencil, Trash2, Wifi, Eye, EyeOff, ArrowLeftRight, Info, Cpu, HardDrive, Database, Clock, Globe, RefreshCw } from 'lucide-react';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { NotificationTypesPanel } from '@/components/agent/NotificationTypesPanel';
import { useAuthStore } from '@/store/authStore';
import { smtpServerApi, type CreateSmtpServerRequest } from '@/api/smtpServer.api';
import { appConfigApi } from '@/api/appConfig.api';
import { systemApi, type SystemInfo } from '@/api/system.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import type { SmtpServer, AppConfig, AgentGlobalConfig, NotificationTypeConfig, ObligateConfig } from '@obliview/shared';
import { DEFAULT_AGENT_GLOBAL_CONFIG } from '@obliview/shared';
import toast from 'react-hot-toast';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="font-mono text-xs text-text-primary">{value}</span>
    </div>
  );
}

type SmtpFormMode = 'create' | 'edit' | null;

interface SmtpForm {
  name: string;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
}

const emptySmtpForm = (): SmtpForm => ({
  name: '',
  host: '',
  port: '587',
  secure: false,
  username: '',
  password: '',
  fromAddress: '',
});

export function SettingsPage() {
  const { t } = useTranslation();
  const { isAdmin } = useAuthStore();
  const admin = isAdmin();

  // ── SMTP Servers ──
  const [servers, setServers] = useState<SmtpServer[]>([]);
  const [smtpMode, setSmtpMode] = useState<SmtpFormMode>(null);
  const [editingServer, setEditingServer] = useState<SmtpServer | null>(null);
  const [smtpForm, setSmtpForm] = useState<SmtpForm>(emptySmtpForm());
  const [showPassword, setShowPassword] = useState(false);
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  // ── App Config (2FA) ──
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [configSaving, setConfigSaving] = useState(false);

  // ── System info (About section) ──
  const [systemInfo, setSystemInfo]               = useState<SystemInfo | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);

  // ── Obligate SSO Integration ──
  const [obligateCfg,     setObligateCfg]     = useState<ObligateConfig | null>(null);
  const [obligateUrl,     setObligateUrl]     = useState('');
  const [obligateApiKey,  setObligateApiKey]  = useState('');
  const [showObligateKey, setShowObligateKey] = useState(false);

  // ── Agent Global Config ──
  const [agentGlobal, setAgentGlobal] = useState<AgentGlobalConfig | null>(null);
  const [agentInterval, setAgentInterval] = useState('');
  const [agentMaxMissed, setAgentMaxMissed] = useState('');

  useEffect(() => {
    if (!admin) return;
    setSystemInfoLoading(true);
    systemApi.getInfo().then(setSystemInfo).catch(() => {}).finally(() => setSystemInfoLoading(false));
    smtpServerApi.list().then(setServers).catch(() => {});
    appConfigApi.getConfig().then(setAppConfig).catch(() => {});
    appConfigApi.getObligateConfig().then((cfg) => {
      setObligateCfg(cfg);
      setObligateUrl(cfg.url ?? '');
    }).catch(() => {});
    appConfigApi.getAgentGlobal().then((cfg) => {
      setAgentGlobal(cfg);
      setAgentInterval(cfg.checkIntervalSeconds !== null ? String(cfg.checkIntervalSeconds) : '');
      setAgentMaxMissed(cfg.maxMissedPushes !== null ? String(cfg.maxMissedPushes) : '');
    }).catch(() => {});
  }, [admin]);

  function openCreate() {
    setEditingServer(null);
    setSmtpForm(emptySmtpForm());
    setShowPassword(false);
    setSmtpMode('create');
  }

  function openEdit(server: SmtpServer) {
    setEditingServer(server);
    setSmtpForm({
      name: server.name,
      host: server.host,
      port: String(server.port),
      secure: server.secure,
      username: server.username,
      password: '',
      fromAddress: server.fromAddress,
    });
    setShowPassword(false);
    setSmtpMode('edit');
  }

  function closeSmtpModal() {
    setSmtpMode(null);
    setEditingServer(null);
  }

  async function handleSmtpSubmit(e: FormEvent) {
    e.preventDefault();
    setSmtpSaving(true);
    try {
      const data: CreateSmtpServerRequest = {
        name: smtpForm.name,
        host: smtpForm.host,
        port: parseInt(smtpForm.port, 10),
        secure: smtpForm.secure,
        username: smtpForm.username,
        password: smtpForm.password,
        fromAddress: smtpForm.fromAddress,
      };
      if (smtpMode === 'create') {
        const created = await smtpServerApi.create(data);
        setServers((prev) => [...prev, created]);
        toast.success(t('settings.smtp.created'));
      } else if (editingServer) {
        const payload = smtpForm.password ? data : { ...data, password: undefined };
        const updated = await smtpServerApi.update(editingServer.id, payload);
        setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        toast.success(t('settings.smtp.updated'));
      }
      closeSmtpModal();
    } catch {
      toast.error(t('settings.smtp.failedSave'));
    } finally {
      setSmtpSaving(false);
    }
  }

  async function handleDelete(server: SmtpServer) {
    if (!confirm(`Delete SMTP server "${server.name}"?`)) return;
    try {
      await smtpServerApi.delete(server.id);
      setServers((prev) => prev.filter((s) => s.id !== server.id));
      toast.success(t('settings.smtp.deleted'));
    } catch {
      toast.error(t('settings.smtp.failedDelete'));
    }
  }

  async function handleTest(server: SmtpServer) {
    setTestingId(server.id);
    try {
      await smtpServerApi.test(server.id);
      toast.success(t('settings.smtp.testOk', { name: server.name }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('settings.smtp.testFailed');
      toast.error(msg);
    } finally {
      setTestingId(null);
    }
  }

  async function setConfigKey(key: keyof AppConfig, value: boolean | number | null) {
    if (!appConfig) return;
    setConfigSaving(true);
    try {
      await appConfigApi.setConfig(key, value);
      setAppConfig((prev) => prev ? { ...prev, [key]: value } : prev);
    } catch {
      toast.error(t('settings.failedUpdate'));
    } finally {
      setConfigSaving(false);
    }
  }

  async function saveAgentMainConfig() {
    if (!agentGlobal) return;
    try {
      const updated = await appConfigApi.patchAgentGlobal({
        checkIntervalSeconds: agentInterval.trim() ? Number(agentInterval) : null,
        maxMissedPushes: agentMaxMissed.trim() ? Number(agentMaxMissed) : null,
      });
      setAgentGlobal(updated);
      toast.success(t('common.saved'));
    } catch {
      toast.error(t('settings.failedUpdate'));
    }
  }

  async function saveObligateConfig() {
    try {
      const trimmedUrl = obligateUrl.trim().replace(/\/$/, '');
      if (trimmedUrl && trimmedUrl === window.location.origin.replace(/\/$/, '')) {
        toast.error('Obligate URL cannot point to this application. Enter the URL of your Obligate SSO gateway.');
        return;
      }
      const patch: { url?: string | null; apiKey?: string | null; enabled?: boolean } = { url: trimmedUrl || null };
      if (obligateApiKey.trim()) patch.apiKey = obligateApiKey.trim();
      const updated = await appConfigApi.patchObligateConfig(patch);
      setObligateCfg(updated);
      setObligateApiKey('');
      toast.success('Obligate configuration saved');
    } catch {
      toast.error('Failed to save Obligate configuration');
    }
  }

  async function saveAgentNotifTypes(notifTypes: NotificationTypeConfig | null) {
    const updated = await appConfigApi.patchAgentGlobal({ notificationTypes: notifTypes });
    setAgentGlobal(updated);
  }

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
  }

  return (
    <div className="p-6 min-w-0 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary mb-2">{t('settings.title')}</h1>
        <p className="text-sm text-text-muted">
          {t('settings.globalDesc')}
        </p>
      </div>

      {/* ── About ── */}
      {admin && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Info size={18} className="text-accent" />
            <h2 className="text-lg font-semibold text-text-primary">About</h2>
          </div>
          <div className="rounded-lg border border-border bg-bg-secondary p-5">
            {systemInfoLoading ? (
              <p className="text-sm text-text-muted animate-pulse">Loading system information…</p>
            ) : systemInfo ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6">
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <Server size={12} /> Versions
                  </p>
                  <AboutRow label="Server"  value={`v${systemInfo.appVersion}`} />
                  <AboutRow label="Client"  value={`v${__APP_VERSION__}`} />
                  <AboutRow label="Agent"   value={`v${systemInfo.agentVersion}`} />
                  <AboutRow label="Node.js" value={systemInfo.nodeVersion} />
                </div>
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <Clock size={12} /> Instance
                  </p>
                  <AboutRow label="Uptime"      value={formatUptime(systemInfo.uptimeSeconds)} />
                  <AboutRow label="Environment" value={systemInfo.environment.isDocker ? 'Docker' : 'Native'} />
                  <AboutRow label="Platform"    value={systemInfo.environment.platform} />
                  <AboutRow label="CPU cores"   value={String(systemInfo.cpu.cores)} />
                </div>
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <HardDrive size={12} /> Memory
                  </p>
                  <AboutRow label="Process (RSS)" value={`${systemInfo.memory.processRssMb} MB`} />
                  <AboutRow label="Heap used"     value={`${systemInfo.memory.processHeapMb} MB`} />
                  <AboutRow label="System free"   value={`${systemInfo.memory.systemFreeMb} / ${systemInfo.memory.systemTotalMb} MB`} />
                </div>
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <Cpu size={12} /> CPU load avg
                  </p>
                  <AboutRow label="1 min"  value={String(systemInfo.cpu.loadAvg1)} />
                  <AboutRow label="5 min"  value={String(systemInfo.cpu.loadAvg5)} />
                  <AboutRow label="15 min" value={String(systemInfo.cpu.loadAvg15)} />
                </div>
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <Database size={12} /> Database
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">PostgreSQL</span>
                    <span className={cn(
                      'flex items-center gap-1.5 text-xs font-medium',
                      systemInfo.environment.dbStatus === 'ok' ? 'text-status-up' : 'text-status-down',
                    )}>
                      <span className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        systemInfo.environment.dbStatus === 'ok' ? 'bg-status-up' : 'bg-status-down',
                      )} />
                      {systemInfo.environment.dbStatus === 'ok' ? 'Connected' : 'Error'}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-muted">Could not load system information.</p>
            )}
          </div>
        </div>
      )}

      {/* ── Default Monitor Settings ── */}
      <SettingsPanel scope="global" scopeId={null} title={t('settings.defaultMonitorSettings')} />

      {admin && (
        <>
          {/* ── Default Agent Settings ── */}
          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-4">{t('settings.defaultAgentSettings')}</h2>
            <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-6">
              <p className="text-xs text-text-muted">{t('settings.agentDefaultsDesc')}</p>

              {/* Check Interval */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-text-primary">{t('settings.agent.checkInterval')}</div>
                  <div className="text-xs text-text-muted">{t('settings.agent.checkIntervalDesc')}</div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number" value={agentInterval} min={5} max={86400}
                    onChange={e => setAgentInterval(e.target.value)}
                    onBlur={() => void saveAgentMainConfig()}
                    placeholder={String(DEFAULT_AGENT_GLOBAL_CONFIG.checkIntervalSeconds)}
                    className="w-24 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-right placeholder:text-text-muted"
                  />
                  <span className="text-xs text-text-muted">{t('groups.detail.seconds')}</span>
                </div>
              </div>

              {/* Max Missed Pushes */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-text-primary">{t('settings.agent.maxMissedPushes')}</div>
                  <div className="text-xs text-text-muted">{t('settings.agent.maxMissedPushesDesc')}</div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number" value={agentMaxMissed} min={1} max={20}
                    onChange={e => setAgentMaxMissed(e.target.value)}
                    onBlur={() => void saveAgentMainConfig()}
                    placeholder={String(DEFAULT_AGENT_GLOBAL_CONFIG.maxMissedPushes)}
                    className="w-20 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-right placeholder:text-text-muted"
                  />
                </div>
              </div>
            </div>

            {/* Notification Types — global scope, always editable */}
            <div className="mt-4">
              <NotificationTypesPanel
                config={agentGlobal?.notificationTypes ?? {
                  global: null, down: null, up: null, threat: null, attack: null,
                }}
                scope="global"
                onSave={saveAgentNotifTypes}
              />
            </div>
          </div>

          {/* ── SMTP Servers ── */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-text-primary">{t('settings.smtp.title')}</h2>
              <Button size="sm" onClick={openCreate}>
                <Plus size={14} className="mr-1" /> {t('settings.smtp.addServer')}
              </Button>
            </div>
            {servers.length === 0 ? (
              <div className="rounded-lg border border-border bg-bg-secondary p-5 text-sm text-text-muted flex items-center gap-3">
                <Server size={16} className="shrink-0" />
                {t('settings.smtp.noServers')}
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="px-4 py-2.5 font-medium text-text-secondary">{t('settings.smtp.colName')}</th>
                      <th className="px-4 py-2.5 font-medium text-text-secondary">{t('settings.smtp.colHost')}</th>
                      <th className="px-4 py-2.5 font-medium text-text-secondary">{t('settings.smtp.colFrom')}</th>
                      <th className="px-4 py-2.5 font-medium text-text-secondary text-right">{t('settings.smtp.colActions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {servers.map((server) => (
                      <tr key={server.id} className="border-b border-border last:border-0 hover:bg-bg-hover transition-colors">
                        <td className="px-4 py-3 text-text-primary font-medium">{server.name}</td>
                        <td className="px-4 py-3 text-text-secondary">
                          {server.host}:{server.port}
                          {server.secure && <span className="ml-1.5 text-xs bg-green-500/10 text-green-400 rounded px-1">{t('settings.smtp.tlsBadge')}</span>}
                        </td>
                        <td className="px-4 py-3 text-text-muted">{server.fromAddress}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => handleTest(server)}
                              disabled={testingId === server.id}
                              className="p-1.5 rounded text-text-muted hover:text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-50"
                              title={t('settings.smtp.testConnection')}
                            >
                              <Wifi size={14} />
                            </button>
                            <button
                              onClick={() => openEdit(server)}
                              className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                              title={t('common.edit')}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => handleDelete(server)}
                              className="p-1.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
                              title={t('common.delete')}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Remote Blocklists ── */}
          <RemoteBlocklistsSection />

          {/* ── Obligate SSO Gateway ── */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <ArrowLeftRight size={16} className="text-text-muted" />
              <h2 className="text-lg font-semibold text-text-primary">Obligate SSO Gateway</h2>
            </div>
            <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
              <p className="text-sm text-text-muted">
                {t('settings.obligate.description', 'Connect this app to your Obligate SSO gateway for centralized authentication and cross-app navigation. Register this app in Obligate first, then paste the API key here.')}
              </p>
              <div className="bg-status-pending-bg border border-status-pending/30 rounded-md p-3 text-sm text-status-pending">
                {t('settings.obligate.warning', 'When enabled, local authentication is disabled. Users must sign in through the Obligate gateway. If the gateway becomes unreachable, local authentication is automatically restored as a fallback.')}
              </div>

              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="text-sm font-medium text-text-secondary">Obligate URL</label>
                  {obligateCfg?.url && (
                    <a href={obligateCfg.url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">Open ↗</a>
                  )}
                </div>
                <input
                  type="url"
                  placeholder="https://obligate.example.com"
                  value={obligateUrl}
                  onChange={(e) => setObligateUrl(e.target.value)}
                  onBlur={() => void saveObligateConfig()}
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  API Key
                  {obligateCfg?.apiKeySet && (
                    <span className="ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20">SET</span>
                  )}
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showObligateKey ? 'text' : 'password'}
                      placeholder={obligateCfg?.apiKeySet ? '••••••••••••••••••••••••••••••••••••' : 'Paste the API key from Obligate…'}
                      value={obligateApiKey}
                      onChange={(e) => setObligateApiKey(e.target.value)}
                      onBlur={() => { if (obligateApiKey.trim()) void saveObligateConfig(); }}
                      className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 pr-8 text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                    <button
                      type="button"
                      onClick={() => setShowObligateKey((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                    >
                      {showObligateKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
                <p className="mt-1.5 text-xs text-text-muted">
                  Generate this key in{' '}
                  <span className="text-text-secondary font-medium">Obligate → Connected Apps → Add App</span>.
                </p>
              </div>

              {obligateCfg?.url && obligateCfg.apiKeySet && (
                <div className="pt-4 border-t border-border mt-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-text-primary">Enable SSO</p>
                      <p className="text-xs text-text-muted mt-0.5">
                        When enabled, the login page redirects to Obligate for authentication.
                        Users are auto-provisioned on first login. Cross-app navigation buttons appear in the header.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={appConfig?.obligate_enabled ?? false}
                      disabled={configSaving || !appConfig}
                      onClick={() => setConfigKey('obligate_enabled', !appConfig?.obligate_enabled)}
                      className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none', (appConfig?.obligate_enabled ?? false) ? 'bg-primary' : 'bg-bg-hover')}
                    >
                      <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform', (appConfig?.obligate_enabled ?? false) ? 'translate-x-6' : 'translate-x-1')} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Security / 2FA ── */}
          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-4">{t('settings.security.title')}</h2>
            <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border">
              <div className="flex items-start justify-between gap-4 p-4">
                <div className="flex items-start gap-3">
                  <Shield size={16} className="text-text-muted mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{t('settings.security.allow2fa')}</p>
                    <p className="text-xs text-text-muted mt-0.5">{t('settings.security.allow2faDesc')}</p>
                  </div>
                </div>
                <button
                  role="switch"
                  aria-checked={appConfig?.allow_2fa ?? false}
                  disabled={configSaving || !appConfig}
                  onClick={() => setConfigKey('allow_2fa', !appConfig?.allow_2fa)}
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none disabled:opacity-50',
                    appConfig?.allow_2fa ? 'bg-primary' : 'bg-bg-tertiary',
                  )}
                >
                  <span className={cn('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', appConfig?.allow_2fa ? 'translate-x-4' : 'translate-x-0')} />
                </button>
              </div>

              <div className={cn('flex items-start justify-between gap-4 p-4', !appConfig?.allow_2fa && 'opacity-50 pointer-events-none')}>
                <div className="flex items-start gap-3">
                  <Shield size={16} className="text-text-muted mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{t('settings.security.force2fa')}</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {t('settings.security.force2faDesc').split('\n')[0]}
                      {' '}
                      Bypass via <code className="text-xs font-mono">DISABLE_2FA_FORCE=true</code> in .env.
                    </p>
                  </div>
                </div>
                <button
                  role="switch"
                  aria-checked={appConfig?.force_2fa ?? false}
                  disabled={configSaving || !appConfig || !appConfig.allow_2fa}
                  onClick={() => setConfigKey('force_2fa', !appConfig?.force_2fa)}
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none disabled:opacity-50',
                    appConfig?.force_2fa ? 'bg-primary' : 'bg-bg-tertiary',
                  )}
                >
                  <span className={cn('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', appConfig?.force_2fa ? 'translate-x-4' : 'translate-x-0')} />
                </button>
              </div>

              <div className={cn('flex items-start gap-4 p-4', !appConfig?.allow_2fa && 'opacity-50 pointer-events-none')}>
                <Server size={16} className="text-text-muted mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{t('settings.security.otpSmtp')}</p>
                  <p className="text-xs text-text-muted mt-0.5">{t('settings.security.otpSmtpDesc')}</p>
                  <select
                    className="mt-2 w-full max-w-xs rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                    value={appConfig?.otp_smtp_server_id ?? ''}
                    disabled={configSaving || !appConfig || !appConfig.allow_2fa}
                    onChange={(e) => setConfigKey('otp_smtp_server_id', e.target.value ? parseInt(e.target.value, 10) : null)}
                  >
                    <option value="">{t('settings.security.noneOption')}</option>
                    {servers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {smtpMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-bg-secondary rounded-xl shadow-2xl border border-border w-full max-w-md">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-base font-semibold text-text-primary">
                {smtpMode === 'create' ? t('settings.smtp.addTitle') : t('settings.smtp.editTitle')}
              </h3>
            </div>
            <form onSubmit={handleSmtpSubmit} className="p-5 space-y-3">
              <Input
                label={t('settings.smtp.nameLabel')}
                value={smtpForm.name}
                onChange={(e) => setSmtpForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('settings.smtp.namePlaceholder')}
                required
              />
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Input
                    label={t('settings.smtp.hostLabel')}
                    value={smtpForm.host}
                    onChange={(e) => setSmtpForm((f) => ({ ...f, host: e.target.value }))}
                    placeholder={t('settings.smtp.hostPlaceholder')}
                    required
                  />
                </div>
                <Input
                  label={t('settings.smtp.portLabel')}
                  type="number"
                  value={smtpForm.port}
                  onChange={(e) => setSmtpForm((f) => ({ ...f, port: e.target.value }))}
                  placeholder={t('settings.smtp.portPlaceholder')}
                  required
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none">
                <div className="relative h-4 w-4 shrink-0">
                  <input
                    type="checkbox"
                    checked={smtpForm.secure}
                    onChange={(e) => setSmtpForm((f) => ({ ...f, secure: e.target.checked }))}
                    className="peer appearance-none h-4 w-4 rounded border cursor-pointer transition-colors bg-bg-tertiary border-border checked:bg-accent checked:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <svg className="pointer-events-none absolute top-0 left-0 hidden h-4 w-4 text-white peer-checked:block" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 8L6 11.5L13.5 4.5" />
                  </svg>
                </div>
                {t('settings.smtp.tlsLabel')}
              </label>
              <Input
                label={t('settings.smtp.usernameLabel')}
                value={smtpForm.username}
                onChange={(e) => setSmtpForm((f) => ({ ...f, username: e.target.value }))}
                required
              />
              <div className="relative">
                <Input
                  label={smtpMode === 'edit' ? t('settings.smtp.passwordEditLabel') : t('settings.smtp.passwordLabel')}
                  type={showPassword ? 'text' : 'password'}
                  value={smtpForm.password}
                  onChange={(e) => setSmtpForm((f) => ({ ...f, password: e.target.value }))}
                  required={smtpMode === 'create'}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2.5 bottom-2 text-text-muted hover:text-text-primary"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <Input
                label={t('settings.smtp.fromLabel')}
                type="email"
                value={smtpForm.fromAddress}
                onChange={(e) => setSmtpForm((f) => ({ ...f, fromAddress: e.target.value }))}
                placeholder={t('settings.smtp.fromPlaceholder')}
                required
              />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={closeSmtpModal}>{t('common.cancel')}</Button>
                <Button type="submit" disabled={smtpSaving}>
                  {smtpSaving ? t('common.saving') : smtpMode === 'create' ? t('common.create') : t('common.save')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Remote Blocklists Section ────────────────────────────────────────────────

function RemoteBlocklistsSection() {
  const [lists, setLists] = useState<import('../api/remoteBlocklist.api').RemoteBlocklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<'url' | 'oblitools'>('url');
  const [formUrl, setFormUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formInterval, setFormInterval] = useState(600);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [instanceName, setInstanceName] = useState('');
  const [lastPush, setLastPush] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { remoteBlocklistApi } = await import('../api/remoteBlocklist.api');
    const data = await remoteBlocklistApi.list();
    setLists(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    import('../api/client').then(({ default: apiClient }) => {
      apiClient.get('/admin/config').then((res: { data: { data: Record<string, string | null> } }) => {
        const cfg = res.data?.data ?? {};
        setPushEnabled(cfg.oblitools_push_enabled === 'true');
        setInstanceName(cfg.oblitools_instance_name ?? '');
        setLastPush(cfg.oblitools_last_push_at ?? null);
      }).catch(() => {});
    });
  }, [load]);

  const handleAdd = async () => {
    const { remoteBlocklistApi } = await import('../api/remoteBlocklist.api');
    try {
      const url = formType === 'oblitools'
        ? 'https://guard.obli.tools/blocklist/api/blocklist'
        : formUrl;
      await remoteBlocklistApi.create({
        name: formName || (formType === 'oblitools' ? 'Obli.tools Global' : formUrl),
        sourceType: formType,
        url,
        apiKey: formApiKey || undefined,
        syncInterval: formInterval,
      });
      toast.success('Blocklist added');
      setShowAdd(false);
      setFormName(''); setFormUrl(''); setFormApiKey(''); setFormType('url');
      void load();
    } catch { toast.error('Failed to add blocklist'); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this blocklist and all its imported IPs?')) return;
    const { remoteBlocklistApi } = await import('../api/remoteBlocklist.api');
    await remoteBlocklistApi.delete(id);
    toast.success('Blocklist deleted');
    void load();
  };

  const handleSync = async (id: number) => {
    const { remoteBlocklistApi } = await import('../api/remoteBlocklist.api');
    try {
      await remoteBlocklistApi.forceSync(id);
      toast.success('Sync completed');
      void load();
    } catch { toast.error('Sync failed'); }
  };

  const handleToggle = async (id: number, enabled: boolean) => {
    const { remoteBlocklistApi } = await import('../api/remoteBlocklist.api');
    await remoteBlocklistApi.update(id, { enabled });
    void load();
  };

  const savePushConfig = async () => {
    try {
      const apiClient = (await import('../api/client')).default;
      await apiClient.put('/admin/config/oblitools_push_enabled', { value: pushEnabled ? 'true' : 'false' });
      await apiClient.put('/admin/config/oblitools_instance_name', { value: instanceName });
      toast.success('Push settings saved');
    } catch { toast.error('Failed to save'); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-text-muted" />
          <h2 className="text-lg font-semibold text-text-primary">Remote Blocklists</h2>
        </div>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors">
          <Plus size={14} /> Add Blocklist
        </button>
      </div>

      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden mb-4">
        {loading ? (
          <div className="p-4 text-sm text-text-muted">Loading...</div>
        ) : lists.length === 0 ? (
          <div className="p-6 text-center text-sm text-text-muted">No remote blocklists configured</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-tertiary text-text-secondary text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 font-medium">Type</th>
                <th className="text-right px-4 py-2.5 font-medium">IPs</th>
                <th className="text-left px-4 py-2.5 font-medium">Last sync</th>
                <th className="text-center px-4 py-2.5 font-medium">Enabled</th>
                <th className="text-right px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lists.map(l => (
                <tr key={l.id} className="hover:bg-bg-hover transition-colors">
                  <td className="px-4 py-2.5 text-text-primary font-medium">{l.name}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      l.sourceType === 'oblitools'
                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                    }`}>
                      {l.sourceType === 'oblitools' ? 'Obli.tools' : 'URL'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-text-secondary">{l.lastSyncCount}</td>
                  <td className="px-4 py-2.5 text-text-muted text-xs">{l.lastSyncAt ? new Date(l.lastSyncAt).toLocaleString() : '—'}</td>
                  <td className="px-4 py-2.5 text-center">
                    <button onClick={() => void handleToggle(l.id, !l.enabled)}
                      className={`w-8 h-4 rounded-full transition-colors ${l.enabled ? 'bg-accent' : 'bg-bg-tertiary'}`}
                      role="switch" aria-checked={l.enabled}>
                      <span className={`block w-3 h-3 rounded-full bg-white transition-transform ${l.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => void handleSync(l.id)} className="p-1 rounded text-text-muted hover:text-accent transition-colors" title="Force sync">
                        <RefreshCw size={13} />
                      </button>
                      <button onClick={() => void handleDelete(l.id)} className="p-1 rounded text-text-muted hover:text-status-down transition-colors" title="Delete">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Obli.tools Contribution */}
      <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Shield size={16} className="text-amber-400" />
          <h3 className="text-sm font-semibold text-text-primary">Obli.tools Contribution</h3>
        </div>
        <p className="text-xs text-text-muted">
          Share your auto-banned IPs with the Obli.tools community blocklist. Only non-local auto-banned IPs are shared. Manual bans are never sent.
        </p>
        <div className="flex items-center gap-3">
          <button onClick={() => setPushEnabled(!pushEnabled)}
            className={`w-10 h-5 rounded-full transition-colors ${pushEnabled ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}
            role="switch" aria-checked={pushEnabled}>
            <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${pushEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
          <span className="text-sm text-text-secondary">Share auto-bans with Obli.tools</span>
        </div>
        {pushEnabled && (
          <div className="space-y-3 pt-2">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Instance name</label>
              <input type="text" value={instanceName} onChange={e => setInstanceName(e.target.value)}
                placeholder="prod-obliguard-01"
                className="w-full max-w-xs px-3 py-1.5 rounded-md border border-border bg-bg-tertiary text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <button onClick={() => void savePushConfig()} className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors">
              Save
            </button>
            {lastPush && <p className="text-xs text-text-muted">Last push: {new Date(lastPush).toLocaleString()}</p>}
          </div>
        )}
      </div>

      {/* Add modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setShowAdd(false)}>
          <div className="bg-bg-primary border border-border rounded-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-text-primary mb-4">Add Remote Blocklist</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Type</label>
                <select value={formType} onChange={e => setFormType(e.target.value as 'url' | 'oblitools')}
                  className="w-full px-3 py-2 rounded-md border border-border bg-bg-secondary text-sm text-text-primary">
                  <option value="url">Custom URL</option>
                  <option value="oblitools">Obli.tools Global</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Name</label>
                <input type="text" value={formName} onChange={e => setFormName(e.target.value)}
                  placeholder={formType === 'oblitools' ? 'Obli.tools Global' : 'My blocklist'}
                  className="w-full px-3 py-2 rounded-md border border-border bg-bg-secondary text-sm text-text-primary" />
              </div>
              {formType === 'url' && (
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">URL</label>
                  <input type="url" value={formUrl} onChange={e => setFormUrl(e.target.value)}
                    placeholder="https://example.com/blocklist.txt"
                    className="w-full px-3 py-2 rounded-md border border-border bg-bg-secondary text-sm text-text-primary" />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">API Key {formType === 'url' && '(optional)'}</label>
                <input type="password" value={formApiKey} onChange={e => setFormApiKey(e.target.value)}
                  placeholder={formType === 'oblitools' ? 'oblg_xxxxxxxxxxxx' : 'Optional Bearer token'}
                  className="w-full px-3 py-2 rounded-md border border-border bg-bg-secondary text-sm text-text-primary" />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Sync interval</label>
                <select value={formInterval} onChange={e => setFormInterval(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-md border border-border bg-bg-secondary text-sm text-text-primary">
                  <option value={300}>5 minutes</option>
                  <option value={600}>10 minutes</option>
                  <option value={1800}>30 minutes</option>
                  <option value={3600}>1 hour</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => void handleAdd()}
                className="px-4 py-2 rounded-md text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors">
                Add
              </button>
              <button onClick={() => setShowAdd(false)}
                className="px-4 py-2 rounded-md text-sm text-text-muted hover:text-text-primary transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
