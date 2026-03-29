import { useState } from 'react';
import { Router, X, Copy, Check, ChevronRight } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { mikrotikApi } from '@/api/mikrotik.api';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative rounded-md bg-bg-tertiary p-3 pr-10 group">
      <code className="text-[11px] font-mono text-text-primary whitespace-pre-wrap break-all leading-relaxed">{code}</code>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
        title="Copy"
      >
        {copied ? <Check size={13} className="text-status-up" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

export function AddMikroTikModal({ open, onClose, onCreated }: Props) {
  const [step, setStep] = useState<'form' | 'commands'>('form');

  // Form state
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [apiHost, setApiHost] = useState('');
  const [apiPort, setApiPort] = useState('8728');
  const [apiUseTls, setApiUseTls] = useState(false);
  const [apiUsername, setApiUsername] = useState('admin');
  const [apiPassword, setApiPassword] = useState('');
  const [syslogIdentifier, setSyslogIdentifier] = useState('');
  const [addressListName, setAddressListName] = useState('obliguard_blocklist');
  const [importAddressLists, setImportAddressLists] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const serverHost = window.location.hostname;
  const syslogPort = '5514';
  const effectiveSyslogId = syslogIdentifier || apiHost;
  const effectiveListName = addressListName || 'obliguard_blocklist';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await mikrotikApi.createDevice({
        name,
        hostname,
        apiHost,
        apiPort: parseInt(apiPort, 10),
        apiUseTls,
        apiUsername,
        apiPassword,
        syslogIdentifier: effectiveSyslogId,
        addressListName: effectiveListName,
        importAddressLists: importAddressLists || undefined,
      });
      onCreated();
      setStep('commands');
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Failed to create device');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setStep('form');
    setName(''); setHostname(''); setApiHost(''); setApiPort('8728');
    setApiUseTls(false); setApiUsername('admin'); setApiPassword('');
    setSyslogIdentifier(''); setAddressListName('obliguard_blocklist');
    setImportAddressLists(''); setError('');
    onClose();
  };

  const inputCls = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent';
  const labelCls = 'block text-xs font-medium text-text-muted mb-1';

  // ── RouterOS commands ─────────────────────────────────────────────────────

  const cmdEnableApi = apiUseTls
    ? `/ip service set api-ssl disabled=no port=${apiPort}`
    : `/ip service set api disabled=no port=${apiPort}`;

  const cmdSyslog = `/system logging action set remote address=${serverHost} remote-port=${syslogPort} bsd-syslog=yes
/system logging add topics=critical,error,warning,info action=remote`;

  const cmdFirewallRule = `/ip firewall filter add chain=input action=drop src-address-list=${effectiveListName} comment="Obliguard blocklist" place-before=0`;

  const cmdFirewallRaw = `/ip firewall raw add chain=prerouting action=drop src-address-list=${effectiveListName} comment="Obliguard blocklist (raw)"`;

  const cmdApiUser = `/user add name=${apiUsername} group=full password=${apiPassword ? '***' : '<your-password>'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-bg-primary shadow-2xl overflow-y-auto max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Router size={18} className="text-accent" />
            <h2 className="text-base font-semibold text-text-primary">
              {step === 'form' ? 'Add MikroTik Device' : 'MikroTik Configuration Commands'}
            </h2>
          </div>
          <button onClick={handleClose} className="text-text-muted hover:text-text-primary"><X size={18} /></button>
        </div>

        {step === 'form' ? (
          /* ── Step 1: Form ─────────────────────────────────────────────────── */
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Display Name</label>
                <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="Office Router" required />
              </div>
              <div>
                <label className={labelCls}>Hostname</label>
                <input className={inputCls} value={hostname} onChange={e => setHostname(e.target.value)} placeholder="MikroTik" required />
              </div>
            </div>

            <div className="border-t border-border pt-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">RouterOS API</p>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className={labelCls}>API Host (IP)</label>
                  <input className={inputCls} value={apiHost} onChange={e => setApiHost(e.target.value)} placeholder="10.0.0.1" required />
                </div>
                <div>
                  <label className={labelCls}>Port</label>
                  <input className={inputCls} type="number" value={apiPort} onChange={e => setApiPort(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-2">
                <div>
                  <label className={labelCls}>Username</label>
                  <input className={inputCls} value={apiUsername} onChange={e => setApiUsername(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Password</label>
                  <input className={inputCls} type="password" value={apiPassword} onChange={e => setApiPassword(e.target.value)} required />
                </div>
              </div>
              <label className="flex items-center gap-2 mt-2 text-xs text-text-muted cursor-pointer">
                <input type="checkbox" checked={apiUseTls} onChange={e => setApiUseTls(e.target.checked)} className="rounded border-border" />
                Use TLS (port 8729)
              </label>
            </div>

            <div className="border-t border-border pt-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">Syslog</p>
              <div>
                <label className={labelCls}>Syslog Source IP</label>
                <input className={inputCls} value={syslogIdentifier} onChange={e => setSyslogIdentifier(e.target.value)} placeholder="Same as API Host if empty" />
                <p className="text-[10px] text-text-muted mt-0.5">IP from which the MikroTik sends syslog. Used to route incoming packets to this device.</p>
              </div>
            </div>

            <div className="border-t border-border pt-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">Address Lists</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Ban List (export)</label>
                  <input className={inputCls} value={addressListName} onChange={e => setAddressListName(e.target.value)} />
                  <p className="text-[10px] text-text-muted mt-0.5">Obliguard pushes bans here</p>
                </div>
                <div>
                  <label className={labelCls}>Import Lists</label>
                  <input className={inputCls} value={importAddressLists} onChange={e => setImportAddressLists(e.target.value)} placeholder="blacklist, honeypot" />
                  <p className="text-[10px] text-text-muted mt-0.5">Comma-separated. IPs here become global bans.</p>
                </div>
              </div>
            </div>

            {error && <p className="text-xs text-status-down">{error}</p>}

            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={loading} className="flex-1">
                {loading ? 'Creating...' : 'Create & Show Commands'}
                {!loading && <ChevronRight size={14} className="ml-1" />}
              </Button>
              <Button variant="secondary" onClick={handleClose} type="button">Cancel</Button>
            </div>
          </form>
        ) : (
          /* ── Step 2: RouterOS commands ─────────────────────────────────────── */
          <div className="p-6 space-y-4">
            <p className="text-sm text-text-secondary">
              Device created. Run these commands on your MikroTik via Terminal or Winbox CLI:
            </p>

            {/* 1. Enable API */}
            <div>
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                1. Enable RouterOS API
              </p>
              <CopyBlock code={cmdEnableApi} />
            </div>

            {/* 2. Syslog export */}
            <div>
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                2. Configure syslog export to Obliguard
              </p>
              <CopyBlock code={cmdSyslog} />
            </div>

            {/* 3. Firewall drop rule */}
            <div>
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                3. Add firewall drop rule for blocklist
              </p>
              <p className="text-[11px] text-text-muted mb-1.5">
                Choose one (filter = standard, raw = higher performance for heavy traffic):
              </p>
              <div className="space-y-2">
                <div>
                  <span className="text-[10px] text-text-muted font-medium uppercase">Filter (recommended)</span>
                  <CopyBlock code={cmdFirewallRule} />
                </div>
                <div>
                  <span className="text-[10px] text-text-muted font-medium uppercase">Raw (advanced)</span>
                  <CopyBlock code={cmdFirewallRaw} />
                </div>
              </div>
            </div>

            {/* 4. API user (optional) */}
            <div>
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                4. Create dedicated API user (optional, recommended)
              </p>
              <CopyBlock code={cmdApiUser} />
              <p className="text-[10px] text-text-muted mt-1">
                If you use an existing user, skip this step. Ensure the user has read/write access to firewall address-lists.
              </p>
            </div>

            {/* Import lists info */}
            {importAddressLists && (
              <div className="rounded-md bg-accent/10 px-3 py-2 text-xs text-accent">
                Import enabled for: <strong>{importAddressLists}</strong> — Obliguard will poll these address-lists every 60s and auto-ban new IPs globally.
              </div>
            )}

            <div className="flex gap-2 pt-2 border-t border-border">
              <Button onClick={handleClose} className="flex-1">Done</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
