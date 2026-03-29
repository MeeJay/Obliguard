import { useState } from 'react';
import { Router, X } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { mikrotikApi } from '@/api/mikrotik.api';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddMikroTikModal({ open, onClose, onCreated }: Props) {
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
        syslogIdentifier: syslogIdentifier || apiHost,
        addressListName,
        importAddressLists: importAddressLists || undefined,
      });
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Failed to create device');
    } finally {
      setLoading(false);
    }
  };

  const inputCls = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent';
  const labelCls = 'block text-xs font-medium text-text-muted mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-bg-primary shadow-2xl overflow-y-auto max-h-[85vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Router size={18} className="text-accent" />
            <h2 className="text-base font-semibold text-text-primary">Add MikroTik Device</h2>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Identity */}
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

          {/* API Connection */}
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

          {/* Syslog */}
          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">Syslog</p>
            <div>
              <label className={labelCls}>Syslog Source IP</label>
              <input className={inputCls} value={syslogIdentifier} onChange={e => setSyslogIdentifier(e.target.value)} placeholder="Same as API Host if empty" />
              <p className="text-[10px] text-text-muted mt-0.5">IP from which the MikroTik sends syslog. Used to route incoming syslog to this device.</p>
            </div>
          </div>

          {/* Address Lists */}
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
              {loading ? 'Creating...' : 'Create MikroTik Device'}
            </Button>
            <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
