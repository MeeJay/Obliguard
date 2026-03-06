import { useState, useEffect, type FormEvent } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Monitor, MonitorType } from '@obliview/shared';
import { MONITOR_TYPES, MONITOR_TYPE_LABELS } from '@obliview/shared';
import { monitorsApi } from '@/api/monitors.api';
import { useMonitorStore } from '@/store/monitorStore';
import { useGroupStore } from '@/store/groupStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { GroupPicker } from '@/components/common/GroupPicker';
import toast from 'react-hot-toast';

export function MonitorEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { addMonitor, updateMonitor: updateStoreMonitor } = useMonitorStore();
  const { fetchGroups, fetchTree, tree } = useGroupStore();
  const isNew = !id || id === 'new';

  // Check for clone data from navigation state
  const cloneData = (location.state as any)?.cloneData as Partial<Monitor> | undefined;

  const defaultForm: Partial<Monitor> = {
    name: '',
    type: 'http' as MonitorType,
    url: '',
    method: 'GET',
    intervalSeconds: null,   // null = inherit from group/global settings
    timeoutMs: null,
    maxRetries: null,
    retryIntervalSeconds: null,
    expectedStatusCodes: [200, 201, 204],
  };

  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Partial<Monitor>>(cloneData || defaultForm);

  // Load groups for the selector
  useEffect(() => {
    fetchGroups();
    fetchTree();
  }, [fetchGroups, fetchTree]);

  // Load existing monitor for editing
  useEffect(() => {
    if (!isNew) {
      monitorsApi.getById(parseInt(id!, 10)).then((monitor) => {
        setForm(monitor);
      }).catch(() => {
        toast.error(t('monitors.notFound'));
        navigate('/');
      });
    }
  }, [id, isNew, navigate, t]);

  const updateField = <K extends keyof Monitor>(key: K, value: Monitor[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  /** Strip fields that don't belong to the selected monitor type */
  const cleanFormForType = (data: Partial<Monitor>): Partial<Monitor> => {
    const cleaned = { ...data };
    const t = cleaned.type;

    // HTTP / JSON API fields
    if (t !== 'http' && t !== 'json_api') {
      cleaned.url = null;
      cleaned.method = undefined;
      cleaned.headers = null;
      cleaned.body = null;
      cleaned.expectedStatusCodes = null;
      cleaned.keyword = null;
      cleaned.keywordIsPresent = null;
      cleaned.ignoreSsl = false;
    }

    // JSON API specific
    if (t !== 'json_api') {
      cleaned.jsonPath = null;
      cleaned.jsonExpectedValue = null;
    }

    // Hostname / port (ping, tcp, dns, ssl, smtp)
    if (!['ping', 'tcp', 'dns', 'ssl', 'smtp'].includes(t!)) {
      cleaned.hostname = null;
      cleaned.port = null;
    }

    // DNS specific
    if (t !== 'dns') {
      cleaned.dnsRecordType = null;
      cleaned.dnsResolver = null;
      cleaned.dnsExpectedValue = null;
    }

    // SSL specific — sslWarnDays is also used for http/json_api SSL cert checking
    if (t !== 'ssl' && t !== 'http' && t !== 'json_api') {
      cleaned.sslWarnDays = null;
    }

    // SMTP specific
    if (t !== 'smtp') {
      cleaned.smtpHost = null;
      cleaned.smtpPort = null;
    }

    // Docker specific
    if (t !== 'docker') {
      cleaned.dockerHost = null;
      cleaned.dockerContainerName = null;
    }

    // Game server specific
    if (t !== 'game_server') {
      cleaned.gameType = null;
      cleaned.gameHost = null;
      cleaned.gamePort = null;
    }

    // Push specific
    if (t !== 'push') {
      cleaned.pushMaxIntervalSec = null;
    }

    // Script specific
    if (t !== 'script') {
      cleaned.scriptCommand = null;
      cleaned.scriptExpectedExit = null;
    }

    // Browser specific
    if (t !== 'browser') {
      cleaned.browserUrl = null;
      cleaned.browserKeyword = null;
      cleaned.browserKeywordIsPresent = null;
      cleaned.browserWaitForSelector = null;
      cleaned.browserScreenshotOnFailure = false;
    }

    // Value Watcher specific
    if (t !== 'value_watcher') {
      cleaned.valueWatcherUrl = null;
      cleaned.valueWatcherJsonPath = null;
      cleaned.valueWatcherOperator = null;
      cleaned.valueWatcherThreshold = null;
      cleaned.valueWatcherThresholdMax = null;
      cleaned.valueWatcherHeaders = null;
    }

    return cleaned;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const payload = cleanFormForType(form);

      if (isNew) {
        const monitor = await monitorsApi.create(payload);
        addMonitor(monitor);
        toast.success(t('monitors.created'));
        navigate(`/monitor/${monitor.id}`);
      } else {
        const monitor = await monitorsApi.update(parseInt(id!, 10), payload);
        updateStoreMonitor(monitor.id, monitor);
        toast.success(t('monitors.updated'));
        navigate(`/monitor/${monitor.id}`);
      }
    } catch (err) {
      toast.error(isNew ? t('monitors.failedCreate') : t('monitors.failedUpdate'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl">
      <Link
        to={isNew ? '/' : `/monitor/${id}`}
        className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4"
      >
        <ArrowLeft size={14} />
        {isNew ? t('monitors.backToDashboard') : t('monitors.backToMonitor')}
      </Link>

      <h1 className="text-2xl font-semibold text-text-primary mb-6">
        {isNew ? t('monitors.new') : t('monitors.edit')}
      </h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            {t('monitors.form.sectionGeneral')}
          </h2>

          <Input
            label={t('monitors.form.name')}
            value={form.name || ''}
            onChange={(e) => updateField('name', e.target.value)}
            placeholder={t('monitors.form.namePlaceholder')}
            required
          />

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">
              {t('monitors.form.monitorType')}
            </label>
            <select
              value={form.type || 'http'}
              onChange={(e) => updateField('type', e.target.value as MonitorType)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {MONITOR_TYPES.map((type) => (
                <option key={type} value={type}>
                  {MONITOR_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>

          <Input
            label={t('monitors.form.descriptionOptional')}
            value={form.description || ''}
            onChange={(e) => updateField('description', e.target.value || null)}
            placeholder={t('monitors.form.descriptionPlaceholder')}
          />

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">
              {t('monitors.form.group')}
            </label>
            <GroupPicker
              value={form.groupId ?? null}
              onChange={(groupId) => updateField('groupId', groupId)}
              tree={tree}
              placeholder={t('monitors.form.noGroup')}
            />
          </div>
        </div>

        {/* Type-specific fields */}
        {(form.type === 'http' || form.type === 'json_api') && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionHttp')}
            </h2>

            <Input
              label={t('monitors.form.url')}
              value={form.url || ''}
              onChange={(e) => updateField('url', e.target.value)}
              placeholder={t('monitors.form.urlPlaceholder')}
              required
            />

            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">{t('monitors.form.method')}</label>
              <select
                value={form.method || 'GET'}
                onChange={(e) => updateField('method', e.target.value)}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            <Input
              label={t('monitors.form.keyword')}
              value={form.keyword || ''}
              onChange={(e) => updateField('keyword', e.target.value || null)}
              placeholder={t('monitors.form.keywordPlaceholder')}
            />

            {(form.url || '').startsWith('https') && (
              <>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="ignore-ssl"
                    checked={form.ignoreSsl || false}
                    onChange={(e) => updateField('ignoreSsl', e.target.checked)}
                    className="h-4 w-4 rounded border-border bg-bg-tertiary text-accent focus:ring-accent"
                  />
                  <label htmlFor="ignore-ssl" className="text-sm text-text-secondary">
                    {t('monitors.form.ignoreSsl')}
                  </label>
                </div>
                {!form.ignoreSsl && (
                  <Input
                    label={t('monitors.form.sslWarnDays')}
                    type="number"
                    value={form.sslWarnDays ?? 30}
                    onChange={(e) => updateField('sslWarnDays', parseInt(e.target.value, 10) || 30)}
                    placeholder="30"
                  />
                )}
              </>
            )}

            {form.type === 'json_api' && (
              <>
                <Input
                  label={t('monitors.form.jsonPath')}
                  value={form.jsonPath || ''}
                  onChange={(e) => updateField('jsonPath', e.target.value || null)}
                  placeholder={t('monitors.form.jsonPathPlaceholder')}
                />
                <Input
                  label={t('monitors.form.expectedValue')}
                  value={form.jsonExpectedValue || ''}
                  onChange={(e) => updateField('jsonExpectedValue', e.target.value || null)}
                  placeholder={t('monitors.form.expectedValuePlaceholder')}
                />
              </>
            )}
          </div>
        )}

        {(form.type === 'ping' || form.type === 'tcp' || form.type === 'dns' || form.type === 'ssl' || form.type === 'smtp') && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionHost')}
            </h2>

            <Input
              label={t('monitors.form.hostname')}
              value={form.hostname || ''}
              onChange={(e) => updateField('hostname', e.target.value)}
              placeholder={t('monitors.form.hostnamePlaceholder')}
              required
            />

            {(form.type === 'tcp' || form.type === 'smtp') && (
              <Input
                label={t('monitors.form.port')}
                type="number"
                value={form.port ?? (form.type === 'smtp' ? 25 : '')}
                onChange={(e) => updateField('port', parseInt(e.target.value, 10) || null)}
                placeholder={form.type === 'smtp' ? '25' : '80'}
              />
            )}

            {form.type === 'dns' && (
              <>
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-text-secondary">{t('monitors.form.dnsRecordType')}</label>
                  <select
                    value={form.dnsRecordType || 'A'}
                    onChange={(e) => updateField('dnsRecordType', e.target.value)}
                    className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    {['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'PTR'].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <Input
                  label={t('monitors.form.dnsResolver')}
                  value={form.dnsResolver || ''}
                  onChange={(e) => updateField('dnsResolver', e.target.value || null)}
                  placeholder={t('monitors.form.dnsResolverPlaceholder')}
                />
                <Input
                  label={t('monitors.form.dnsExpected')}
                  value={form.dnsExpectedValue || ''}
                  onChange={(e) => updateField('dnsExpectedValue', e.target.value || null)}
                  placeholder={t('monitors.form.dnsExpectedPlaceholder')}
                />
              </>
            )}

            {form.type === 'ssl' && (
              <Input
                label={t('monitors.form.warnDays')}
                type="number"
                value={form.sslWarnDays ?? 30}
                onChange={(e) => updateField('sslWarnDays', parseInt(e.target.value, 10) || 30)}
                placeholder="30"
              />
            )}
          </div>
        )}

        {form.type === 'docker' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionDocker')}
            </h2>
            <Input
              label={t('monitors.form.dockerHost')}
              value={form.dockerHost || ''}
              onChange={(e) => updateField('dockerHost', e.target.value)}
              placeholder={t('monitors.form.dockerHostPlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.containerName')}
              value={form.dockerContainerName || ''}
              onChange={(e) => updateField('dockerContainerName', e.target.value)}
              placeholder={t('monitors.form.containerNamePlaceholder')}
              required
            />
          </div>
        )}

        {form.type === 'game_server' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionGame')}
            </h2>
            <Input
              label={t('monitors.form.gameType')}
              value={form.gameType || ''}
              onChange={(e) => updateField('gameType', e.target.value)}
              placeholder={t('monitors.form.gameTypePlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.gameHost')}
              value={form.gameHost || ''}
              onChange={(e) => updateField('gameHost', e.target.value)}
              placeholder={t('monitors.form.gameHostPlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.gamePort')}
              type="number"
              value={form.gamePort ?? ''}
              onChange={(e) => updateField('gamePort', parseInt(e.target.value, 10) || null)}
              placeholder={t('monitors.form.gamePortPlaceholder')}
            />
          </div>
        )}

        {form.type === 'push' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionPush')}
            </h2>
            <Input
              label={t('monitors.form.pushMaxInterval')}
              type="number"
              value={form.pushMaxIntervalSec ?? 300}
              onChange={(e) => updateField('pushMaxIntervalSec', parseInt(e.target.value, 10) || 300)}
              placeholder={t('monitors.form.pushMaxIntervalPlaceholder')}
            />
            {!isNew && form.pushToken && (
              <div className="space-y-1">
                <label className="block text-sm font-medium text-text-secondary">{t('monitors.form.pushUrl')}</label>
                <code className="block rounded-md bg-bg-tertiary p-2 text-xs text-accent break-all">
                  {window.location.origin}/api/heartbeat/{form.pushToken}
                </code>
              </div>
            )}
          </div>
        )}

        {form.type === 'script' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionScript')}
            </h2>
            <Input
              label={t('monitors.form.scriptCommand')}
              value={form.scriptCommand || ''}
              onChange={(e) => updateField('scriptCommand', e.target.value)}
              placeholder={t('monitors.form.scriptCommandPlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.scriptExpectedExit')}
              type="number"
              value={form.scriptExpectedExit ?? 0}
              onChange={(e) => updateField('scriptExpectedExit', parseInt(e.target.value, 10) || 0)}
              placeholder={t('monitors.form.scriptExpectedExitPlaceholder')}
            />
          </div>
        )}

        {form.type === 'browser' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionBrowser')}
            </h2>
            <p className="text-xs text-text-secondary">
              {t('monitors.form.browserDesc')}
            </p>
            <Input
              label={t('monitors.form.browserUrl')}
              value={form.browserUrl || ''}
              onChange={(e) => updateField('browserUrl', e.target.value)}
              placeholder={t('monitors.form.browserUrlPlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.browserWaitSelector')}
              value={form.browserWaitForSelector || ''}
              onChange={(e) => updateField('browserWaitForSelector', e.target.value || null)}
              placeholder={t('monitors.form.browserWaitSelectorPlaceholder')}
            />
            <Input
              label={t('monitors.form.browserKeyword')}
              value={form.browserKeyword || ''}
              onChange={(e) => updateField('browserKeyword', e.target.value || null)}
              placeholder={t('monitors.form.browserKeywordPlaceholder')}
            />
            {form.browserKeyword && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="browser-keyword-absent"
                  checked={form.browserKeywordIsPresent === false}
                  onChange={(e) => updateField('browserKeywordIsPresent', e.target.checked ? false : true)}
                  className="h-4 w-4 rounded border-border bg-bg-tertiary text-accent focus:ring-accent"
                />
                <label htmlFor="browser-keyword-absent" className="text-sm text-text-secondary">
                  {t('monitors.form.browserKeywordInverted')}
                </label>
              </div>
            )}
          </div>
        )}

        {form.type === 'value_watcher' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionValueWatcher')}
            </h2>
            <p className="text-xs text-text-secondary">
              {t('monitors.form.valueWatcherDesc')}
            </p>
            <Input
              label={t('monitors.form.valueWatcherUrl')}
              value={form.valueWatcherUrl || ''}
              onChange={(e) => updateField('valueWatcherUrl', e.target.value)}
              placeholder={t('monitors.form.valueWatcherUrlPlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.valueWatcherJsonPath')}
              value={form.valueWatcherJsonPath || ''}
              onChange={(e) => updateField('valueWatcherJsonPath', e.target.value)}
              placeholder={t('monitors.form.valueWatcherJsonPathPlaceholder')}
              required
            />
            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">{t('monitors.form.valueWatcherOperator')}</label>
              <select
                value={form.valueWatcherOperator || '>'}
                onChange={(e) => updateField('valueWatcherOperator', e.target.value)}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value=">">{t('monitors.form.opGt')}</option>
                <option value="<">{t('monitors.form.opLt')}</option>
                <option value=">=">{t('monitors.form.opGte')}</option>
                <option value="<=">{t('monitors.form.opLte')}</option>
                <option value="==">{t('monitors.form.opEq')}</option>
                <option value="!=">{t('monitors.form.opNeq')}</option>
                <option value="between">{t('monitors.form.opBetween')}</option>
                <option value="changed">{t('monitors.form.opChanged')}</option>
              </select>
            </div>
            {form.valueWatcherOperator !== 'changed' && (
              <Input
                label={form.valueWatcherOperator === 'between' ? t('monitors.form.minThreshold') : t('monitors.form.threshold')}
                type="number"
                value={form.valueWatcherThreshold ?? ''}
                onChange={(e) => updateField('valueWatcherThreshold', e.target.value ? parseFloat(e.target.value) : null)}
                placeholder="0"
                required
              />
            )}
            {form.valueWatcherOperator === 'between' && (
              <Input
                label={t('monitors.form.maxThreshold')}
                type="number"
                value={form.valueWatcherThresholdMax ?? ''}
                onChange={(e) => updateField('valueWatcherThresholdMax', e.target.value ? parseFloat(e.target.value) : null)}
                placeholder="100"
                required
              />
            )}
          </div>
        )}

        {/* Timing Settings */}
        <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            {t('monitors.form.sectionTiming')}
          </h2>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label={t('monitors.form.checkInterval')}
              type="number"
              min={1}
              max={86400}
              value={form.intervalSeconds ?? ''}
              onChange={(e) => updateField('intervalSeconds', parseInt(e.target.value, 10) || null)}
              placeholder={t('monitors.form.checkIntervalPlaceholder')}
            />
            <Input
              label={t('monitors.form.timeout')}
              type="number"
              min={1000}
              max={60000}
              value={form.timeoutMs ?? ''}
              onChange={(e) => updateField('timeoutMs', parseInt(e.target.value, 10) || null)}
              placeholder={t('monitors.form.timeoutPlaceholder')}
            />
            <Input
              label={t('monitors.form.retryInterval')}
              type="number"
              min={1}
              max={3600}
              value={form.retryIntervalSeconds ?? ''}
              onChange={(e) => updateField('retryIntervalSeconds', parseInt(e.target.value, 10) || null)}
              placeholder={t('monitors.form.retryIntervalPlaceholder')}
            />
            <Input
              label={t('monitors.form.maxRetries')}
              type="number"
              value={form.maxRetries ?? ''}
              onChange={(e) => updateField('maxRetries', parseInt(e.target.value, 10) || null)}
              placeholder={t('monitors.form.maxRetriesPlaceholder')}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="upside-down"
              checked={form.upsideDown || false}
              onChange={(e) => updateField('upsideDown', e.target.checked)}
              className="h-4 w-4 rounded border-border bg-bg-tertiary text-accent focus:ring-accent"
            />
            <label htmlFor="upside-down" className="text-sm text-text-secondary">
              {t('monitors.form.upsideDown')}
            </label>
          </div>
        </div>

        {/* Submit */}
        <div className="flex items-center gap-3">
          <Button type="submit" loading={saving}>
            <Save size={16} className="mr-1.5" />
            {isNew ? t('monitors.create') : t('monitors.saveChanges')}
          </Button>
          <Link to={isNew ? '/' : `/monitor/${id}`}>
            <Button type="button" variant="secondary">
              {t('common.cancel')}
            </Button>
          </Link>
        </div>
      </form>
    </div>
  );
}
