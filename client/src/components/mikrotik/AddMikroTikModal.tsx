import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Router, Copy, Check, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { mikrotikApi } from '@/api/mikrotik.api';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function CopyBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      toast.error(t('mikrotik.add.copyFailed', { defaultValue: 'Could not copy — select the command and copy it manually' }));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative rounded-md bg-bg-tertiary p-3 pr-10 group">
      <code className="text-[11px] font-mono text-text-primary whitespace-pre-wrap break-all leading-relaxed">{code}</code>
      <IconButton
        label={t('common.copy')}
        icon={copied ? <Check size={13} className="text-status-up" /> : <Copy size={13} />}
        onClick={() => void handleCopy()}
        size="sm"
        touchTarget="overlay"
        className="absolute top-2 right-2"
      />
    </div>
  );
}

export function AddMikroTikModal({ open, onClose, onCreated }: Props) {
  const { t } = useTranslation();
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
      setError(err?.response?.data?.error || err.message || t('mikrotik.add.createFailed', { defaultValue: 'Failed to create device' }));
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

  const cmdFirewallRule = `/ip firewall filter add chain=input action=drop src-address-list=${effectiveListName} comment="Obliguard blocklist" place-before=0`;

  const cmdFirewallRaw = `/ip firewall raw add chain=prerouting action=drop src-address-list=${effectiveListName} comment="Obliguard blocklist (raw)"`;

  const cmdApiUser = `/user add name=${apiUsername} group=full password=${apiPassword ? '***' : '<your-password>'}`;

  return (
    // Shared Modal (portal, focus trap, scroll lock, Escape). A backdrop tap
    // does not close it: the form holds credentials being typed. Blocking
    // while the device is being created.
    <Modal
      open
      onClose={handleClose}
      icon={<Router size={18} className="text-accent" />}
      title={step === 'form'
        ? t('mikrotik.add.title', { defaultValue: 'Add MikroTik Device' })
        : t('mikrotik.add.commandsTitle', { defaultValue: 'MikroTik Configuration Commands' })}
      size="lg"
      closeOnBackdrop={false}
      dismissible={!loading}
      className="bg-bg-primary sm:border sm:border-border"
      bodyClassName="p-6 max-sm:p-4"
    >
      {step === 'form' ? (
        /* ── Step 1: Form ─────────────────────────────────────────────────── */
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{t('mikrotik.add.displayName', { defaultValue: 'Display Name' })}</label>
              <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder={t('mikrotik.add.displayNamePlaceholder', { defaultValue: 'Office Router' })} required />
            </div>
            <div>
              <label className={labelCls}>{t('mikrotik.add.hostname', { defaultValue: 'Hostname' })}</label>
              <input className={inputCls} value={hostname} onChange={e => setHostname(e.target.value)} placeholder="MikroTik" required />
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">{t('mikrotik.add.routerOsApi', { defaultValue: 'RouterOS API' })}</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={labelCls}>{t('mikrotik.add.apiHost', { defaultValue: 'API Host (IP)' })}</label>
                <input className={inputCls} value={apiHost} onChange={e => setApiHost(e.target.value)} placeholder="10.0.0.1" required />
              </div>
              <div>
                <label className={labelCls}>{t('mikrotik.add.port', { defaultValue: 'Port' })}</label>
                <input className={inputCls} type="number" value={apiPort} onChange={e => setApiPort(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <div>
                <label className={labelCls}>{t('common.username')}</label>
                <input className={inputCls} value={apiUsername} onChange={e => setApiUsername(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>{t('common.password')}</label>
                <input className={inputCls} type="password" value={apiPassword} onChange={e => setApiPassword(e.target.value)} required />
              </div>
            </div>
            <label className="flex items-center gap-2 mt-2 text-xs text-text-muted cursor-pointer">
              <input type="checkbox" checked={apiUseTls} onChange={e => {
                setApiUseTls(e.target.checked);
                setApiPort(e.target.checked ? '8729' : '8728');
              }} className="rounded border-border" />
              {t('mikrotik.add.useTls', { defaultValue: 'Use TLS (port 8729)' })}
            </label>
            {apiUseTls && (
              <p className="text-[10px] text-text-muted mt-0.5">
                {t('mikrotik.tls.pinOnFirstUse', { defaultValue: 'The router certificate is pinned on the first successful connection; a different certificate is then refused.' })}
              </p>
            )}
          </div>

          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">{t('mikrotik.add.addressLists', { defaultValue: 'Address Lists' })}</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{t('mikrotik.add.banList', { defaultValue: 'Ban List (export)' })}</label>
                <input className={inputCls} value={addressListName} onChange={e => setAddressListName(e.target.value)} />
                <p className="text-[10px] text-text-muted mt-0.5">{t('mikrotik.add.banListHint', { defaultValue: 'Obliguard pushes bans here' })}</p>
              </div>
              <div>
                <label className={labelCls}>{t('mikrotik.add.importLists', { defaultValue: 'Import Lists' })}</label>
                <input className={inputCls} value={importAddressLists} onChange={e => setImportAddressLists(e.target.value)} placeholder={t('mikrotik.add.importListsPlaceholder', { defaultValue: 'blacklist, honeypot' })} />
                <p className="text-[10px] text-text-muted mt-0.5">{t('mikrotik.add.importListsHint', { defaultValue: 'Comma-separated. IPs here become global bans.' })}</p>
              </div>
            </div>
          </div>

          {error && <p className="text-xs text-status-down">{error}</p>}

          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={loading} className="flex-1">
              {loading
                ? t('mikrotik.add.creating', { defaultValue: 'Creating...' })
                : t('mikrotik.add.createAndShow', { defaultValue: 'Create & Show Commands' })}
              {!loading && <ChevronRight size={14} className="ml-1" />}
            </Button>
            <Button variant="secondary" onClick={handleClose} type="button">{t('common.cancel')}</Button>
          </div>
        </form>
      ) : (
        /* ── Step 2: RouterOS commands ─────────────────────────────────────── */
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {t('mikrotik.add.created', { defaultValue: 'Device created. Run these commands on your MikroTik via Terminal or Winbox CLI:' })}
          </p>

          {/* 1. Enable API */}
          <div>
            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
              {t('mikrotik.add.step1', { defaultValue: '1. Enable RouterOS API' })}
            </p>
            <CopyBlock code={cmdEnableApi} />
          </div>

          {/* 2. Firewall drop rule */}
          <div>
            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
              {t('mikrotik.add.step2', { defaultValue: '2. Add firewall drop rule for blocklist' })}
            </p>
            <p className="text-[11px] text-text-muted mb-1.5">
              {t('mikrotik.add.step2Hint', { defaultValue: 'Choose one (filter = standard, raw = higher performance for heavy traffic):' })}
            </p>
            <div className="space-y-2">
              <div>
                <span className="text-[10px] text-text-muted font-medium uppercase">{t('mikrotik.add.filterRecommended', { defaultValue: 'Filter (recommended)' })}</span>
                <CopyBlock code={cmdFirewallRule} />
              </div>
              <div>
                <span className="text-[10px] text-text-muted font-medium uppercase">{t('mikrotik.add.rawAdvanced', { defaultValue: 'Raw (advanced)' })}</span>
                <CopyBlock code={cmdFirewallRaw} />
              </div>
            </div>
          </div>

          {/* 3. API user (optional) */}
          <div>
            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
              {t('mikrotik.add.step3', { defaultValue: '3. Create dedicated API user (optional, recommended)' })}
            </p>
            <CopyBlock code={cmdApiUser} />
            <p className="text-[10px] text-text-muted mt-1">
              {t('mikrotik.add.step3Hint', { defaultValue: 'If you use an existing user, skip this step. Ensure the user has read/write access to firewall address-lists.' })}
            </p>
          </div>

          {/* Import lists info */}
          {importAddressLists && (
            <div className="rounded-md bg-accent/10 px-3 py-2 text-xs text-accent">
              {t('mikrotik.add.importEnabled', { defaultValue: 'Import enabled for:' })} <strong>{importAddressLists}</strong> — {t('mikrotik.add.importEnabledHint', { defaultValue: 'Obliguard will poll these address-lists every 60s and auto-ban new IPs globally.' })}
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-border">
            <Button onClick={handleClose} className="flex-1">{t('mikrotik.add.done', { defaultValue: 'Done' })}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
