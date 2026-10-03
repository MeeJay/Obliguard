import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, FlaskConical, Gauge, Info, ListTree, Lock, PieChart, Trash2, XCircle } from 'lucide-react';
import type {
  AgentDevice,
  CreateServiceTemplateRequest,
  GroupTreeNode,
  ServiceTemplate,
  ServiceTemplateMode,
  ServiceType,
  UpdateServiceTemplateRequest,
} from '@obliview/shared';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { anonLog, anonPath } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { AssignmentsTab, agentLabel, findGroup } from './AssignmentsTab';
import { EnabledChip, ModeChip, OriginBadge, SERVICE_TYPES, serviceIcon } from './TemplateBadges';
import {
  findRe2Issues,
  looksLikeIp,
  namedGroups,
  runSamples,
  toJsRegex,
  type Re2Issue,
  type Re2IssueCode,
} from './regexTester';

export const EDITOR_TABS = ['parser', 'thresholds', 'assignments', 'usage'] as const;
export type EditorTab = typeof EDITOR_TABS[number];

/** Smallest accepted window (seconds) — same floor as the agent panel. */
const MIN_WINDOW_SECONDS = 10;

interface TemplateEditorProps {
  /** null = creating a new template. */
  template: ServiceTemplate | null;
  tab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
  /** May change the template itself (templates.write + ownership rule). */
  canEdit: boolean;
  /** May create / change assignments (templates.write). */
  canAssign: boolean;
  groups: GroupTreeNode[];
  agents: AgentDevice[];
  ownGroups: GroupTreeNode[];
  ownAgents: AgentDevice[];
  /** Create (template null) or update; resolves when saved, throws on failure. */
  onSubmit: (data: CreateServiceTemplateRequest | UpdateServiceTemplateRequest) => Promise<void>;
  onCancelCreate: () => void;
  onToggleEnabled: (template: ServiceTemplate) => void;
  onDelete: (template: ServiceTemplate) => void;
  /** Reload the template (after an assignment change). */
  onReload: () => void;
}

interface FormState {
  name: string;
  serviceType: ServiceType;
  defaultLogPath: string;
  customRegex: string;
  threshold: string;
  windowSeconds: string;
  mode: ServiceTemplateMode;
  enabled: boolean;
}

function initialForm(template: ServiceTemplate | null): FormState {
  return {
    name: template?.name ?? '',
    serviceType: template?.serviceType ?? 'custom',
    defaultLogPath: template?.defaultLogPath ?? '',
    customRegex: template?.customRegex ?? '',
    threshold: String(template?.threshold ?? 5),
    windowSeconds: String(template?.windowSeconds ?? 300),
    mode: template?.mode ?? 'ban',
    enabled: template?.enabled ?? false,
  };
}

const fieldClass = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Template detail (detail pane): header with origin / mode / state and the
 * template actions, then SegmentedTabs Parser | Thresholds | Assignments |
 * Usage. Parser and Thresholds share one form and one save bar; a new
 * template only shows those two tabs. Mount it with `key={template?.id ?? 'new'}`
 * so the form resets when the selection changes.
 */
export function TemplateEditor({
  template, tab, onTabChange, canEdit, canAssign, groups, agents, ownGroups, ownAgents,
  onSubmit, onCancelCreate, onToggleEnabled, onDelete, onReload,
}: TemplateEditorProps) {
  const { t } = useTranslation();
  const creating = template === null;
  const builtin = template?.isBuiltin ?? false;
  const [form, setForm] = useState<FormState>(() => initialForm(template));
  const [saving, setSaving] = useState(false);
  // Errors of untouched fields show once a save was attempted.
  const [attempted, setAttempted] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const baseline = useMemo(() => initialForm(template), [template]);
  const dirty = creating || (Object.keys(form) as (keyof FormState)[])
    .some((k) => k !== 'enabled' && form[k] !== baseline[k]);

  // ── Validation ──
  const regex = form.customRegex.trim();
  const re2Issues = useMemo(() => (regex ? findRe2Issues(regex) : []), [regex]);
  const thresholdNum = Number(form.threshold);
  const windowNum = Number(form.windowSeconds);
  const errors = {
    name: form.name.trim() === '' ? t('serviceTemplates.validation.name', { defaultValue: 'A name is required' }) : undefined,
    threshold: !Number.isInteger(thresholdNum) || thresholdNum < 1
      ? t('serviceTemplates.validation.threshold', { defaultValue: 'Whole number, 1 or more' }) : undefined,
    window: !Number.isInteger(windowNum) || windowNum < MIN_WINDOW_SECONDS
      ? t('serviceTemplates.validation.window', { defaultValue: 'Whole number of seconds, 10 or more' }) : undefined,
    regex: re2Issues.length > 0
      ? t('serviceTemplates.validation.re2', { defaultValue: 'The regex uses syntax the agent (Go RE2) does not support' }) : undefined,
  };
  const parserInvalid = !!errors.name || !!errors.regex;
  const thresholdsInvalid = !!errors.threshold || !!errors.window;

  const save = async () => {
    setAttempted(true);
    if (parserInvalid) { onTabChange('parser'); return; }
    if (thresholdsInvalid) { onTabChange('thresholds'); return; }
    const common = {
      name: form.name.trim(),
      threshold: thresholdNum,
      windowSeconds: windowNum,
      mode: form.mode,
    };
    // Built-ins keep their parser (the server refuses a regex on them).
    const parser = builtin ? {} : {
      defaultLogPath: form.defaultLogPath.trim() || null,
      customRegex: regex || null,
    };
    setSaving(true);
    try {
      if (creating) {
        await onSubmit({ ...common, ...parser, serviceType: form.serviceType, enabled: form.enabled } satisfies CreateServiceTemplateRequest);
      } else {
        await onSubmit({ ...common, ...parser } satisfies UpdateServiceTemplateRequest);
        // Align the form on what was saved (trimmed text, "05" -> "5"), so the
        // save bar does not stay up on a form that is already saved.
        setForm((f) => ({
          ...f,
          name: common.name,
          threshold: String(thresholdNum),
          windowSeconds: String(windowNum),
          ...(builtin ? {} : { defaultLogPath: form.defaultLogPath.trim(), customRegex: regex }),
        }));
      }
    } catch {
      // The page reports the failure (toast); keep the form as typed.
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (creating) onCancelCreate();
    else setForm(initialForm(template));
  };

  const errorDot = <span className="h-1.5 w-1.5 rounded-full bg-status-down" aria-hidden="true" />;
  const tabs = [
    {
      id: 'parser' as const,
      label: t('serviceTemplates.tabs.parser', { defaultValue: 'Parser' }),
      icon: <FlaskConical size={14} aria-hidden="true" />,
      badge: parserInvalid && (attempted || !!errors.regex) ? errorDot : undefined,
    },
    {
      id: 'thresholds' as const,
      label: t('serviceTemplates.tabs.thresholds', { defaultValue: 'Thresholds' }),
      icon: <Gauge size={14} aria-hidden="true" />,
      badge: thresholdsInvalid ? errorDot : undefined,
    },
    {
      id: 'assignments' as const,
      label: t('serviceTemplates.tabs.assignments', { defaultValue: 'Assignments' }),
      icon: <ListTree size={14} aria-hidden="true" />,
      badge: template?.assignments?.length ? <span className="text-[10px] opacity-70">{template.assignments.length}</span> : undefined,
      hidden: creating,
    },
    {
      id: 'usage' as const,
      label: t('serviceTemplates.tabs.usage', { defaultValue: 'Usage' }),
      icon: <PieChart size={14} aria-hidden="true" />,
      hidden: creating,
    },
  ];
  const activeTab: EditorTab = creating && (tab === 'assignments' || tab === 'usage') ? 'parser' : tab;
  const readOnly = !canEdit;

  return (
    <div className="flex flex-col rounded-xl bg-bg-secondary">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true">{serviceIcon(creating ? form.serviceType : template.serviceType)}</span>
            <h2 className="min-w-0 truncate text-base font-semibold text-text-primary">
              {creating
                ? t('serviceTemplates.editor.newTitle', { defaultValue: 'New template' })
                : template.name}
            </h2>
          </div>
          {!creating && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <OriginBadge template={template} />
              <ModeChip mode={template.mode ?? 'ban'} />
              <EnabledChip enabled={template.enabled} />
            </div>
          )}
        </div>
        {!creating && (
          <div className="flex items-center gap-2">
            <ToggleSwitch
              checked={template.enabled}
              onChange={() => onToggleEnabled(template)}
              disabled={!canEdit}
              label={t('serviceTemplates.editor.enabledByDefault', { defaultValue: 'On by default' })}
              title={!canEdit ? t('serviceTemplates.editor.readOnlyHint', { defaultValue: 'You cannot change this template' }) : undefined}
            />
            {canEdit && !builtin && (
              <ActionMenu
                label={t('serviceTemplates.editor.actions', { defaultValue: 'Template actions' })}
                items={[{
                  key: 'delete',
                  icon: <Trash2 className="h-4 w-4" />,
                  label: t('serviceTemplates.actions.delete', { defaultValue: 'Delete template' }),
                  onClick: () => onDelete(template),
                  danger: true,
                }]}
              />
            )}
          </div>
        )}
      </div>

      {readOnly && !creating && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
          <Lock size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {template.tenantId == null
              ? t('serviceTemplates.editor.readOnlyPlatform', { defaultValue: 'Shared platform template: only a platform admin or the Default tenant can change it.' })
              : t('serviceTemplates.editor.readOnly', { defaultValue: 'Read-only: you cannot change this template.' })}
          </span>
        </div>
      )}

      <div className="px-4">
        <SegmentedTabs
          tabs={tabs}
          value={activeTab}
          onChange={onTabChange}
          size="sm"
          ariaLabel={t('serviceTemplates.tabs.label', { defaultValue: 'Template sections' })}
        />
      </div>

      <div className="p-4" role="tabpanel">
        {activeTab === 'parser' && (
          <ParserTab
            form={form}
            set={set}
            creating={creating}
            builtin={builtin}
            readOnly={readOnly}
            nameError={attempted || form.name !== baseline.name ? errors.name : undefined}
            re2Issues={re2Issues}
          />
        )}
        {activeTab === 'thresholds' && (
          <ThresholdsTab form={form} set={set} creating={creating} readOnly={readOnly} errors={errors} />
        )}
        {activeTab === 'assignments' && template && (
          <AssignmentsTab
            template={template}
            canAssign={canAssign}
            groups={groups}
            agents={agents}
            ownGroups={ownGroups}
            ownAgents={ownAgents}
            onChanged={onReload}
          />
        )}
        {activeTab === 'usage' && template && (
          <UsageTab template={template} groups={groups} agents={agents} />
        )}
      </div>

      {canEdit && dirty && (activeTab === 'parser' || activeTab === 'thresholds') && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-border bg-bg-secondary px-4 py-3 pb-safe">
          {!creating && (
            <span className="mr-auto text-xs text-text-muted">
              {t('serviceTemplates.editor.unsaved', { defaultValue: 'Unsaved changes' })}
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={reset} disabled={saving}>
            {creating
              ? t('common.cancel', { defaultValue: 'Cancel' })
              : t('serviceTemplates.editor.discard', { defaultValue: 'Discard' })}
          </Button>
          <Button size="sm" onClick={() => void save()} loading={saving}>
            {creating
              ? t('serviceTemplates.editor.create', { defaultValue: 'Create template' })
              : t('common.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Parser tab ───────────────────────────────────────────────────────────────

const RE2_ISSUE_TEXT: Record<Re2IssueCode, string> = {
  lookahead: 'Lookahead {{text}} is not supported by Go RE2',
  lookbehind: 'Lookbehind {{text}} is not supported by Go RE2',
  backreference: 'Backreference {{text}} is not supported by Go RE2',
  namedBackreference: 'Named backreference {{text}} is not supported by Go RE2',
  atomicGroup: 'Atomic group {{text}} is not supported by Go RE2',
  conditional: 'Conditional {{text}} is not supported by Go RE2',
  recursion: 'Recursion {{text}} is not supported by Go RE2',
  repeatCount: 'Repeat count {{text}} is above the RE2 limit (1000)',
  unbalanced: 'Unbalanced parenthesis {{text}}',
  escape: 'Escape {{text}} is not supported by Go RE2',
  group: 'Group syntax {{text}} is not supported by Go RE2',
};

function ParserTab({ form, set, creating, builtin, readOnly, nameError, re2Issues }: {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  creating: boolean;
  builtin: boolean;
  readOnly: boolean;
  nameError?: string;
  re2Issues: Re2Issue[];
}) {
  const { t } = useTranslation();
  const regex = form.customRegex.trim();
  const groupsInRegex = useMemo(() => namedGroups(regex), [regex]);

  return (
    <div className="space-y-4">
      <Input
        id="st-name"
        label={t('serviceTemplates.fields.name', { defaultValue: 'Name' })}
        value={form.name}
        onChange={(e) => set('name', e.target.value)}
        placeholder={t('serviceTemplates.fields.namePlaceholder', { defaultValue: 'e.g. Custom app login' })}
        disabled={readOnly || builtin}
        error={nameError}
        autoFocus={creating}
      />

      <div className="space-y-1">
        <label htmlFor="st-service-type" className="block text-sm font-medium text-text-secondary">
          {t('serviceTemplates.fields.serviceType', { defaultValue: 'Service type' })}
        </label>
        <select
          id="st-service-type"
          value={form.serviceType}
          onChange={(e) => set('serviceType', e.target.value as ServiceType)}
          disabled={!creating || readOnly}
          className={fieldClass}
        >
          {SERVICE_TYPES.map((s) => (
            <option key={s.value} value={s.value}>{t(`serviceTemplates.serviceType.${s.value}`, { defaultValue: s.label })}</option>
          ))}
          {!SERVICE_TYPES.some((s) => s.value === form.serviceType) && (
            <option value={form.serviceType}>{form.serviceType}</option>
          )}
        </select>
        {!creating && (
          <p className="text-xs text-text-muted">
            {t('serviceTemplates.fields.serviceTypeFixed', { defaultValue: 'The service type cannot be changed after creation.' })}
          </p>
        )}
      </div>

      {builtin ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
            <Info size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {t('serviceTemplates.parser.builtinNote', { defaultValue: 'Built-in parser compiled into the agent: no regex to edit. Change its thresholds, mode or state, or assign it to groups and agents.' })}
            </span>
          </div>
          {form.defaultLogPath && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                {t('serviceTemplates.fields.defaultLogPath', { defaultValue: 'Default log path' })}
              </p>
              <code className="break-all font-mono text-xs text-text-secondary">{anonPath(form.defaultLogPath)}</code>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-1">
            <Input
              id="st-log-path"
              label={t('serviceTemplates.fields.defaultLogPathOptional', { defaultValue: 'Default log path (optional)' })}
              value={form.defaultLogPath}
              onChange={(e) => set('defaultLogPath', e.target.value)}
              placeholder="/var/log/app/auth.log"
              disabled={readOnly}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-xs text-text-muted">
              {t('serviceTemplates.fields.defaultLogPathHint', { defaultValue: 'Empty = the agent\'s default log for the service type.' })}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="st-regex" className="block text-sm font-medium text-text-secondary">
              {t('serviceTemplates.fields.customRegex', { defaultValue: 'Regex' })}
            </label>
            <textarea
              id="st-regex"
              value={form.customRegex}
              onChange={(e) => set('customRegex', e.target.value)}
              placeholder={'Failed login for (?P<username>\\S+) from (?P<ip>[0-9a-fA-F:.]+)'}
              rows={3}
              disabled={readOnly}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-invalid={re2Issues.length > 0}
              aria-describedby="st-regex-help"
              className={cn(fieldClass, 'resize-y font-mono', re2Issues.length > 0 && 'border-status-down focus:ring-status-down')}
            />
            <p id="st-regex-help" className="text-xs text-text-muted">
              {t('serviceTemplates.parser.groupsHelp', { defaultValue: 'Named groups read by the agent: (?P<ip>…) (required) and (?P<username>…) (optional). Every match counts as one failed login.' })}
            </p>
            {re2Issues.length > 0 && (
              <ul className="space-y-0.5" aria-live="polite">
                {re2Issues.map((issue, idx) => (
                  <li key={`${issue.code}-${issue.index}-${idx}`} className="flex items-start gap-1.5 text-xs text-status-down">
                    <XCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>
                      {t(`serviceTemplates.parser.re2.${issue.code}`, { defaultValue: RE2_ISSUE_TEXT[issue.code], text: issue.text })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {regex && re2Issues.length === 0 && !groupsInRegex.includes('ip') && (
              <p className="flex items-start gap-1.5 text-xs text-amber-400">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                {t('serviceTemplates.parser.noIpGroup', { defaultValue: 'No (?P<ip>…) group: the agent ignores matches without an IP address.' })}
              </p>
            )}
            {!regex && form.serviceType === 'custom' && (
              <p className="flex items-start gap-1.5 text-xs text-amber-400">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                {t('serviceTemplates.parser.customNeedsRegex', { defaultValue: 'A custom service has no built-in parser: without a regex it detects nothing.' })}
              </p>
            )}
          </div>

          <RegexTester regex={regex} blocked={re2Issues.length > 0} />
        </>
      )}
    </div>
  );
}

/** In-browser preview of the regex on pasted log lines. */
function RegexTester({ regex, blocked }: { regex: string; blocked: boolean }) {
  const { t } = useTranslation();
  const [samples, setSamples] = useState('');
  const compiled = useMemo(() => (regex && !blocked ? toJsRegex(regex) : null), [regex, blocked]);
  const results = useMemo(
    () => (compiled?.ok && samples.trim() ? runSamples(compiled.regex, samples) : []),
    [compiled, samples],
  );
  const matched = results.filter((r) => r.matched).length;

  let status: ReactNode = null;
  if (!regex) {
    status = t('serviceTemplates.tester.noRegex', { defaultValue: 'Type a regex above to test it.' });
  } else if (blocked) {
    status = t('serviceTemplates.tester.blocked', { defaultValue: 'Fix the unsupported syntax first.' });
  } else if (compiled && !compiled.ok) {
    status = compiled.reason === 'untranslatable'
      ? t('serviceTemplates.tester.untranslatable', { defaultValue: '{{text}} is valid for the agent but cannot be previewed in the browser.', text: compiled.message })
      : t('serviceTemplates.tester.invalid', { defaultValue: 'Invalid regex: {{message}}', message: compiled.message });
  } else if (samples.trim()) {
    status = t('serviceTemplates.tester.summary', { defaultValue: '{{matched}} of {{total}} lines match', matched, total: results.length });
  }

  return (
    <div className="space-y-2 rounded-lg bg-bg-tertiary/50 p-3">
      <div className="flex items-center gap-2">
        <FlaskConical size={14} className="text-text-muted" aria-hidden="true" />
        <span className="text-sm font-medium text-text-secondary">
          {t('serviceTemplates.tester.title', { defaultValue: 'Test the regex' })}
        </span>
      </div>
      <textarea
        value={samples}
        onChange={(e) => setSamples(e.target.value)}
        rows={4}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={t('serviceTemplates.tester.samplesLabel', { defaultValue: 'Sample log lines' })}
        placeholder={t('serviceTemplates.tester.samplesPlaceholder', { defaultValue: 'Paste log lines here, one per line' })}
        className={cn(fieldClass, 'resize-y font-mono text-xs')}
      />
      <p className="text-[11px] text-text-muted">
        {t('serviceTemplates.tester.re2Note', { defaultValue: 'Runs in your browser. The agent uses Go RE2: lookarounds and backreferences are refused, and a few rare constructs may behave differently. Nothing is sent to the server.' })}
      </p>
      {status && (
        <p className={cn('text-xs', compiled && !compiled.ok ? 'text-amber-400' : 'text-text-secondary')} aria-live="polite">{status}</p>
      )}
      {results.length > 0 && (
        <ul className="max-h-72 space-y-1 overflow-y-auto overscroll-contain">
          {results.map((r, idx) => {
            const badIp = r.matched && (!r.ip || !looksLikeIp(r.ip));
            return (
              <li key={idx} className="rounded-md bg-bg-secondary px-2 py-1.5 text-xs">
                <div className="flex items-start gap-1.5">
                  {r.matched
                    ? <CheckCircle2 size={12} className={cn('mt-0.5 shrink-0', badIp ? 'text-amber-400' : 'text-status-up')} aria-hidden="true" />
                    : <XCircle size={12} className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true" />}
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] text-text-secondary">
                    {r.span ? (
                      <>
                        {anonLog(r.line.slice(0, r.span[0]))}
                        <mark className="rounded-sm bg-accent/25 text-text-primary">{anonLog(r.line.slice(r.span[0], r.span[1]))}</mark>
                        {anonLog(r.line.slice(r.span[1]))}
                      </>
                    ) : anonLog(r.line)}
                  </code>
                </div>
                {r.matched && (
                  <div className="ml-[18px] mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                    <span className={badIp ? 'text-amber-400' : 'text-text-muted'}>
                      {t('serviceTemplates.tester.ipLabel', { defaultValue: 'ip:' })}{' '}
                      <span className="font-mono">{r.ip ? anonLog(r.ip) : t('serviceTemplates.tester.none', { defaultValue: '(none)' })}</span>
                      {badIp && ` — ${t('serviceTemplates.tester.ignored', { defaultValue: 'ignored by the agent' })}`}
                    </span>
                    <span className="text-text-muted">
                      {t('serviceTemplates.tester.usernameLabel', { defaultValue: 'username:' })}{' '}
                      <span className="font-mono">{r.username ? anonLog(r.username) : t('serviceTemplates.tester.none', { defaultValue: '(none)' })}</span>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Thresholds tab ───────────────────────────────────────────────────────────

function ThresholdsTab({ form, set, creating, readOnly, errors }: {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  creating: boolean;
  readOnly: boolean;
  errors: { threshold?: string; window?: string };
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-text-secondary">
          {t('serviceTemplates.fields.mode', { defaultValue: 'Mode' })}
        </span>
        <SegmentedTabs
          tabs={[
            { id: 'ban' as const, label: t('serviceTemplates.mode.ban', { defaultValue: 'Ban' }), disabled: readOnly },
            { id: 'track' as const, label: t('serviceTemplates.mode.track', { defaultValue: 'Track only' }), disabled: readOnly },
          ]}
          value={form.mode}
          onChange={(mode) => set('mode', mode)}
          size="sm"
          ariaLabel={t('serviceTemplates.fields.mode', { defaultValue: 'Mode' })}
          className="max-w-sm"
        />
        <p className="text-xs text-text-muted">
          {form.mode === 'ban'
            ? t('serviceTemplates.mode.banHelp', { defaultValue: 'Events count toward the thresholds and trigger automatic bans.' })
            : t('serviceTemplates.mode.trackHelp', { defaultValue: 'Events are stored for visibility and reputation, but never trigger automatic bans.' })}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          id="st-threshold"
          label={t('serviceTemplates.fields.threshold', { defaultValue: 'Failure threshold' })}
          type="number"
          inputMode="numeric"
          min={1}
          value={form.threshold}
          onChange={(e) => set('threshold', e.target.value)}
          disabled={readOnly}
          error={errors.threshold}
        />
        <Input
          id="st-window"
          label={t('serviceTemplates.fields.window', { defaultValue: 'Window (seconds)' })}
          type="number"
          inputMode="numeric"
          min={MIN_WINDOW_SECONDS}
          value={form.windowSeconds}
          onChange={(e) => set('windowSeconds', e.target.value)}
          disabled={readOnly}
          error={errors.window}
        />
      </div>
      <p className="text-xs text-text-muted">
        {t('serviceTemplates.fields.thresholdHelp', {
          defaultValue: 'An IP is banned after {{threshold}} failures within {{window}} seconds (groups and agents can override both).',
          threshold: form.threshold || '?',
          window: form.windowSeconds || '?',
        })}
      </p>

      {creating && (
        <ToggleSwitch
          checked={form.enabled}
          onChange={(v) => set('enabled', v)}
          disabled={readOnly}
          label={t('serviceTemplates.editor.enabledByDefault', { defaultValue: 'On by default' })}
          description={t('serviceTemplates.fields.enabledHelp', { defaultValue: 'Off = active only on the groups and agents it is assigned to.' })}
        />
      )}
    </div>
  );
}

// ── Usage tab ────────────────────────────────────────────────────────────────

function UsageTab({ template, groups, agents }: {
  template: ServiceTemplate;
  groups: GroupTreeNode[];
  agents: AgentDevice[];
}) {
  const { t } = useTranslation();
  const assignments = template.assignments ?? [];
  const label = (scope: 'group' | 'agent', id: number) => {
    if (scope === 'agent') {
      const a = agents.find((x) => x.id === id);
      return a ? agentLabel(a) : t('serviceTemplates.assignments.agentFallback', { defaultValue: 'Agent #{{id}}', id });
    }
    return findGroup(groups, id)?.name ?? t('serviceTemplates.assignments.groupFallback', { defaultValue: 'Group #{{id}}', id });
  };

  const turnedOn = assignments.filter((a) => a.enabledOverride === true);
  const turnedOff = assignments.filter((a) => a.enabledOverride === false);
  const thresholdOverrides = assignments.filter((a) => a.thresholdOverride != null || a.windowSecondsOverride != null);
  const exceptions = template.enabled ? turnedOff : turnedOn;
  const owner = template.ownerScope && template.ownerScopeId != null ? label(template.ownerScope, template.ownerScopeId) : null;

  const stats: Array<{ key: string; label: string; value: ReactNode }> = [
    { key: 'groups', label: t('serviceTemplates.usage.groups', { defaultValue: 'Groups assigned' }), value: assignments.filter((a) => a.scope === 'group').length },
    { key: 'agents', label: t('serviceTemplates.usage.agents', { defaultValue: 'Agents assigned' }), value: assignments.filter((a) => a.scope === 'agent').length },
    { key: 'on', label: t('serviceTemplates.usage.turnedOn', { defaultValue: 'Turned on' }), value: turnedOn.length },
    { key: 'off', label: t('serviceTemplates.usage.turnedOff', { defaultValue: 'Turned off' }), value: turnedOff.length },
    { key: 'thr', label: t('serviceTemplates.usage.thresholdOverrides', { defaultValue: 'Threshold overrides' }), value: thresholdOverrides.length },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-bg-tertiary/60 px-3 py-2 text-sm text-text-secondary">
        {template.enabled
          ? (exceptions.length === 0
            ? t('serviceTemplates.usage.activeEverywhere', { defaultValue: 'Active on every agent.' })
            : t('serviceTemplates.usage.activeExcept', { defaultValue: 'Active on every agent except under {{count}} target(s):', count: exceptions.length }))
          : (exceptions.length === 0
            ? t('serviceTemplates.usage.activeNowhere', { defaultValue: 'Not active anywhere: it is off by default and no assignment turns it on.' })
            : t('serviceTemplates.usage.activeOnly', { defaultValue: 'Active only under {{count}} target(s):', count: exceptions.length }))}
        {exceptions.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {exceptions.map((a) => (
              <li key={a.id} className="rounded-full bg-bg-secondary px-2 py-0.5 text-xs text-text-primary">
                {label(a.scope, a.scopeId)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((s) => (
          <div key={s.key} className="rounded-lg bg-bg-tertiary/60 px-3 py-2">
            <dt className="text-[10px] font-medium uppercase tracking-wide text-text-muted">{s.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-text-primary">{s.value}</dd>
          </div>
        ))}
      </dl>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        <UsageRow label={t('serviceTemplates.usage.origin', { defaultValue: 'Origin' })}>
          <OriginBadge template={template} />
        </UsageRow>
        {owner && (
          <UsageRow label={t('serviceTemplates.usage.owner', { defaultValue: 'Owned by' })}>{owner}</UsageRow>
        )}
        <UsageRow label={t('serviceTemplates.usage.parser', { defaultValue: 'Parser' })}>
          {template.isBuiltin
            ? t('serviceTemplates.usage.builtinParser', { defaultValue: 'Built-in ({{type}})', type: template.serviceType })
            : template.customRegex
              ? t('serviceTemplates.usage.customRegex', { defaultValue: 'Custom regex' })
              : t('serviceTemplates.usage.serviceParser', { defaultValue: 'Service parser ({{type}})', type: template.serviceType })}
        </UsageRow>
        <UsageRow label={t('serviceTemplates.usage.created', { defaultValue: 'Created' })}>
          {new Date(template.createdAt).toLocaleString()}
        </UsageRow>
        <UsageRow label={t('serviceTemplates.usage.updated', { defaultValue: 'Updated' })}>
          {new Date(template.updatedAt).toLocaleString()}
        </UsageRow>
      </dl>
    </div>
  );
}

function UsageRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-1.5">
      <dt className="text-text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-text-primary">{children}</dd>
    </div>
  );
}
