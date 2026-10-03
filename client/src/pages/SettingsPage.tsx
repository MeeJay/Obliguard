import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { Shield, Server, Plus, Pencil, Trash2, Wifi, Eye, EyeOff, ArrowLeftRight, Info, Cpu, HardDrive, Database, Clock } from 'lucide-react';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { useAuthStore } from '@/store/authStore';
import { smtpServerApi, type CreateSmtpServerRequest } from '@/api/smtpServer.api';
import apiClient from '@/api/client';
import { appConfigApi } from '@/api/appConfig.api';
import { systemApi, type SystemInfo } from '@/api/system.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { useConfirm } from '@/components/common/ConfirmDialog';
import type { SmtpServer, AppConfig, AgentGlobalConfig, ObligateConfig } from '@obliview/shared';
import { DEFAULT_AGENT_UPDATE_POLICY, isMasterTenant } from '@obliview/shared';
import type { AgentUpdatePolicy } from '@obliview/shared';
import { useTenantStore } from '@/store/tenantStore';
import toast from 'react-hot-toast';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

/** Server error text of a failed API call (`{ error }` body), if any. */
function apiError(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

/** Page-load failure: an error toast with a Retry action (one per message). */
function toastLoadError(message: string, retryLabel: string, retry: () => void) {
  toast.error((tst) => (
    <span className="flex items-center gap-3">
      <span>{message}</span>
      <button
        type="button"
        className="shrink-0 text-xs font-medium text-accent hover:underline"
        onClick={() => { toast.dismiss(tst.id); retry(); }}
      >
        {retryLabel}
      </button>
    </span>
  ), { id: `settings-load:${message}` });
}

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
  const confirmAction = useConfirm();
  const { isAdmin } = useAuthStore();
  const admin = isAdmin();
  // Platform-wide actions (danger zone) are only available from the Default tenant.
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  const isDefaultTenant = currentTenantId != null && isMasterTenant(currentTenantId);
  const currentTenantName = useTenantStore(s => s.tenants.find(tn => tn.id === s.currentTenantId)?.name ?? null);

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

  // ── Agent Global Config (global update policy, C17; the other agent
  // defaults are the global level of the IPS settings cascade) ──
  const [agentGlobal, setAgentGlobal] = useState<AgentGlobalConfig | null>(null);

  const loadSettings = useCallback(() => {
    setSystemInfoLoading(true);
    // The About panel shows its own "could not load" line; the other
    // sections stay empty on failure, so they report it with a Retry.
    systemApi.getInfo().then(setSystemInfo).catch(() => setSystemInfo(null)).finally(() => setSystemInfoLoading(false));
    void Promise.allSettled([
      smtpServerApi.list().then(setServers),
      appConfigApi.getConfig().then(setAppConfig),
      appConfigApi.getObligateConfig().then((cfg) => {
        setObligateCfg(cfg);
        setObligateUrl(cfg.url ?? '');
      }),
      appConfigApi.getAgentGlobal().then(setAgentGlobal),
    ]).then((results) => {
      if (results.some((r) => r.status === 'rejected')) {
        toastLoadError(
          t('settings.loadFailed', 'Failed to load some settings'),
          t('common.retry', 'Retry'),
          loadSettings,
        );
      }
    });
  }, [t]);

  useEffect(() => {
    if (!admin) return;
    loadSettings();
  }, [admin, loadSettings]);

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
    if (!(await confirmAction({
      message: t('settings.smtp.confirmDelete', { name: server.name, defaultValue: 'Delete SMTP server "{{name}}"?' }),
      danger: true,
    }))) return;
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

  async function saveObligateConfig() {
    try {
      const trimmedUrl = obligateUrl.trim().replace(/\/$/, '');
      if (trimmedUrl && trimmedUrl === window.location.origin.replace(/\/$/, '')) {
        toast.error(t('settings.obligate.selfUrl', { defaultValue: 'Obligate URL cannot point to this application. Enter the URL of your Obligate SSO gateway.' }));
        return;
      }
      const patch: { url?: string | null; apiKey?: string | null; enabled?: boolean } = { url: trimmedUrl || null };
      if (obligateApiKey.trim()) patch.apiKey = obligateApiKey.trim();
      const updated = await appConfigApi.patchObligateConfig(patch);
      setObligateCfg(updated);
      setObligateApiKey('');
      toast.success(t('settings.obligate.saved', { defaultValue: 'Obligate configuration saved' }));
    } catch {
      toast.error(t('settings.obligate.saveFailed', { defaultValue: 'Failed to save Obligate configuration' }));
    }
  }

  // Global agent update policy (C17-1): platform admin, from the Default tenant only.
  async function saveAgentUpdatePolicy(v: AgentUpdatePolicy) {
    if (v === 'auto' && !(await confirmAction({
      message: t('agentUpdate.confirmGlobalAuto',
        'Every agent without a group/agent override will update to the latest version within ~30 s, and to every future release as soon as the server serves it. Continue?',
      ),
    }))) return;
    try {
      const updated = await appConfigApi.patchAgentGlobal({ updatePolicy: v });
      setAgentGlobal(updated);
      toast.success(t('common.saved'));
    } catch (err) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('settings.failedUpdate'));
    }
  }

  // Danger zone: platform-wide resets (Default tenant + platform admin, enforced
  // server-side). Type-to-confirm replaces the old double native confirm.
  async function wipeAllBans() {
    if (!(await confirmAction({
      title: t('settings.danger.wipeBansTitle', 'Wipe all bans'),
      message: t('settings.danger.wipeBansConfirm', 'Lift ALL active bans in every tenant? All agents will unblock all IPs on their next sync.'),
      confirmLabel: t('settings.danger.wipeBans', 'Wipe all bans'),
      danger: true,
      requireText: 'WIPE',
    }))) return;
    try {
      const api = (await import('../api/client')).default;
      await api.post('/bans/wipe-bans');
      toast.success(t('settings.danger.wipeBansDone', 'All bans lifted'));
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.danger.wipeFailed', 'Wipe failed'));
    }
  }

  async function wipeAllIpData() {
    if (!(await confirmAction({
      title: t('settings.danger.wipeIpsTitle', 'Wipe all IP data'),
      message: t('settings.danger.wipeIpsConfirm', 'DELETE all IP reputation data and events in every tenant? All IP history will be permanently lost. This cannot be undone.'),
      confirmLabel: t('settings.danger.wipeIps', 'Wipe all IPs'),
      danger: true,
      requireText: 'WIPE',
    }))) return;
    try {
      const api = (await import('../api/client')).default;
      await api.post('/bans/wipe-reputation');
      toast.success(t('settings.danger.wipeIpsDone', 'IP data wiped'));
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.danger.wipeFailed', 'Wipe failed'));
    }
  }

  // Sentences wrapping inline markup: the placeholder token marks where the element goes.
  const obligateKeyHint = t('settings.obligate.keyHint', { path: '%PATH%', defaultValue: 'Generate this key in {{path}}.' }).split('%PATH%');
  const force2faBypass = t('settings.security.force2faBypass', { env: '%ENV%', defaultValue: 'Bypass via {{env}} in .env.' }).split('%ENV%');

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(t('settings.about.days', { count: d, defaultValue: '{{count}}d' }));
    if (h > 0) parts.push(t('settings.about.hours', { count: h, defaultValue: '{{count}}h' }));
    parts.push(t('settings.about.minutes', { count: m, defaultValue: '{{count}}m' }));
    return parts.join(' ');
  }

  return (
    <PageContainer className="space-y-8">
      <PageHeader title={t('settings.title')} description={t('settings.globalDesc')} />

      {/* ── About ── */}
      {admin && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Info size={18} className="text-accent" />
            <h2 className="text-lg font-semibold text-text-primary">{t('settings.about.title', { defaultValue: 'About' })}</h2>
          </div>
          <div className="rounded-lg border border-border bg-bg-secondary p-5">
            {systemInfoLoading ? (
              <p className="text-sm text-text-muted animate-pulse">{t('settings.about.loading', { defaultValue: 'Loading system information…' })}</p>
            ) : systemInfo ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6">
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <Server size={12} /> {t('settings.about.versions', { defaultValue: 'Versions' })}
                  </p>
                  <AboutRow label={t('settings.about.server', { defaultValue: 'Server' })} value={`v${systemInfo.appVersion}`} />
                  <AboutRow label={t('settings.about.client', { defaultValue: 'Client' })} value={`v${__APP_VERSION__}`} />
                  <AboutRow label={t('settings.about.agent', { defaultValue: 'Agent' })} value={`v${systemInfo.agentVersion}`} />
                  <AboutRow label="Node.js" value={systemInfo.nodeVersion} />
                </div>
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <Clock size={12} /> {t('settings.about.instance', { defaultValue: 'Instance' })}
                  </p>
                  <AboutRow label={t('settings.about.uptime', { defaultValue: 'Uptime' })} value={formatUptime(systemInfo.uptimeSeconds)} />
                  <AboutRow
                    label={t('settings.about.environment', { defaultValue: 'Environment' })}
                    value={systemInfo.environment.isDocker ? 'Docker' : t('settings.about.native', { defaultValue: 'Native' })}
                  />
                  <AboutRow label={t('settings.about.platform', { defaultValue: 'Platform' })} value={systemInfo.environment.platform} />
                  <AboutRow label={t('settings.about.cpuCores', { defaultValue: 'CPU cores' })} value={String(systemInfo.cpu.cores)} />
                </div>
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <HardDrive size={12} /> {t('settings.about.memory', { defaultValue: 'Memory' })}
                  </p>
                  <AboutRow
                    label={t('settings.about.processRss', { defaultValue: 'Process (RSS)' })}
                    value={t('settings.about.mb', { value: systemInfo.memory.processRssMb, defaultValue: '{{value}} MB' })}
                  />
                  <AboutRow
                    label={t('settings.about.heapUsed', { defaultValue: 'Heap used' })}
                    value={t('settings.about.mb', { value: systemInfo.memory.processHeapMb, defaultValue: '{{value}} MB' })}
                  />
                  <AboutRow
                    label={t('settings.about.systemFree', { defaultValue: 'System free' })}
                    value={t('settings.about.mbOf', {
                      value: systemInfo.memory.systemFreeMb, total: systemInfo.memory.systemTotalMb, defaultValue: '{{value}} / {{total}} MB',
                    })}
                  />
                </div>
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <Cpu size={12} /> {t('settings.about.cpuLoad', { defaultValue: 'CPU load avg' })}
                  </p>
                  <AboutRow label={t('settings.about.loadMin', { count: 1, defaultValue: '{{count}} min' })} value={String(systemInfo.cpu.loadAvg1)} />
                  <AboutRow label={t('settings.about.loadMin', { count: 5, defaultValue: '{{count}} min' })} value={String(systemInfo.cpu.loadAvg5)} />
                  <AboutRow label={t('settings.about.loadMin', { count: 15, defaultValue: '{{count}} min' })} value={String(systemInfo.cpu.loadAvg15)} />
                </div>
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                    <Database size={12} /> {t('settings.about.database', { defaultValue: 'Database' })}
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
                      {systemInfo.environment.dbStatus === 'ok'
                        ? t('settings.about.dbConnected', { defaultValue: 'Connected' })
                        : t('settings.about.dbError', { defaultValue: 'Error' })}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-muted">{t('settings.about.loadFailed', { defaultValue: 'Could not load system information.' })}</p>
            )}
          </div>
        </div>
      )}

      {admin && (
        <>
          {/* ── Default Agent Settings ── */}
          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-4">{t('settings.defaultAgentSettings')}</h2>
            <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-6">
              <p className="text-xs text-text-muted">{t('settings.agentDefaultsDesc')}</p>

              {/* IPS settings cascade, global level (writes: Default tenant only) */}
              <SettingsPanel
                level="global"
                scopeId={null}
                hide={['updatePolicy']}
                readOnly={!isDefaultTenant}
                className="min-w-0"
              />

              {/* Agent updates — default policy (C17-1) */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-text-primary">{t('agentUpdate.globalLabel', 'Agent updates (default policy)')}</div>
                  <div className="text-xs text-text-muted">
                    {t('agentUpdate.globalDesc', 'Automatic: every new release is installed within ~30 s. Manual: only on "Update now". Off: never (fleet-wide freeze, overrides every group and agent).')}
                  </div>
                  {!isDefaultTenant && (
                    <div className="text-xs text-amber-400 mt-1">
                      {t('agentUpdate.globalDefaultOnly', 'Switch to the Default tenant to change the global update policy')}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    value={agentGlobal?.updatePolicy ?? DEFAULT_AGENT_UPDATE_POLICY}
                    onChange={e => void saveAgentUpdatePolicy(e.target.value as AgentUpdatePolicy)}
                    disabled={!isDefaultTenant || !agentGlobal}
                    className="rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                  >
                    <option value="auto">{t('agentUpdate.policy.auto', 'Automatic')}</option>
                    <option value="manual">{t('agentUpdate.policy.manual', 'Manual')}</option>
                    <option value="off">{t('agentUpdate.policy.off', 'Off (frozen)')}</option>
                  </select>
                  {agentGlobal && agentGlobal.updatePolicy == null && (
                    <span className="text-xs text-text-muted">{t('agentUpdate.builtInDefault', '(built-in default)')}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Workspace level of the cascade (the operating tenant) */}
            <SettingsPanel
              level="tenant"
              scopeId={null}
              className="mt-4 rounded-lg border border-border bg-bg-secondary p-5 max-sm:p-4"
              title={t('settings.tenantSettingsTitle', { defaultValue: 'Workspace agent settings: {{name}}', name: currentTenantName ?? '' })}
              description={t('settings.tenantSettingsDesc', { defaultValue: "Apply to this workspace's agents, above the global defaults; groups and agents may override them." })}
              updatePolicyHref="/manage/agents"
            />
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
                            <IconButton
                              label={t('settings.smtp.testConnection')}
                              icon={<Wifi size={14} />}
                              onClick={() => void handleTest(server)}
                              disabled={testingId === server.id}
                              className="hover:text-blue-400 hover:bg-blue-400/10"
                            />
                            <IconButton
                              label={t('common.edit')}
                              icon={<Pencil size={14} />}
                              onClick={() => openEdit(server)}
                            />
                            <IconButton
                              label={t('common.delete')}
                              icon={<Trash2 size={14} />}
                              variant="danger"
                              onClick={() => void handleDelete(server)}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Obli.tools contribution ── (remote blocklists: Policies > Remote blocklists) */}
          <ObliToolsContributionSection isDefaultTenant={isDefaultTenant} />

          {/* ── Obligate SSO Gateway ── */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <ArrowLeftRight size={16} className="text-text-muted" />
              <h2 className="text-lg font-semibold text-text-primary">{t('settings.obligate.title', { defaultValue: 'Obligate SSO Gateway' })}</h2>
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
                  <label className="text-sm font-medium text-text-secondary">{t('settings.obligate.url', { defaultValue: 'Obligate URL' })}</label>
                  {obligateCfg?.url && (
                    <a href={obligateCfg.url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">{t('settings.obligate.open', { defaultValue: 'Open ↗' })}</a>
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
                  {t('settings.obligate.apiKey', { defaultValue: 'API Key' })}
                  {obligateCfg?.apiKeySet && (
                    <span className="ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20">{t('settings.obligate.keySet', { defaultValue: 'SET' })}</span>
                  )}
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showObligateKey ? 'text' : 'password'}
                      placeholder={obligateCfg?.apiKeySet ? '••••••••••••••••••••••••••••••••••••' : t('settings.obligate.apiKeyPlaceholder', { defaultValue: 'Paste the API key from Obligate…' })}
                      value={obligateApiKey}
                      onChange={(e) => setObligateApiKey(e.target.value)}
                      onBlur={() => { if (obligateApiKey.trim()) void saveObligateConfig(); }}
                      className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 pr-8 text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                    <IconButton
                      label={showObligateKey ? t('settings.hideSecret', 'Hide') : t('settings.showSecret', 'Show')}
                      icon={showObligateKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      variant="plain"
                      size="xs"
                      touchTarget="overlay"
                      onClick={() => setShowObligateKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2"
                    />
                  </div>
                </div>
                <p className="mt-1.5 text-xs text-text-muted">
                  {obligateKeyHint[0]}
                  <span className="text-text-secondary font-medium">
                    {t('settings.obligate.keyHintPath', { defaultValue: 'Obligate → Connected Apps → Add App' })}
                  </span>
                  {obligateKeyHint[1]}
                </p>
              </div>

              {obligateCfg?.url && obligateCfg.apiKeySet && (
                <div className="pt-4 border-t border-border mt-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{t('settings.obligate.enableSso', 'Enable SSO')}</p>
                      <p className="text-xs text-text-muted mt-0.5">
                        {t('settings.obligate.enableSsoDesc', {
                          defaultValue: 'When enabled, the login page redirects to Obligate for authentication. Users are auto-provisioned on first login. Cross-app navigation buttons appear in the header.',
                        })}
                      </p>
                    </div>
                    <ToggleSwitch
                      checked={appConfig?.obligate_enabled ?? false}
                      disabled={configSaving || !appConfig}
                      onChange={(next) => void setConfigKey('obligate_enabled', next)}
                      ariaLabel={t('settings.obligate.enableSso', 'Enable SSO')}
                    />
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
                <ToggleSwitch
                  checked={appConfig?.allow_2fa ?? false}
                  disabled={configSaving || !appConfig}
                  onChange={(next) => void setConfigKey('allow_2fa', next)}
                  ariaLabel={t('settings.security.allow2fa')}
                />
              </div>

              <div className={cn('flex items-start justify-between gap-4 p-4', !appConfig?.allow_2fa && 'opacity-50 pointer-events-none')}>
                <div className="flex items-start gap-3">
                  <Shield size={16} className="text-text-muted mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{t('settings.security.force2fa')}</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {t('settings.security.force2faDesc').split('\n')[0]}
                      {' '}
                      {force2faBypass[0]}
                      <code className="text-xs font-mono">DISABLE_2FA_FORCE=true</code>
                      {force2faBypass[1]}
                    </p>
                  </div>
                </div>
                <ToggleSwitch
                  checked={appConfig?.force_2fa ?? false}
                  disabled={configSaving || !appConfig || !appConfig.allow_2fa}
                  onChange={(next) => void setConfigKey('force_2fa', next)}
                  ariaLabel={t('settings.security.force2fa')}
                />
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

      {/* ── Data retention ── (instance-wide purge windows: Default only) */}
      {admin && isDefaultTenant && <DataRetentionSection />}

      {/* ── Danger Zone ── (wipes apply to every tenant: Default only) */}
      {admin && !isDefaultTenant && (
        <p className="text-sm text-text-muted">
          {t('bans.dangerZoneDefaultOnly', 'Switch to the Default tenant to use the danger zone: wipes apply to every tenant.')}
        </p>
      )}
      {admin && isDefaultTenant && (
        <div>
          <h2 className="text-lg font-semibold text-status-down mb-4">{t('settings.danger.title', { defaultValue: 'Danger Zone' })}</h2>
          <div className="rounded-lg border border-status-down/30 bg-status-down/5 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">{t('settings.danger.wipeBansLabel', { defaultValue: 'Wipe all banned IPs' })}</p>
                <p className="text-xs text-text-muted">
                  {t('settings.danger.wipeBansDesc', { defaultValue: 'Lift all active bans. Agents will unblock all IPs on next sync.' })}
                </p>
              </div>
              <button onClick={() => void wipeAllBans()} className="px-4 py-2 rounded-md text-sm font-medium text-status-down border border-status-down/40 hover:bg-status-down/10 transition-colors whitespace-nowrap">
                {t('settings.danger.wipeBans', { defaultValue: 'Wipe all bans' })}
              </button>
            </div>
            <div className="border-t border-status-down/20" />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">{t('settings.danger.wipeIpsTitle', { defaultValue: 'Wipe all IP data' })}</p>
                <p className="text-xs text-text-muted">
                  {t('settings.danger.wipeIpsDesc', { defaultValue: 'Delete all IP reputation entries and events. Cannot be undone.' })}
                </p>
              </div>
              <button onClick={() => void wipeAllIpData()} className="px-4 py-2 rounded-md text-sm font-medium text-white bg-status-down hover:bg-status-down/80 transition-colors whitespace-nowrap">
                {t('settings.danger.wipeIps', { defaultValue: 'Wipe all IPs' })}
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={smtpMode !== null}
        onClose={closeSmtpModal}
        title={smtpMode === 'create' ? t('settings.smtp.addTitle') : t('settings.smtp.editTitle')}
        size="sm"
        closeOnBackdrop={false}
        dismissible={!smtpSaving}
      >
        <form onSubmit={handleSmtpSubmit} className="space-y-3">
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
            <IconButton
              label={showPassword ? t('settings.hideSecret', 'Hide') : t('settings.showSecret', 'Show')}
              icon={showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              variant="plain"
              size="xs"
              touchTarget="overlay"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 bottom-2"
            />
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
      </Modal>
    </PageContainer>
  );
}

// ── Data Retention Section ───────────────────────────────────────────────────
// Purge windows of the hourly retention job (server retention.service.ts),
// stored in app_config retention.* with the env as fallback. Bounds come
// from the server (GET /admin/config/retention), which validates again.

type RetentionKey = 'eventsDays' | 'reputationDays' | 'banHistoryDays' | 'auditDays';
const RETENTION_FIELDS: RetentionKey[] = ['eventsDays', 'reputationDays', 'banHistoryDays', 'auditDays'];

interface RetentionSettingView {
  value: number | null;
  effective: number;
  fallback: number;
  default: number;
  min: number;
  max: number;
  env: string | null;
  envValue: number | null;
}
type RetentionView = Record<RetentionKey, RetentionSettingView>;

/** Input text of a stored value ('' = nothing stored: env fallback / default). */
const retentionText = (v: RetentionSettingView): string => (v.value != null ? String(v.value) : '');

function DataRetentionSection() {
  const { t } = useTranslation();
  const [view, setView] = useState<RetentionView | null>(null);
  const [draft, setDraft] = useState<Record<RetentionKey, string>>({ eventsDays: '', reputationDays: '', banHistoryDays: '', auditDays: '' });
  const [saving, setSaving] = useState(false);

  const applyView = useCallback((v: RetentionView) => {
    setView(v);
    setDraft({
      eventsDays: retentionText(v.eventsDays),
      reputationDays: retentionText(v.reputationDays),
      banHistoryDays: retentionText(v.banHistoryDays),
      auditDays: retentionText(v.auditDays),
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: RetentionView }>('/admin/config/retention');
      applyView(res.data.data);
    } catch {
      toastLoadError(
        t('settings.retention.loadFailed', { defaultValue: 'Failed to load the data retention settings' }),
        t('common.retry', { defaultValue: 'Retry' }),
        () => void load(),
      );
    }
  }, [t, applyView]);

  useEffect(() => { void load(); }, [load]);

  const labels: Record<RetentionKey, { label: string; desc: string }> = {
    eventsDays: {
      label: t('settings.retention.eventsDays', { defaultValue: 'Connection events' }),
      desc: t('settings.retention.eventsDaysDesc', { defaultValue: 'Raw auth events (live events, IP timelines). Dashboard trends are kept in snapshots.' }),
    },
    reputationDays: {
      label: t('settings.retention.reputationDays', { defaultValue: 'IP reputation' }),
      desc: t('settings.retention.reputationDaysDesc', { defaultValue: 'IPs not seen for this long are forgotten. Banned and whitelisted IPs are always kept.' }),
    },
    banHistoryDays: {
      label: t('settings.retention.banHistoryDays', { defaultValue: 'Ban history' }),
      desc: t('settings.retention.banHistoryDaysDesc', { defaultValue: 'Lifted and expired bans, counted from when they ended. Active bans are never purged.' }),
    },
    auditDays: {
      label: t('settings.retention.auditDays', { defaultValue: 'Audit log' }),
      desc: t('settings.retention.auditDaysDesc', { defaultValue: 'Audit entries older than this are deleted.' }),
    },
  };

  /** Validation message of one field, null when valid ('' is valid: back to the fallback). */
  const fieldError = (k: RetentionKey): string | null => {
    if (!view) return null;
    const raw = draft[k].trim();
    if (raw === '') return null;
    const { min, max } = view[k];
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) {
      return t('settings.retention.range', { min, max, defaultValue: 'Enter a whole number of days between {{min}} and {{max}}' });
    }
    return null;
  };

  const hasErrors = RETENTION_FIELDS.some((k) => fieldError(k) !== null);
  const dirty = !!view && RETENTION_FIELDS.some((k) => draft[k].trim() !== retentionText(view[k]));

  const save = async () => {
    if (!view || hasErrors) return;
    // Only the changed fields; an emptied field is sent as null (reset).
    const patch: Partial<Record<RetentionKey, number | null>> = {};
    for (const k of RETENTION_FIELDS) {
      const raw = draft[k].trim();
      const next = raw === '' ? null : Number(raw);
      if (next !== view[k].value) patch[k] = next;
    }
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      const res = await apiClient.put<{ data: RetentionView }>('/admin/config/retention', patch);
      applyView(res.data.data);
      toast.success(t('settings.retention.saved', { defaultValue: 'Data retention saved' }));
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.retention.saveFailed', { defaultValue: 'Failed to save the data retention settings' }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Database size={16} className="text-accent" />
        <h2 className="text-lg font-semibold text-text-primary">{t('settings.retention.title', { defaultValue: 'Data retention' })}</h2>
      </div>
      <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
        <p className="text-xs text-text-muted">
          {t('settings.retention.description', {
            defaultValue: 'How long Obliguard keeps its data, for every tenant. Older rows are purged hourly. Leave a field empty to use the default.',
          })}
        </p>
        {!view ? (
          <p className="text-sm text-text-muted animate-pulse">{t('common.loading', { defaultValue: 'Loading…' })}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
            {RETENTION_FIELDS.map((k) => {
              const v = view[k];
              const error = fieldError(k);
              return (
                <div key={k} className="space-y-1">
                  <div className="max-w-[12rem]">
                    <Input
                      id={`retention-${k}`}
                      label={labels[k].label}
                      type="number"
                      inputMode="numeric"
                      min={v.min}
                      max={v.max}
                      step={1}
                      value={draft[k]}
                      placeholder={String(v.fallback)}
                      onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                      error={error ?? undefined}
                      disabled={saving}
                    />
                  </div>
                  <p className="text-xs text-text-muted">{labels[k].desc}</p>
                  <p className="text-[11px] text-text-muted">
                    {t('settings.retention.effective', { days: v.effective, defaultValue: 'Applied: {{days}} days' })}
                    {' · '}
                    {v.envValue != null && v.env
                      ? t('settings.retention.envFallback', { env: v.env, days: v.envValue, defaultValue: 'Default from {{env}}: {{days}} days' })
                      : t('settings.retention.default', { days: v.default, defaultValue: 'Default: {{days}} days' })}
                    {' · '}
                    {t('settings.retention.bounds', { min: v.min, max: v.max, defaultValue: '{{min}} to {{max}} days' })}
                  </p>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" loading={saving} disabled={!view || hasErrors || !dirty} onClick={() => void save()}>
            {t('common.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Obli.tools Contribution Section ──────────────────────────────────────────
// The remote blocklists themselves (pulling lists) moved to Policies > Remote
// blocklists (components/settings/RemoteBlocklistsSection.tsx); sharing our
// own auto-bans with Obli.tools is an instance setting and stays here.

function ObliToolsContributionSection({ isDefaultTenant }: { isDefaultTenant: boolean }) {
  const { t } = useTranslation();
  const [pushEnabled, setPushEnabled] = useState(false);
  const [instanceName, setInstanceName] = useState('');
  const [pushApiKey, setPushApiKey] = useState('');
  const [lastPush, setLastPush] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);

  const loadPushConfig = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: Record<string, string | null> }>('/admin/config');
      const cfg = res.data?.data ?? {};
      setPushEnabled(cfg.oblitools_push_enabled === 'true');
      setInstanceName(cfg.oblitools_instance_name ?? '');
      setPushApiKey(cfg.oblitools_api_key ? '••••••••' : '');
      setLastPush(cfg.oblitools_last_push_at ?? null);
    } catch {
      toastLoadError(
        t('settings.blocklists.pushConfigLoadFailed', { defaultValue: 'Failed to load the Obli.tools contribution settings' }),
        t('common.retry', { defaultValue: 'Retry' }),
        () => void loadPushConfig(),
      );
    }
  }, [t]);

  useEffect(() => { void loadPushConfig(); }, [loadPushConfig]);

  const savePushConfig = async () => {
    setSaving(true);
    try {
      await apiClient.put('/admin/config/oblitools_push_enabled', { value: pushEnabled ? 'true' : 'false' });
      await apiClient.put('/admin/config/oblitools_instance_name', { value: instanceName });
      // Only save the API key if the user typed a new one (not the masked placeholder)
      if (pushApiKey && !pushApiKey.startsWith('••')) {
        await apiClient.put('/admin/config/oblitools_api_key', { value: pushApiKey });
      }
      toast.success(t('settings.oblitools.saved', { defaultValue: 'Contribution settings saved' }));
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.oblitools.saveFailed', { defaultValue: 'Failed to save the contribution settings' }));
    } finally {
      setSaving(false);
    }
  };

  const pushNow = async () => {
    setPushing(true);
    try {
      const res = await apiClient.post<{ message?: string }>('/remote-blocklists/push-now');
      toast.success(res.data?.message ?? t('settings.oblitools.pushed', { defaultValue: 'Push completed' }));
      void loadPushConfig();
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.oblitools.pushFailed', { defaultValue: 'Push failed' }));
    } finally {
      setPushing(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Shield size={16} className="text-amber-400" />
        <h2 className="text-lg font-semibold text-text-primary">{t('settings.oblitools.title', { defaultValue: 'Obli.tools contribution' })}</h2>
      </div>
      <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
        <p className="text-xs text-text-muted">
          {t('settings.oblitools.description', {
            defaultValue: 'Share your auto-banned IPs with the Obli.tools community blocklist. Only non-local auto-banned IPs are shared. Manual bans and imported (remote) bans are never sent. Pulling lists is configured in Policies > Remote blocklists.',
          })}
        </p>
        <ToggleSwitch
          checked={pushEnabled}
          onChange={setPushEnabled}
          label={t('settings.oblitools.share', { defaultValue: 'Share auto-bans with Obli.tools' })}
        />
        {pushEnabled && (
          <div className="space-y-3 pt-2">
            <div className="max-w-xs">
              <Input
                label={t('settings.oblitools.instanceName', { defaultValue: 'Instance name' })}
                value={instanceName}
                onChange={e => setInstanceName(e.target.value)}
                placeholder="prod-obliguard-01"
              />
            </div>
            <div className="max-w-xs">
              <Input
                label={t('settings.oblitools.apiKey', { defaultValue: 'API key' })}
                type="password"
                value={pushApiKey}
                onChange={e => setPushApiKey(e.target.value)}
                onFocus={() => { if (pushApiKey.startsWith('••')) setPushApiKey(''); }}
                placeholder="oblg_xxxxxxxxxxxx"
                autoComplete="off"
              />
              <p className="text-[10px] text-text-muted mt-1">{t('settings.oblitools.apiKeyHint', { defaultValue: 'Bearer token for guard.obli.tools' })}</p>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" loading={saving} onClick={() => void savePushConfig()}>
            {t('common.save', { defaultValue: 'Save' })}
          </Button>
          {/* Pushing is an instance action: Default tenant only (server rule). */}
          {pushEnabled && isDefaultTenant && (
            <Button size="sm" variant="secondary" loading={pushing} onClick={() => void pushNow()}>
              {t('settings.oblitools.pushNow', { defaultValue: 'Push now' })}
            </Button>
          )}
        </div>
        {lastPush && (
          <p className="text-xs text-text-muted">
            {t('settings.oblitools.lastPush', { date: new Date(lastPush).toLocaleString(), defaultValue: 'Last push: {{date}}' })}
          </p>
        )}
      </div>
    </div>
  );
}
