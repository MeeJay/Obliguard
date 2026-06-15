import { useState, useEffect } from 'react';
import { Key, Copy, Check, ChevronDown, Monitor, Terminal, Apple, Download } from 'lucide-react';
import type { AgentApiKey } from '@obliview/shared';
import { agentApi } from '@/api/agent.api';
import { Button } from '@/components/common/Button';
import { useUiStore } from '@/store/uiStore';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
      title="Copy"
    >
      {copied ? <Check size={14} className="text-status-up" /> : <Copy size={14} />}
    </button>
  );
}

type OsTab = 'windows' | 'linux' | 'macos' | 'freebsd';

export function GlobalAddAgentModal() {
  const { addAgentModalOpen, closeAddAgentModal } = useUiStore();
  const [keys, setKeys] = useState<AgentApiKey[]>([]);
  const [agentVersion, setAgentVersion] = useState('1.0.0');
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [osTab, setOsTab] = useState<OsTab>('windows');
  const [windowsMode, setWindowsMode] = useState<'modern' | 'oldtls' | 'manual'>('modern');
  const [linuxMode, setLinuxMode] = useState<'modern' | 'manual'>('modern');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  useEffect(() => {
    if (!addAgentModalOpen) return;
    Promise.all([
      agentApi.listKeys(),
      agentApi.getVersion().catch(() => ({ version: '1.0.0', downloadUrl: '' })),
    ]).then(([k, v]) => {
      setKeys(k);
      setAgentVersion(v.version);
      setSelectedKeyId(k.length === 1 ? k[0].id : null);
    });
  }, [addAgentModalOpen]);

  if (!addAgentModalOpen) return null;

  const selectedKey = keys.find(k => k.id === selectedKeyId);
  const origin = window.location.origin;

  // ── Install commands (only meaningful once a key is picked) ────────────────
  const linuxCmd = selectedKey ? `curl -fsSL "${agentApi.getInstallerLinuxUrl(selectedKey.key)}" | bash` : '';
  const macosCmd = selectedKey ? `sudo bash -c "$(curl -fsSL '${agentApi.getInstallerMacosUrl(selectedKey.key)}')"` : '';
  const freebsdCmd = selectedKey ? `fetch -qo - "${agentApi.getInstallerFreeBSDUrl(selectedKey.key)}" | sh` : '';
  const msiUrl = agentApi.getMsiUrl();
  const windowsCmdModern = selectedKey ? `$m="$env:TEMP\\obliguard-agent.msi"; Invoke-WebRequest "${msiUrl}" -OutFile $m -UseBasicParsing; Start-Process msiexec -ArgumentList "/i \`"$m\`" SERVERURL=\`"${origin}\`" APIKEY=\`"${selectedKey.key}\`" /quiet" -Wait -Verb RunAs; Remove-Item $m` : '';
  const windowsCmdOldTls = selectedKey ? `$m="$env:TEMP\\obliguard-agent.msi"; Import-Module BitsTransfer; Start-BitsTransfer -Source "${msiUrl}" -Destination $m; Start-Process msiexec -ArgumentList "/i \`"$m\`" SERVERURL=\`"${origin}\`" APIKEY=\`"${selectedKey.key}\`" /quiet" -Wait -Verb RunAs; Remove-Item $m` : '';
  const windowsCmd = windowsMode === 'oldtls' ? windowsCmdOldTls : windowsCmdModern;

  const osTabs: Array<{ id: OsTab; label: string; icon: React.ReactNode }> = [
    { id: 'windows', label: 'Windows', icon: <Monitor size={14} /> },
    { id: 'linux', label: 'Linux', icon: <Terminal size={14} /> },
    { id: 'macos', label: 'macOS', icon: <Apple size={14} /> },
    { id: 'freebsd', label: 'FreeBSD', icon: <Terminal size={14} /> },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={closeAddAgentModal}>
      <div className="w-full max-w-xl rounded-xl border border-border bg-bg-primary shadow-2xl overflow-y-auto max-h-[90vh]" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Add Agent</h2>
            <p className="text-xs text-text-muted mt-0.5">Agent version: {agentVersion}</p>
          </div>
          <button onClick={closeAddAgentModal} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-5">
          {keys.length === 0 ? (
            <div className="text-center py-8">
              <Key size={28} className="mx-auto mb-2 text-text-muted" />
              <p className="text-sm text-text-muted">Create an API Key first in the Agents page</p>
            </div>
          ) : (
            <>
              {/* API Key selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted uppercase">API Key</label>
                <div className="relative">
                  <button
                    onClick={() => setDropdownOpen(!dropdownOpen)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-left hover:border-accent/50 transition-colors"
                  >
                    <Key size={14} className="text-accent shrink-0" />
                    {selectedKey ? (
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="font-medium text-text-primary">{selectedKey.name}</span>
                        <code className="text-xs text-text-muted font-mono">{selectedKey.key.slice(0, 8)}...{selectedKey.key.slice(-4)}</code>
                      </div>
                    ) : (
                      <span className="flex-1 text-text-muted">Choose an API key…</span>
                    )}
                    <ChevronDown size={14} className="text-text-muted shrink-0" />
                  </button>
                  {dropdownOpen && (
                    <div className="mt-1 bg-bg-secondary border border-border rounded-lg overflow-hidden max-h-60 overflow-y-auto">
                      {keys.map(k => (
                        <button
                          key={k.id}
                          onClick={() => { setSelectedKeyId(k.id); setDropdownOpen(false); }}
                          className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left transition-colors ${
                            selectedKeyId === k.id ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-bg-tertiary'
                          }`}
                        >
                          <Key size={14} className={selectedKeyId === k.id ? 'text-accent' : 'text-text-muted'} />
                          <span className="font-medium">{k.name}</span>
                          <code className="text-xs text-text-muted font-mono ml-auto">{k.key.slice(0, 8)}...</code>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Install commands (only when a key is selected) */}
              {selectedKey && (
                <div className="space-y-3">
                  {/* OS tabs */}
                  <div className="flex items-center gap-1 rounded-lg bg-bg-secondary p-1">
                    {osTabs.map(tab => (
                      <button
                        key={tab.id}
                        onClick={() => setOsTab(tab.id)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
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
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-text-muted">
                            {windowsMode === 'oldtls' ? 'Run in PowerShell (admin) — Server 2012 / 2016 (TLS fix)'
                              : windowsMode === 'manual' ? 'Download the wizard EXE, copy it to the target (USB / RDP clipboard / share), double-click. MSI is embedded — no internet required on the target.'
                              : 'Run in PowerShell (admin) — Windows 10+ / Server 2019+'}
                          </p>
                          <select
                            value={windowsMode}
                            onChange={e => setWindowsMode(e.target.value as typeof windowsMode)}
                            className="text-[11px] bg-bg-tertiary rounded px-1.5 py-1 text-text-muted"
                          >
                            <option value="modern">Windows 10+</option>
                            <option value="oldtls">Server 2012/2016</option>
                            <option value="manual">Manual / offline (wizard)</option>
                          </select>
                        </div>
                        {windowsMode === 'manual' ? (
                          <div className="flex items-center justify-between gap-2 rounded-md bg-bg-tertiary p-3">
                            <div className="flex-1 text-xs text-text-secondary">
                              <div className="font-medium text-text-primary mb-0.5">Obliguard Install Wizard</div>
                              <div className="text-text-muted leading-relaxed">
                                EXE with the MSI embedded. Pre-filled with the selected API key. Run on the target — the two fields stay editable for last-minute corrections.
                              </div>
                            </div>
                            <a
                              href={`/api/agent/installer/wizard.exe?keyId=${selectedKey.id}`}
                              download="obliguard-installer-wizard.exe"
                              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/80 transition-colors"
                            >
                              <Download size={13} /> Download wizard
                            </a>
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
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-text-muted">
                            {linuxMode === 'manual'
                              ? 'Download the wizard binary, copy it to the target (scp / SFTP / USB), chmod +x and run as root. Agent is embedded — works on boxes with broken CA stores or no outbound HTTP.'
                              : 'Run in a terminal (root or sudo)'}
                          </p>
                          <select
                            value={linuxMode}
                            onChange={e => setLinuxMode(e.target.value as typeof linuxMode)}
                            className="text-[11px] bg-bg-tertiary rounded px-1.5 py-1 text-text-muted"
                          >
                            <option value="modern">curl | bash</option>
                            <option value="manual">Manual / offline (wizard)</option>
                          </select>
                        </div>
                        {linuxMode === 'manual' ? (
                          <div className="flex items-center justify-between gap-2 rounded-md bg-bg-tertiary p-3">
                            <div className="flex-1 text-xs text-text-secondary">
                              <div className="font-medium text-text-primary mb-0.5">Obliguard Install Wizard (Linux)</div>
                              <div className="text-text-muted leading-relaxed">
                                Static binary with the agent embedded. Pre-filled with the selected API key. Run as root — sets up systemd or SysV init automatically.
                              </div>
                            </div>
                            <a
                              href={`/api/agent/installer/wizard-linux-amd64?keyId=${selectedKey.id}`}
                              download="obliguard-installer-wizard-linux-amd64"
                              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/80 transition-colors"
                            >
                              <Download size={13} /> Download wizard
                            </a>
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
                        <p className="text-xs font-medium text-text-muted">Run in a terminal (Apple Silicon &amp; Intel — arch auto-detected)</p>
                        <div className="flex items-start gap-2 rounded-md bg-bg-tertiary p-3">
                          <code className="flex-1 text-xs font-mono text-text-primary break-all leading-relaxed">{macosCmd}</code>
                          <CopyButton text={macosCmd} />
                        </div>
                      </div>
                    )}

                    {osTab === 'freebsd' && (
                      <div className="p-4 space-y-2">
                        <p className="text-xs font-medium text-text-muted">Run in a root shell on FreeBSD / OPNsense</p>
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

        <div className="px-6 pb-6">
          <Button variant="secondary" onClick={closeAddAgentModal} className="w-full">Close</Button>
        </div>
      </div>
    </div>
  );
}
