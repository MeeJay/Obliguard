import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Router, Wifi, WifiOff, RefreshCw, CheckCircle, XCircle, Save, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/common/Button';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { mikrotikApi } from '@/api/mikrotik.api';
import type { MikroTikCredentials } from '@obliview/shared';

/** The server's `error` message of a failed request, if any. */
function apiErrorMessage(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

interface Props {
  deviceId: number;
  mikrotikStatus?: 'online' | 'offline' | 'misconfigured';
}

export function MikroTikPanel({ deviceId, mikrotikStatus }: Props) {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const [resettingPin, setResettingPin] = useState(false);
  const [creds, setCreds] = useState<MikroTikCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; identity?: string; error?: string } | null>(null);
  const [syncResult, setSyncResult] = useState<{ added: number; removed: number; error?: string } | null>(null);
  const [editMode, setEditMode] = useState(false);

  // Edit fields
  const [apiHost, setApiHost] = useState('');
  const [apiPort, setApiPort] = useState('8728');
  const [apiUseTls, setApiUseTls] = useState(false);
  const [apiUsername, setApiUsername] = useState('');
  const [apiPassword, setApiPassword] = useState('');
  const [syslogIdentifier, setSyslogIdentifier] = useState('');
  const [addressListName, setAddressListName] = useState('');
  const [importAddressLists, setImportAddressLists] = useState('');

  useEffect(() => {
    loadCredentials();
  }, [deviceId]);

  async function loadCredentials() {
    setLoading(true);
    try {
      const c = await mikrotikApi.getCredentials(deviceId);
      setCreds(c);
      setApiHost(c.apiHost);
      setApiPort(String(c.apiPort));
      setApiUseTls(c.apiUseTls);
      setApiUsername(c.apiUsername);
      setSyslogIdentifier(c.syslogIdentifier);
      setAddressListName(c.addressListName);
      setImportAddressLists(c.importAddressLists || '');
    } catch (err) {
      setCreds(null);
      // The panel renders nothing without credentials: report it, with a Retry.
      toast.error((tst) => (
        <span className="flex items-center gap-3">
          <span>{apiErrorMessage(err) ?? t('mikrotik.panel.loadFailed', { defaultValue: 'Failed to load the MikroTik configuration' })}</span>
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-accent hover:underline"
            onClick={() => { toast.dismiss(tst.id); void loadCredentials(); }}
          >
            {t('common.retry')}
          </button>
        </span>
      ), { id: `mikrotik-load:${deviceId}` });
    } finally {
      setLoading(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await mikrotikApi.testConnection(deviceId);
      setTestResult(res);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await mikrotikApi.syncBans(deviceId);
      setSyncResult(res);
    } catch (err: any) {
      setSyncResult({ added: 0, removed: 0, error: err.message });
    } finally {
      setSyncing(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await mikrotikApi.updateCredentials(deviceId, {
        apiHost,
        apiPort: parseInt(apiPort, 10),
        apiUseTls,
        apiUsername,
        ...(apiPassword ? { apiPassword } : {}),
        syslogIdentifier,
        addressListName,
        importAddressLists: importAddressLists || null,
      });
      await loadCredentials();
      setEditMode(false);
      setApiPassword('');
    } catch (err) {
      toast.error(apiErrorMessage(err) ?? t('mikrotik.panel.saveFailed', { defaultValue: 'Failed to save the MikroTik configuration' }));
    }
    finally { setSaving(false); }
  }

  /** Forget the pinned API-SSL fingerprint (after a deliberate certificate change). */
  async function handleResetPin() {
    const ok = await askConfirm({
      title: t('mikrotik.tls.resetTitle', { defaultValue: 'Reset the pinned certificate' }),
      message: t('mikrotik.tls.resetMessage', {
        defaultValue: 'The next successful connection trusts and pins whatever certificate the router presents. Only do this after changing the router certificate yourself.',
      }),
      confirmLabel: t('mikrotik.tls.reset', { defaultValue: 'Reset pin' }),
      danger: true,
    });
    if (!ok) return;
    setResettingPin(true);
    try {
      await mikrotikApi.updateCredentials(deviceId, { resetTlsFingerprint: true });
      toast.success(t('mikrotik.tls.resetDone', { defaultValue: 'Pinned certificate cleared' }));
      await loadCredentials();
    } catch (err) {
      toast.error(apiErrorMessage(err) ?? t('mikrotik.tls.resetFailed', { defaultValue: 'Failed to reset the pinned certificate' }));
    } finally {
      setResettingPin(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary p-4">
        <p className="text-sm text-text-muted">{t('mikrotik.panel.loading', { defaultValue: 'Loading MikroTik configuration...' })}</p>
      </div>
    );
  }

  if (!creds) return null;

  const inputCls = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';
  const labelCls = 'block text-[11px] font-medium text-text-muted mb-0.5';

  const statusInfo = mikrotikStatus === 'online'
    ? { icon: <Wifi size={12} className="text-status-up" />, label: t('status.agent.online'), cls: 'text-status-up' }
    : mikrotikStatus === 'misconfigured'
    ? { icon: <WifiOff size={12} className="text-yellow-400" />, label: t('status.agent.misconfigured'), cls: 'text-yellow-400' }
    : { icon: <WifiOff size={12} className="text-status-down" />, label: t('status.agent.offline'), cls: 'text-status-down' };

  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Router size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">{t('mikrotik.panel.title', { defaultValue: 'MikroTik Configuration' })}</h2>
          <span className={`flex items-center gap-1 text-[11px] ${statusInfo.cls}`}>
            {statusInfo.icon}
            {statusInfo.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!editMode ? (
            <Button size="sm" variant="secondary" onClick={() => setEditMode(true)}>{t('common.edit')}</Button>
          ) : (
            <>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                <Save size={12} className="mr-1" />{saving ? t('common.saving') : t('common.save')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setEditMode(false); loadCredentials(); }}>{t('common.cancel')}</Button>
            </>
          )}
        </div>
      </div>

      <div className="p-4 space-y-3">
        {mikrotikStatus === 'misconfigured' && (
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 px-3 py-2 text-xs text-yellow-400">
            <strong>{t('status.agent.misconfigured')}</strong> — {t('mikrotik.panel.misconfiguredHint', { defaultValue: 'No syslog received and no successful API connection yet. Make sure the MikroTik is configured to send syslog to this server and the API port is accessible. Use "Test Connection" below to verify API access.' })}
          </div>
        )}

        {/* API Connection */}
        <div className="grid grid-cols-4 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>{t('mikrotik.panel.apiHost', { defaultValue: 'API Host' })}</label>
            <input className={inputCls} value={apiHost} onChange={e => setApiHost(e.target.value)} disabled={!editMode} />
          </div>
          <div>
            <label className={labelCls}>{t('mikrotik.add.port', { defaultValue: 'Port' })}</label>
            <input className={inputCls} type="number" value={apiPort} onChange={e => setApiPort(e.target.value)} disabled={!editMode} />
          </div>
          <div>
            <label className={labelCls}>{t('common.username')}</label>
            <input className={inputCls} value={apiUsername} onChange={e => setApiUsername(e.target.value)} disabled={!editMode} />
          </div>
        </div>

        {editMode && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{t('mikrotik.panel.newPassword', { defaultValue: 'New Password (leave empty to keep)' })}</label>
              <input className={inputCls} type="password" value={apiPassword} onChange={e => setApiPassword(e.target.value)} placeholder="********" />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
                <input type="checkbox" checked={apiUseTls} onChange={e => {
                  setApiUseTls(e.target.checked);
                  setApiPort(e.target.checked ? '8729' : '8728');
                }} className="rounded border-border" />
                {t('mikrotik.panel.tls', { defaultValue: 'TLS (port 8729)' })}
              </label>
            </div>
          </div>
        )}

        {/* API-SSL certificate pin (trust on first use) */}
        {creds.apiUseTls && (
          <div
            className={`rounded-md border px-3 py-2 text-xs ${creds.tlsFingerprintMismatch
              ? 'border-status-down/30 bg-status-down/10 text-status-down'
              : 'border-border bg-bg-tertiary text-text-secondary'}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              {creds.tlsFingerprintMismatch
                ? <ShieldAlert size={14} className="shrink-0" aria-hidden="true" />
                : creds.tlsFingerprint
                  ? <ShieldCheck size={14} className="shrink-0 text-status-up" aria-hidden="true" />
                  : <ShieldQuestion size={14} className="shrink-0 text-text-muted" aria-hidden="true" />}
              <span className="font-medium">
                {creds.tlsFingerprintMismatch
                  ? t('mikrotik.tls.mismatch', { defaultValue: 'Certificate changed: connections refused' })
                  : creds.tlsFingerprint
                    ? t('mikrotik.tls.pinned', { defaultValue: 'Certificate pinned' })
                    : t('mikrotik.tls.notPinned', { defaultValue: 'Certificate not pinned yet' })}
              </span>
              {creds.tlsFingerprint && (
                <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void handleResetPin()} disabled={resettingPin}>
                  {t('mikrotik.tls.reset', { defaultValue: 'Reset pin' })}
                </Button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-text-muted">
              {creds.tlsFingerprintMismatch
                ? t('mikrotik.tls.mismatchHint', { defaultValue: 'The router presented a different certificate than the pinned one; no credentials were sent. Reset the pin only if you changed the certificate yourself.' })
                : creds.tlsFingerprint
                  ? t('mikrotik.tls.pinnedHint', { defaultValue: 'Every connection must present this certificate.' })
                  : t('mikrotik.tls.notPinnedHint', { defaultValue: 'The certificate is pinned on the next successful connection.' })}
            </p>
            {creds.tlsFingerprint && (
              <p className="mt-1 break-all font-mono text-[10px] text-text-muted" title={t('mikrotik.tls.fingerprint', { defaultValue: 'SHA-256 fingerprint' })}>
                SHA-256 {creds.tlsFingerprint}
              </p>
            )}
          </div>
        )}

        {/* Syslog */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t('mikrotik.panel.syslogSource', { defaultValue: 'Syslog Source IP' })}</label>
            <input className={inputCls} value={syslogIdentifier} onChange={e => setSyslogIdentifier(e.target.value)} disabled={!editMode} />
          </div>
          <div>
            <label className={labelCls}>{t('mikrotik.panel.lastSyslog', { defaultValue: 'Last Syslog' })}</label>
            <p className="text-sm text-text-primary mt-1">{creds.lastSyslogAt ? new Date(creds.lastSyslogAt).toLocaleString() : t('common.never')}</p>
          </div>
        </div>

        {/* Address Lists */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t('mikrotik.panel.banList', { defaultValue: 'Ban List (export to MikroTik)' })}</label>
            <input className={inputCls} value={addressListName} onChange={e => setAddressListName(e.target.value)} disabled={!editMode} />
          </div>
          <div>
            <label className={labelCls}>{t('mikrotik.panel.importLists', { defaultValue: 'Import Lists (from MikroTik)' })}</label>
            <input className={inputCls} value={importAddressLists} onChange={e => setImportAddressLists(e.target.value)} disabled={!editMode} placeholder={t('mikrotik.add.importListsPlaceholder', { defaultValue: 'blacklist, honeypot' })} />
          </div>
        </div>

        {/* Status */}
        {creds.lastApiError && (
          <div className="rounded-md bg-status-down/10 px-3 py-2 text-xs text-status-down">
            {t('mikrotik.panel.lastApiError', { error: creds.lastApiError, defaultValue: 'Last API error: {{error}}' })}
          </div>
        )}
        {creds.lastApiConnectedAt && (
          <p className="text-[11px] text-text-muted">
            {t('mikrotik.panel.lastApiConnection', { date: new Date(creds.lastApiConnectedAt).toLocaleString(), defaultValue: 'Last API connection: {{date}}' })}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1 border-t border-border">
          <Button size="sm" variant="secondary" onClick={handleTest} disabled={testing}>
            {testing ? <RefreshCw size={12} className="animate-spin mr-1" /> : <Wifi size={12} className="mr-1" />}
            {testing
              ? t('mikrotik.panel.testing', { defaultValue: 'Testing...' })
              : t('mikrotik.panel.testConnection', { defaultValue: 'Test Connection' })}
          </Button>
          <Button size="sm" variant="secondary" onClick={handleSync} disabled={syncing}>
            {syncing ? <RefreshCw size={12} className="animate-spin mr-1" /> : <RefreshCw size={12} className="mr-1" />}
            {syncing
              ? t('mikrotik.panel.syncing', { defaultValue: 'Syncing...' })
              : t('mikrotik.panel.syncBans', { defaultValue: 'Sync Bans' })}
          </Button>
        </div>

        {testResult && (
          <div className={`rounded-md px-3 py-2 text-xs ${testResult.success ? 'bg-status-up/10 text-status-up' : 'bg-status-down/10 text-status-down'}`}>
            {testResult.success ? (
              <span className="flex items-center gap-1"><CheckCircle size={12} /> {t('mikrotik.panel.connected', { identity: testResult.identity ?? '', defaultValue: 'Connected — Identity: {{identity}}' })}</span>
            ) : (
              <span className="flex items-center gap-1"><XCircle size={12} /> {testResult.error}</span>
            )}
          </div>
        )}

        {syncResult && (
          <div className={`rounded-md px-3 py-2 text-xs ${syncResult.error ? 'bg-status-down/10 text-status-down' : 'bg-status-up/10 text-status-up'}`}>
            {syncResult.error
              ? t('mikrotik.panel.syncFailed', { error: syncResult.error, defaultValue: 'Sync failed: {{error}}' })
              : t('mikrotik.panel.syncComplete', { added: syncResult.added, removed: syncResult.removed, defaultValue: 'Sync complete — {{added}} added, {{removed}} removed' })}
          </div>
        )}
      </div>
    </div>
  );
}
