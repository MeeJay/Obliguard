import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import type {
  NotificationTypeFlags, ResolvedSettingValue, SettingDefinition, SettingLevel, SettingRawValue, SettingsKey,
} from '@obliview/shared';
import { NOTIFICATION_TYPE_FIELDS } from '@obliview/shared';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { InheritanceBadge } from './InheritanceBadge';

interface SettingFieldProps {
  definition: SettingDefinition;
  level: SettingLevel;
  /** What this level inherits from the levels above. */
  inherited: ResolvedSettingValue | undefined;
  /** What applies at this level (own value included). */
  effective: ResolvedSettingValue | undefined;
  /** This level's own value (undefined = inherits). */
  override: SettingRawValue | undefined;
  readOnly?: boolean;
  /** 'external' keys (update policy): where they are managed. */
  manageHref?: string | null;
  onSave: (key: SettingsKey, value: SettingRawValue) => Promise<void>;
  onReset: (key: SettingsKey) => Promise<void>;
}

const inputCls = (editable: boolean) =>
  `rounded-md border border-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent coarse:min-h-9 ${
    editable ? 'bg-bg-tertiary text-text-primary' : 'bg-bg-tertiary text-text-muted cursor-not-allowed'
  }`;
const overrideBtn = 'shrink-0 rounded-md px-2 py-1 coarse:px-3 coarse:py-2 text-xs font-medium transition-colors disabled:opacity-50';

function OverrideChip() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
      {t('settings.source.override', { defaultValue: 'Override' })}
    </span>
  );
}

/** Human value of a resolved setting (number + unit, on / off, enum label). */
function useValueText() {
  const { t } = useTranslation();
  return (def: SettingDefinition, v: SettingRawValue | undefined): string => {
    if (v === undefined) return '';
    if (def.type === 'boolean') return v ? t('common.on', { defaultValue: 'On' }) : t('common.off', { defaultValue: 'Off' });
    if (def.type === 'enum') return t(`settings.options.${def.key}.${String(v)}`, { defaultValue: String(v) });
    if (def.type === 'number') return `${String(v)}${def.unit ? ` ${t(`settings.units.${def.unit}`, { defaultValue: def.unit })}` : ''}`;
    return '';
  };
}

/**
 * One setting of the IPS cascade (W13-1, Obliance SettingField): the value
 * that applies here, where it comes from (InheritanceBadge with a link to the
 * source level) and an Override / Reset switch below the global level.
 */
export function SettingField({
  definition: def, level, inherited, effective, override, readOnly = false, manageHref, onSave, onReset,
}: SettingFieldProps) {
  const { t } = useTranslation();
  const valueText = useValueText();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const hasOverride = override !== undefined;
  const [overriding, setOverriding] = useState(hasOverride);
  const inheritedValue = inherited?.value ?? def.defaultValue;
  const [draft, setDraft] = useState<string>(String(override ?? inheritedValue));

  // Follow the server state (another tab, a save, a reset).
  useEffect(() => { setOverriding(override !== undefined); }, [override]);
  useEffect(() => { setDraft(String(override ?? inheritedValue)); }, [override, inheritedValue]);

  const label = t(`settings.defs.${def.key}.label`, { defaultValue: def.label });
  const description = t(`settings.defs.${def.key}.description`, { defaultValue: def.description });

  const run = async (fn: () => Promise<void>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try { await fn(); } finally { savingRef.current = false; setSaving(false); }
  };
  const save = (v: SettingRawValue) => run(() => onSave(def.key, v));
  const reset = () => run(async () => { await onReset(def.key); setOverriding(false); });

  const locked = readOnly || saving;
  const editable = !locked && (level === 'global' || overriding);
  const header = (badge: ReactNode) => (
    <div className="flex-1 min-w-0 max-sm:basis-full">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        {badge}
      </div>
      <p className="text-xs text-text-muted mt-0.5">{description}</p>
    </div>
  );
  const sourceBadge = level === 'global' && !hasOverride
    ? <InheritanceBadge setting={inherited ?? { source: 'default', sourceId: null, sourceName: 'Default' }} />
    : hasOverride ? <OverrideChip /> : (inherited ? <InheritanceBadge setting={inherited} /> : null);

  // ── updatePolicy: display only, managed by the C17 controls ──
  if (def.resolution === 'external') {
    const shown = effective ?? inherited;
    return (
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 py-3">
        {header(shown ? (shown.source === level ? <OverrideChip /> : <InheritanceBadge setting={shown} />) : null)}
        <div className="flex items-center gap-2 text-sm text-text-primary">
          <span>{shown ? valueText(def, shown.value) : '—'}</span>
          {manageHref && (
            <Link to={manageHref} className="text-xs text-accent hover:underline">
              {t('settings.manage', { defaultValue: 'Manage' })}
            </Link>
          )}
        </div>
      </div>
    );
  }

  // ── evaluateOnly: on anywhere above is absolute ──
  if (def.resolution === 'anyTrue') {
    const fromAbove = inherited?.value === true;
    const on = fromAbove || override === true;
    return (
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 py-3">
        {header(fromAbove ? <InheritanceBadge setting={inherited!} /> : override === true ? <OverrideChip /> : null)}
        <ToggleSwitch
          checked={on}
          disabled={locked || fromAbove}
          onChange={(next) => { if (next) void save(true); else void reset(); }}
          ariaLabel={label}
        />
      </div>
    );
  }

  // ── notificationTypes: each type inherits on its own ──
  if (def.type === 'flags') {
    const own = (override ?? {}) as NotificationTypeFlags;
    const setField = (field: string, v: 'inherit' | 'on' | 'off') => {
      const next: NotificationTypeFlags = { ...own };
      if (v === 'inherit') delete next[field as keyof NotificationTypeFlags];
      else next[field as keyof NotificationTypeFlags] = v === 'on';
      if (Object.keys(next).length === 0) void reset();
      else void save(next);
    };
    return (
      <div className="py-3">
        {header(hasOverride ? <OverrideChip /> : null)}
        <div className="mt-2 space-y-2">
          {NOTIFICATION_TYPE_FIELDS.map((f) => {
            const inh = inherited?.fields?.[f];
            const ownV = own[f];
            const inhText = inh ? (inh.value ? t('common.on', { defaultValue: 'On' }) : t('common.off', { defaultValue: 'Off' })) : '';
            return (
              <div key={f} className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-3">
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-text-secondary">{t(`agents.notifType.${f}`, { defaultValue: f })}</span>
                  {typeof ownV !== 'boolean' && inh && <span className="ml-2"><InheritanceBadge setting={inh} /></span>}
                </div>
                <select
                  value={typeof ownV === 'boolean' ? (ownV ? 'on' : 'off') : 'inherit'}
                  onChange={(e) => setField(f, e.target.value as 'inherit' | 'on' | 'off')}
                  disabled={locked}
                  aria-label={t(`agents.notifType.${f}`, { defaultValue: f })}
                  className={inputCls(!locked)}
                >
                  <option value="inherit">{`${t('settings.inherit', { defaultValue: 'Inherit' })}${inhText ? ` (${inhText})` : ''}`}</option>
                  <option value="on">{t('common.on', { defaultValue: 'On' })}</option>
                  <option value="off">{t('common.off', { defaultValue: 'Off' })}</option>
                </select>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── enum: an "Inherit" choice below the global level ──
  if (def.type === 'enum') {
    const inheritText = `${t('settings.inherit', { defaultValue: 'Inherit' })} (${valueText(def, inheritedValue)})`;
    return (
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 py-3">
        {header(sourceBadge)}
        <select
          value={hasOverride ? String(override) : '__inherit'}
          onChange={(e) => { if (e.target.value === '__inherit') void reset(); else void save(e.target.value); }}
          disabled={locked}
          aria-label={label}
          className={`${inputCls(!locked)} max-sm:w-full`}
        >
          <option value="__inherit">{level === 'global' ? `${t('settings.source.default', { defaultValue: 'Default' })} (${valueText(def, def.defaultValue)})` : inheritText}</option>
          {(def.options ?? []).map((o) => <option key={o} value={o}>{valueText(def, o)}</option>)}
        </select>
      </div>
    );
  }

  // ── boolean (nearest wins) ──
  if (def.type === 'boolean') {
    const shown = hasOverride ? override as boolean : inheritedValue as boolean;
    return (
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 py-3">
        {header(sourceBadge)}
        <div className="flex items-center gap-2">
          <ToggleSwitch checked={!!shown} disabled={!editable} onChange={(next) => void save(next)} ariaLabel={label} />
          <OverrideToggle level={level} overriding={overriding} hasOverride={hasOverride} disabled={locked}
            onOverride={() => { setOverriding(true); void save(!!inheritedValue); }} onReset={() => void reset()} />
        </div>
      </div>
    );
  }

  // ── number ──
  const commit = () => {
    const n = Number(draft);
    // Unchanged: nothing stored (a global field is not pinned to its default by a mere blur).
    if (!Number.isInteger(n) || draft.trim() === '' || n === override || (level === 'global' && !hasOverride && n === inheritedValue)) {
      setDraft(String(override ?? inheritedValue));
      return;
    }
    void save(n);
  };
  return (
    <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 py-3">
      {header(sourceBadge)}
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={editable ? draft : String(hasOverride ? override : inheritedValue)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (editable) commit(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && editable) commit(); }}
          disabled={!editable}
          min={def.min}
          max={def.max}
          inputMode="numeric"
          enterKeyHint="done"
          aria-label={label}
          className={`w-24 text-right ${inputCls(editable)}`}
        />
        {def.unit && <span className="text-xs text-text-muted w-16">{t(`settings.units.${def.unit}`, { defaultValue: def.unit })}</span>}
        <OverrideToggle level={level} overriding={overriding} hasOverride={hasOverride} disabled={locked}
          onOverride={() => setOverriding(true)} onReset={() => void reset()} />
      </div>
    </div>
  );
}

/** Override (start an own value) / Reset (back to the inherited one). */
function OverrideToggle({ level, overriding, hasOverride, disabled, onOverride, onReset }: {
  level: SettingLevel; overriding: boolean; hasOverride: boolean; disabled: boolean;
  onOverride: () => void; onReset: () => void;
}) {
  const { t } = useTranslation();
  // Global: always editable; Reset only once a value is stored (back to the default).
  if (level === 'global' && !hasOverride) return null;
  return overriding || hasOverride ? (
    <button type="button" onClick={onReset} disabled={disabled}
      className={`${overrideBtn} text-amber-500 hover:bg-amber-500/10`}
      title={t('settings.resetHint', { defaultValue: 'Remove the value set here: inherit it again' })}>
      <span className="flex items-center gap-1"><RotateCcw size={12} />{t('common.reset', { defaultValue: 'Reset' })}</span>
    </button>
  ) : (
    <button type="button" onClick={onOverride} disabled={disabled}
      className={`${overrideBtn} text-text-muted hover:bg-bg-hover hover:text-text-primary`}
      title={t('settings.overrideHint', { defaultValue: 'Set a value at this level' })}>
      {t('common.override', { defaultValue: 'Override' })}
    </button>
  );
}
