import { useState, useEffect } from 'react';
import { Key, Copy, Check, ChevronDown, Monitor, Terminal, Apple, Download, X, FolderOpen } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import apiClient from '@/api/client';
import { agentApi } from '@/api/agent.api';
import { agentKeysApi, type AgentKey } from '@/api/agentKeys.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { useUiStore } from '@/store/uiStore';
import { saveBlob } from '@/utils/download';

/** 40 px touch target on coarse pointers (desktop size unchanged). */
const TOUCH_BTN = 'coarse:min-h-10 coarse:min-w-10 coarse:inline-flex coarse:items-center coarse:justify-center';

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    // Copying is the point of this modal: a failure (plain-http origin,
    // denied permission) must be visible.
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error(t('addAgent.copyFailed', 'Could not copy — select the command and copy it manually'));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <IconButton
      label={t('common.copy', 'Copy')}
      onClick={() => void handleCopy()}
      size="sm"
      className="shrink-0"
      icon={copied ? <Check size={14} className="text-status-up" /> : <Copy size={14} />}
    />
  );
}

/** Server error text of a failed blob request (the body is JSON `{ error }` or plain text). */
async function blobErrorMessage(err: unknown): Promise<string | null> {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (!(data instanceof Blob)) return null;
  try {
    const text = await data.text();
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      return parsed.error ?? parsed.message ?? null;
    } catch {
      return text.trim().slice(0, 200) || null;
    }
  } catch {
    return null;
  }
}

type OsTab = 'windows' | 'linux' | 'macos' | 'freebsd';

export function GlobalAddAgentModal() {
  const { t } = useTranslation();
  const { addAgentModalOpen, closeAddAgentModal } = useUiStore();
  // Active keys only (a disabled key cannot enrol). The list is masked: the
  // selected key's value is fetched on selection (reveal) for the commands.
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [keyValue, setKeyValue] = useState<{ id: number; key: string } | null>(null);
  const [agentVersion, setAgentVersion] = useState('1.0.0');
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [osTab, setOsTab] = useState<OsTab>('windows');
  const [windowsMode, setWindowsMode] = useState<'modern' | 'oldtls' | 'manual'>('modern');
  const [linuxMode, setLinuxMode] = useState<'modern' | 'manual'>('modern');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    if (!addAgentModalOpen) return;
    setKeyValue(null);
    Promise.all([
      agentKeysApi.list(),
      agentApi.getVersion().catch(() => ({ version: '1.0.0', downloadUrl: '' })),
    ]).then(([all, v]) => {
      const k = all.filter(key => key.isActive);
      setKeys(k);
      setAgentVersion(v.version);
      setSelectedKeyId(k.length === 1 ? k[0].id : null);
    }).catch(() => {
      toast.error(t('addAgent.loadKeysFailed', 'Failed to load API keys'));
    });
  }, [addAgentModalOpen, t]);

  // Full value of the selected key, for the install commands.
  useEffect(() => {
    if (!addAgentModalOpen || selectedKeyId == null) return;
    let cancelled = false;
    agentKeysApi.reveal(selectedKeyId)
      .then(key => { if (!cancelled) setKeyValue({ id: selectedKeyId, key }); })
      .catch(() => {
        if (cancelled) return;
        // Empty value for this id = read failed (no endless "Loading…").
        setKeyValue({ id: selectedKeyId, key: '' });
        toast.error(t('addAgent.revealFailed', 'Could not read the API key (disabled or deleted?)'));
      });
    return () => { cancelled = true; };
  }, [addAgentModalOpen, selectedKeyId, t]);

  if (!addAgentModalOpen) return null;

  const selectedKey = keys.find(k => k.id === selectedKeyId);
  // The revealed value of the selected key ('' until it arrived).
  const apiKey = selectedKey && keyValue?.id === selectedKey.id ? keyValue.key : '';
  const origin = window.location.origin;

  // ── Install commands (only meaningful once a key is picked and read) ───────
  const linuxCmd = apiKey ? `curl -fsSL "${agentApi.getInstallerLinuxUrl(apiKey)}" | bash` : '';
  const macosCmd = apiKey ? `sudo bash -c "$(curl -fsSL '${agentApi.getInstallerMacosUrl(apiKey)}')"` : '';
  const freebsdCmd = apiKey ? `fetch -qo - "${agentApi.getInstallerFreeBSDUrl(apiKey)}" | sh` : '';
  const msiUrl = agentApi.getMsiUrl();
  const windowsCmdModern = apiKey ? `$m="$env:TEMP\\obliguard-agent.msi"; Invoke-WebRequest "${msiUrl}" -OutFile $m -UseBasicParsing; Start-Process msiexec -ArgumentList "/i \`"$m\`" SERVERURL=\`"${origin}\`" APIKEY=\`"${apiKey}\`" /quiet" -Wait -Verb RunAs; Remove-Item $m` : '';
  const windowsCmdOldTls = apiKey ? `$m="$env:TEMP\\obliguard-agent.msi"; Import-Module BitsTransfer; Start-BitsTransfer -Source "${msiUrl}" -Destination $m; Start-Process msiexec -ArgumentList "/i \`"$m\`" SERVERURL=\`"${origin}\`" APIKEY=\`"${apiKey}\`" /quiet" -Wait -Verb RunAs; Remove-Item $m` : '';
  const windowsCmd = windowsMode === 'oldtls' ? windowsCmdOldTls : windowsCmdModern;

  const osTabs: Array<{ id: OsTab; label: string; icon: React.ReactNode }> = [
    { id: 'windows', label: 'Windows', icon: <Monitor size={14} /> },
    { id: 'linux', label: 'Linux', icon: <Terminal size={14} /> },
    { id: 'macos', label: 'macOS', icon: <Apple size={14} /> },
    { id: 'freebsd', label: 'FreeBSD', icon: <Terminal size={14} /> },
  ];

  /**
   * Offline wizard download (authenticated route, pre-baked with the selected
   * key + this server's URL). Fetched through the API client so the session /
   * ObliTools token and the tenant header go along, and a server refusal
   * (403, missing build, …) surfaces as a toast instead of a broken file.
   */
  const downloadWizard = async (route: 'wizard.exe' | 'wizard-linux-amd64', filename: string) => {
    if (!selectedKey || downloading) return;
    setDownloading(route);
    try {
      const res = await apiClient.get<Blob>(`/agent/installer/${route}`, {
        params: { keyId: selectedKey.id, server: origin },
        responseType: 'blob',
      });
      const ok = await saveBlob(res.data, filename, 'application/octet-stream');
      if (!ok) toast.error(t('addAgent.downloadFailed', 'Download failed'));
    } catch (err) {
      const detail = await blobErrorMessage(err);
      toast.error(detail
        ? `${t('addAgent.downloadFailed', 'Download failed')}: ${detail}`
        : t('addAgent.downloadFailed', 'Download failed'));
    } finally {
      setDownloading(null);
    }
  };

  const wizardButton = (route: 'wizard.exe' | 'wizard-linux-amd64', filename: string) => (
    <button
      type="button"
      onClick={() => void downloadWizard(route, filename)}
      disabled={downloading !== null}
      className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-60 coarse:min-h-10"
    >
      <Download size={13} className={downloading === route ? 'animate-pulse' : undefined} />
      {downloading === route
        ? t('common.downloading', 'Downloading…')
        : t('addAgent.manualDownload', 'Download wizard')}
    </button>
  );

  return (
    // Shared Modal: portal, focus trap, body scroll lock, Escape / backdrop
    // close. Its own header is not used (no title, showCloseButton={false})
    // so the historic look is kept: bg-primary card, max-w-xl, header with
    // the agent version that scrolls with the content, full-width Close.
    <Modal
      open
      onClose={closeAddAgentModal}
      ariaLabel={t('addAgent.title', 'Add Agent')}
      showCloseButton={false}
      className="bg-bg-primary sm:border sm:border-border sm:max-w-xl sm:max-h-[90dvh] sm:supports-[not(height:100dvh)]:max-h-[90vh]"
      bodyClassName="p-0"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:bg-bg-primary max-sm:px-4 max-sm:py-2">
        <div>
          <h2 className="text-base font-semibold text-text-primary">{t('addAgent.title', 'Add Agent')}</h2>
          <p className="text-xs text-text-muted mt-0.5">
            {t('addAgent.agentVersion', { version: agentVersion, defaultValue: 'Agent version: {{version}}' })}
          </p>
        </div>
        <button
          type="button"
          onClick={closeAddAgentModal}
          aria-label={t('common.close', 'Close')}
          className={`text-text-muted hover:text-text-primary text-xl leading-none ${TOUCH_BTN}`}
        >
          <span aria-hidden="true" className="coarse:hidden">&times;</span>
          <X size={20} aria-hidden="true" className="hidden coarse:block" />
        </button>
      </div>

      <div className="p-6 space-y-5 max-sm:p-4">
        {keys.length === 0 ? (
          <div className="text-center py-8">
            <Key size={28} className="mx-auto mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">{t('addAgent.noKeys', 'Create an API key first in the Agents page')}</p>
          </div>
        ) : (
          <>
            {/* API Key selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted uppercase">{t('addAgent.selectKey', 'API Key')}</label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setDropdownOpen(!dropdownOpen)}
                  aria-expanded={dropdownOpen}
                  className="w-full flex items-center gap-2 px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-left hover:border-accent/50 transition-colors"
                >
                  <Key size={14} className="text-accent shrink-0" />
                  {selectedKey ? (
                    <div className="flex-1 min-w-0 flex items-center gap-2 max-sm:flex-wrap max-sm:gap-x-2 max-sm:gap-y-0.5">
                      <span className="font-medium text-text-primary">{selectedKey.name}</span>
                      <code className="text-xs text-text-muted font-mono">{selectedKey.keyMasked}</code>
                      {selectedKey.defaultGroupName && (
                        <span className="text-xs text-accent truncate">→ {selectedKey.defaultGroupName}</span>
                      )}
                    </div>
                  ) : (
                    <span className="flex-1 text-text-muted">{t('addAgent.chooseKey', 'Select an API key...')}</span>
                  )}
                  <ChevronDown size={14} className="text-text-muted shrink-0" />
                </button>
                {dropdownOpen && (
                  <div className="mt-1 bg-bg-secondary border border-border rounded-lg overflow-hidden max-h-60 overflow-y-auto">
                    {keys.map(k => (
                      <button
                        key={k.id}
                        type="button"
                        onClick={() => { setSelectedKeyId(k.id); setDropdownOpen(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left transition-colors coarse:min-h-12 ${
                          selectedKeyId === k.id ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-bg-tertiary'
                        }`}
                      >
                        <Key size={14} className={selectedKeyId === k.id ? 'text-accent' : 'text-text-muted'} />
                        <span className="font-medium">{k.name}</span>
                        {k.defaultGroupName && (
                          <span className="text-xs text-text-muted truncate">→ {k.defaultGroupName}</span>
                        )}
                        <code className="text-xs text-text-muted font-mono ml-auto">{k.keyMasked}</code>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Target group of the new agents (the key's default group) */}
            {selectedKey && (
              <p className="flex items-start gap-1.5 text-xs text-text-muted">
                <FolderOpen size={13} className="shrink-0 mt-0.5" />
                {selectedKey.defaultGroupName
                  ? t('addAgent.targetGroup', { defaultValue: 'New agents land in the group {{group}} (pending approval).', group: selectedKey.defaultGroupName })
                  : t('addAgent.noTargetGroup', 'New agents land without a group (pending approval). Set a default group on the key in Agent config.')}
              </p>
            )}

            {/* Install commands (only when a key is selected and read) */}
            {selectedKey && !apiKey && (
              <p className="text-xs text-text-muted">
                {keyValue?.id === selectedKey.id
                  ? t('addAgent.revealFailed', 'Could not read the API key (disabled or deleted?)')
                  : t('common.loading', 'Loading…')}
              </p>
            )}
            {selectedKey && apiKey && (
              <div className="space-y-3">
                {/* OS tabs */}
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg-secondary p-1 sm:flex sm:items-center" role="tablist">
                  {osTabs.map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={osTab === tab.id}
                      onClick={() => setOsTab(tab.id)}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors coarse:min-h-10 ${
                        osTab === tab.id ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
                      }`}
                    >
                      {tab.icon}
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Command block */}
                <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
                  {osTab === 'windows' && (
                    <div className="p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2 max-sm:flex-col-reverse max-sm:items-stretch">
                        <p className="text-xs font-medium text-text-muted">
                          {windowsMode === 'oldtls'
                            ? t('addAgent.windowsOldTlsHint', 'Run in PowerShell (admin) — Server 2012 / 2016 (TLS fix)')
                            : windowsMode === 'manual'
                              ? t('addAgent.manualHint', 'Download the wizard EXE, copy it to the target (USB / RDP clipboard / share), double-click. MSI is embedded — no internet required on the target.')
                              : t('addAgent.windowsHint', 'Run in PowerShell (admin) — Windows 10+ / Server 2019+')}
                        </p>
                        <select
                          value={windowsMode}
                          onChange={e => setWindowsMode(e.target.value as typeof windowsMode)}
                          aria-label={t('addAgent.windowsVariant', 'Windows version')}
                          className="text-[11px] bg-bg-tertiary rounded px-1.5 py-1 text-text-muted coarse:min-h-10 coarse:px-2"
                        >
                          <option value="modern">Windows 10+</option>
                          <option value="oldtls">{t('addAgent.optionServer2012', 'Server 2012/2016')}</option>
                          <option value="manual">{t('addAgent.manualOption', 'Manual / offline (wizard)')}</option>
                        </select>
                      </div>
                      {windowsMode === 'manual' ? (
                        <div className="flex items-center justify-between gap-2 rounded-md bg-bg-tertiary p-3 max-sm:flex-col max-sm:items-stretch">
                          <div className="flex-1 text-xs text-text-secondary">
                            <div className="font-medium text-text-primary mb-0.5">
                              {t('addAgent.manualWizardTitle', 'Obliguard Install Wizard')}
                            </div>
                            <div className="text-text-muted leading-relaxed">
                              {t('addAgent.manualWizardDescription',
                                'EXE with the MSI embedded. Pre-filled with the selected API key. Run on the target — the two fields stay editable for last-minute corrections.')}
                            </div>
                          </div>
                          {wizardButton('wizard.exe', 'obliguard-installer-wizard.exe')}
                        </div>
                      ) : (
                        <div className="flex items-start gap-2 rounded-md bg-bg-tertiary p-3">
                          <code className="flex-1 text-xs font-mono text-text-primary break-all leading-relaxed">{windowsCmd}</code>
                          <CopyButton text={windowsCmd} />
                        </div>
                      )}
                    </div>
                  )}

                  {osTab === 'linux' && (
                    <div className="p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2 max-sm:flex-col-reverse max-sm:items-stretch">
                        <p className="text-xs font-medium text-text-muted">
                          {linuxMode === 'manual'
                            ? t('addAgent.linuxManualHint', 'Download the wizard binary, copy it to the target (scp / SFTP / USB), chmod +x and run as root. Agent is embedded — works on boxes with broken CA stores or no outbound HTTP.')
                            : t('addAgent.linuxHint', 'Run in a terminal (root or sudo)')}
                        </p>
                        <select
                          value={linuxMode}
                          onChange={e => setLinuxMode(e.target.value as typeof linuxMode)}
                          aria-label={t('addAgent.linuxVariant', 'Install method')}
                          className="text-[11px] bg-bg-tertiary rounded px-1.5 py-1 text-text-muted coarse:min-h-10 coarse:px-2"
                        >
                          <option value="modern">curl | bash</option>
                          <option value="manual">{t('addAgent.manualOption', 'Manual / offline (wizard)')}</option>
                        </select>
                      </div>
                      {linuxMode === 'manual' ? (
                        <div className="flex items-center justify-between gap-2 rounded-md bg-bg-tertiary p-3 max-sm:flex-col max-sm:items-stretch">
                          <div className="flex-1 text-xs text-text-secondary">
                            <div className="font-medium text-text-primary mb-0.5">
                              {t('addAgent.linuxManualTitle', 'Obliguard Install Wizard (Linux)')}
                            </div>
                            <div className="text-text-muted leading-relaxed">
                              {t('addAgent.linuxManualDescription',
                                'Static binary with the agent embedded. Pre-filled with the selected API key. Run as root — sets up systemd or SysV init automatically.')}
                            </div>
                          </div>
                          {wizardButton('wizard-linux-amd64', 'obliguard-installer-wizard-linux-amd64')}
                        </div>
                      ) : (
                        <div className="flex items-start gap-2 rounded-md bg-bg-tertiary p-3">
                          <code className="flex-1 text-xs font-mono text-text-primary break-all leading-relaxed">{linuxCmd}</code>
                          <CopyButton text={linuxCmd} />
                        </div>
                      )}
                    </div>
                  )}

                  {osTab === 'macos' && (
                    <div className="p-4 space-y-2">
                      <p className="text-xs font-medium text-text-muted">
                        {t('addAgent.macosHint', 'Run in a terminal (Apple Silicon & Intel — arch auto-detected)')}
                      </p>
                      <div className="flex items-start gap-2 rounded-md bg-bg-tertiary p-3">
                        <code className="flex-1 text-xs font-mono text-text-primary break-all leading-relaxed">{macosCmd}</code>
                        <CopyButton text={macosCmd} />
                      </div>
                    </div>
                  )}

                  {osTab === 'freebsd' && (
                    <div className="p-4 space-y-2">
                      <p className="text-xs font-medium text-text-muted">
                        {t('addAgent.freebsdHint', 'Run in a root shell on FreeBSD / OPNsense')}
                      </p>
                      <div className="flex items-start gap-2 rounded-md bg-bg-tertiary p-3">
                        <code className="flex-1 text-xs font-mono text-text-primary break-all leading-relaxed">{freebsdCmd}</code>
                        <CopyButton text={freebsdCmd} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Phone: the Close button sticks to the bottom of the scrolling sheet
          so it stays reachable (desktop: in flow, as before). */}
      <div className="px-6 pb-6 max-sm:sticky max-sm:bottom-0 max-sm:bg-bg-primary max-sm:px-4 max-sm:py-3">
        <Button variant="secondary" onClick={closeAddAgentModal} className="w-full">{t('common.close', 'Close')}</Button>
      </div>
    </Modal>
  );
}
