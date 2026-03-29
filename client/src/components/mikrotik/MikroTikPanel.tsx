import { useState, useEffect } from 'react';
import { Router, Wifi, WifiOff, RefreshCw, CheckCircle, XCircle, Save } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { mikrotikApi } from '@/api/mikrotik.api';
import type { MikroTikCredentials } from '@obliview/shared';

interface Props {
  deviceId: number;
  mikrotikStatus?: 'online' | 'offline' | 'misconfigured';
}

export function MikroTikPanel({ deviceId, mikrotikStatus }: Props) {
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
    } catch {
      setCreds(null);
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
    } catch { /* toast error */ }
    finally { setSaving(false); }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary p-4">
        <p className="text-sm text-text-muted">Loading MikroTik configuration...</p>
      </div>
    );
  }

  if (!creds) return null;

  const inputCls = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';
  const labelCls = 'block text-[11px] font-medium text-text-muted mb-0.5';

  const statusInfo = mikrotikStatus === 'online'
    ? { icon: <Wifi size={12} className="text-status-up" />, label: 'Online', cls: 'text-status-up' }
    : mikrotikStatus === 'misconfigured'
    ? { icon: <WifiOff size={12} className="text-yellow-400" />, label: 'Misconfigured', cls: 'text-yellow-400' }
    : { icon: <WifiOff size={12} className="text-status-down" />, label: 'Offline', cls: 'text-status-down' };

  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Router size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">MikroTik Configuration</h2>
          <span className={`flex items-center gap-1 text-[11px] ${statusInfo.cls}`}>
            {statusInfo.icon}
            {statusInfo.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!editMode ? (
            <Button size="sm" variant="secondary" onClick={() => setEditMode(true)}>Edit</Button>
          ) : (
            <>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                <Save size={12} className="mr-1" />{saving ? 'Saving...' : 'Save'}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setEditMode(false); loadCredentials(); }}>Cancel</Button>
            </>
          )}
        </div>
      </div>

      <div className="p-4 space-y-3">
        {mikrotikStatus === 'misconfigured' && (
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 px-3 py-2 text-xs text-yellow-400">
            <strong>Misconfigured</strong> — No syslog received and no successful API connection yet.
            Make sure the MikroTik is configured to send syslog to this server and the API port is accessible.
            Use "Test Connection" below to verify API access.
          </div>
        )}

        {/* API Connection */}
        <div className="grid grid-cols-4 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>API Host</label>
            <input className={inputCls} value={apiHost} onChange={e => setApiHost(e.target.value)} disabled={!editMode} />
          </div>
          <div>
            <label className={labelCls}>Port</label>
            <input className={inputCls} type="number" value={apiPort} onChange={e => setApiPort(e.target.value)} disabled={!editMode} />
          </div>
          <div>
            <label className={labelCls}>Username</label>
            <input className={inputCls} value={apiUsername} onChange={e => setApiUsername(e.target.value)} disabled={!editMode} />
          </div>
        </div>

        {editMode && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>New Password (leave empty to keep)</label>
              <input className={inputCls} type="password" value={apiPassword} onChange={e => setApiPassword(e.target.value)} placeholder="********" />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
                <input type="checkbox" checked={apiUseTls} onChange={e => setApiUseTls(e.target.checked)} className="rounded border-border" />
                TLS (port 8729)
              </label>
            </div>
          </div>
        )}

        {/* Syslog */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Syslog Source IP</label>
            <input className={inputCls} value={syslogIdentifier} onChange={e => setSyslogIdentifier(e.target.value)} disabled={!editMode} />
          </div>
          <div>
            <label className={labelCls}>Last Syslog</label>
            <p className="text-sm text-text-primary mt-1">{creds.lastSyslogAt ? new Date(creds.lastSyslogAt).toLocaleString() : 'Never'}</p>
          </div>
        </div>

        {/* Address Lists */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Ban List (export to MikroTik)</label>
            <input className={inputCls} value={addressListName} onChange={e => setAddressListName(e.target.value)} disabled={!editMode} />
          </div>
          <div>
            <label className={labelCls}>Import Lists (from MikroTik)</label>
            <input className={inputCls} value={importAddressLists} onChange={e => setImportAddressLists(e.target.value)} disabled={!editMode} placeholder="blacklist, honeypot" />
          </div>
        </div>

        {/* Status */}
        {creds.lastApiError && (
          <div className="rounded-md bg-status-down/10 px-3 py-2 text-xs text-status-down">
            Last API error: {creds.lastApiError}
          </div>
        )}
        {creds.lastApiConnectedAt && (
          <p className="text-[11px] text-text-muted">
            Last API connection: {new Date(creds.lastApiConnectedAt).toLocaleString()}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1 border-t border-border">
          <Button size="sm" variant="secondary" onClick={handleTest} disabled={testing}>
            {testing ? <RefreshCw size={12} className="animate-spin mr-1" /> : <Wifi size={12} className="mr-1" />}
            {testing ? 'Testing...' : 'Test Connection'}
          </Button>
          <Button size="sm" variant="secondary" onClick={handleSync} disabled={syncing}>
            {syncing ? <RefreshCw size={12} className="animate-spin mr-1" /> : <RefreshCw size={12} className="mr-1" />}
            {syncing ? 'Syncing...' : 'Sync Bans'}
          </Button>
        </div>

        {testResult && (
          <div className={`rounded-md px-3 py-2 text-xs ${testResult.success ? 'bg-status-up/10 text-status-up' : 'bg-status-down/10 text-status-down'}`}>
            {testResult.success ? (
              <span className="flex items-center gap-1"><CheckCircle size={12} /> Connected — Identity: {testResult.identity}</span>
            ) : (
              <span className="flex items-center gap-1"><XCircle size={12} /> {testResult.error}</span>
            )}
          </div>
        )}

        {syncResult && (
          <div className={`rounded-md px-3 py-2 text-xs ${syncResult.error ? 'bg-status-down/10 text-status-down' : 'bg-status-up/10 text-status-up'}`}>
            {syncResult.error
              ? `Sync failed: ${syncResult.error}`
              : `Sync complete — ${syncResult.added} added, ${syncResult.removed} removed`}
          </div>
        )}
      </div>
    </div>
  );
}
