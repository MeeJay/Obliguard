import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Check,
  Clock,
  Copy,
  Eraser,
  Eye,
  Globe,
  Loader2,
  Server,
  Shield,
  ShieldCheck,
  ShieldOff,
  Tag,
  Trash2,
  User,
} from 'lucide-react';
import type { IpEvent, IpWhitelist } from '@obliview/shared';
import { Drawer } from '@/components/common/Drawer';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { EmptyState } from '@/components/common/EmptyState';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { IpStatusBadge, resolveIpStatus } from '@/components/status/IpStatusBadge';
import { ScopeBadge } from '@/components/status/ScopeBadge';
import { EventTypeBadge } from '@/components/status/EventTypeBadge';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useIpsPermissions } from '@/hooks/useIpsPermissions';
import { useIsPlatformAdmin } from '@/hooks/usePermission';
import { notifyIpChanged, useIpChanged, useIpDrawer } from '@/hooks/useIpDrawer';
import {
  apiErrorMessage,
  ipReputationApi,
  targetHost,
  type IpBanHistoryItem,
  type IpDetail,
} from '@/api/ipReputation.api';
import { ipLabelsApi } from '@/api/ipLabels.api';
import { anonHostname, anonIp, anonLog, anonUsername } from '@/utils/anonymize';
import { cn } from '@/utils/cn';

// ── Shared helpers (also used by the IP Reputation hub tabs) ────────────────

/** Locale date + time, or an em dash. */
export function formatWhen(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Regional-indicator flag of a 2-letter country code ('' when unknown). */
export function countryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '';
  return Array.from(code.toUpperCase())
    .map((c) => String.fromCodePoint(c.codePointAt(0)! + 127397))
    .join('');
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Light syntactic check of a single address (IPv4 dotted quad or IPv6). */
export function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) return true;
  return value.includes(':') && /^[0-9a-fA-F:.]{2,45}$/.test(value);
}

/** Exact (non-range) target of `ip`: "1.2.3.4", "1.2.3.4/32" or the /128 form. */
function isExactTarget(target: string, ip: string): boolean {
  if (targetHost(target) !== ip) return false;
  const slash = target.indexOf('/');
  if (slash < 0) return true;
  const bits = target.slice(slash + 1);
  return bits === '32' || bits === '128';
}

// ── Actions (drawer + hub rows) ──────────────────────────────────────────────

export interface IpActionTarget {
  ip: string;
  /** Active ban the action applies to (lift / re-enable / promote). */
  banId?: number | null;
}

/**
 * IP actions with their confirmation, server call, result toast and change
 * notification (notifyIpChanged → lists refetch). Each resolves true when
 * the change was made. Capability gating stays with the caller
 * (useIpsPermissions): these only follow the owner model —
 *  - ban / whitelist scope follows the operating tenant (never sent);
 *  - one Lift: global from Default, a local exclusion anywhere else;
 *  - promote to global from Default only (server-enforced too).
 */
export function useIpActions() {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const askText = usePrompt();
  const perms = useIpsPermissions();
  const isPlatformAdmin = useIsPlatformAdmin();
  const clearsGlobally = isPlatformAdmin && perms.isGodView;

  const ban = useCallback(async ({ ip }: IpActionTarget): Promise<boolean> => {
    const reason = await askText({
      title: t('bans.banIpTitle', { defaultValue: 'Ban IP' }),
      message: perms.isGodView
        ? t('bans.quickBanPromptGlobal', { defaultValue: 'Ban reason for {{ip}} (global ban: every tenant):', ip })
        : t('bans.quickBanPromptLocal', { defaultValue: 'Ban reason for {{ip}} (this tenant only):', ip }),
      placeholder: t('ipReputation.banReasonPlaceholder', { defaultValue: 'Why is this IP being banned?' }),
      confirmLabel: t('ipReputation.actions.ban', { defaultValue: 'Ban' }),
      required: true,
    });
    if (reason === null) return false;
    try {
      const created = await ipReputationApi.ban(ip, reason.trim());
      toast.success(created?.scope === 'global'
        ? t('bans.bannedGlobal', { defaultValue: '{{ip}} banned globally', ip })
        : t('bans.bannedLocal', { defaultValue: '{{ip}} banned on this tenant', ip }));
      notifyIpChanged(ip);
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.ban', { defaultValue: 'Failed to ban the IP' })));
      return false;
    }
  }, [t, askText, perms.isGodView]);

  const lift = useCallback(async ({ ip, banId }: IpActionTarget): Promise<boolean> => {
    if (banId == null) {
      toast.error(t('ipReputation.errors.noActiveBan', { defaultValue: 'No active ban was found for this IP' }));
      return false;
    }
    const ok = await askConfirm({
      title: t('ipReputation.lift.title', { defaultValue: 'Lift ban' }),
      message: perms.canLiftGlobally
        ? t('ipReputation.lift.confirmGlobal', { defaultValue: 'Lift the ban on {{ip}} for every tenant? Agents of every tenant stop blocking it.', ip })
        : t('ipReputation.lift.confirmLocal', { defaultValue: 'Lift the ban on {{ip}} on this tenant? Your agents stop blocking it; other tenants keep their own decision.', ip }),
      confirmLabel: t('ipReputation.actions.lift', { defaultValue: 'Lift' }),
      danger: true,
    });
    if (!ok) return false;
    try {
      await ipReputationApi.lift(banId);
      toast.success(perms.canLiftGlobally
        ? t('ipReputation.lift.doneGlobal', { defaultValue: 'Ban on {{ip}} lifted for every tenant', ip })
        : t('ipReputation.lift.doneLocal', { defaultValue: 'Ban on {{ip}} lifted on this tenant', ip }));
      notifyIpChanged(ip);
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.lift', { defaultValue: 'Failed to lift the ban' })));
      return false;
    }
  }, [t, askConfirm, perms.canLiftGlobally]);

  const reEnable = useCallback(async ({ ip, banId }: IpActionTarget): Promise<boolean> => {
    if (banId == null) return false;
    const ok = await askConfirm({
      title: t('ipReputation.reEnable.title', { defaultValue: 'Re-enable ban' }),
      message: t('ipReputation.reEnable.confirm', { defaultValue: 'Enforce the ban on {{ip}} on this tenant again?', ip }),
      confirmLabel: t('ipReputation.actions.reEnable', { defaultValue: 'Re-enable' }),
    });
    if (!ok) return false;
    try {
      await ipReputationApi.removeExclusion(banId);
      toast.success(t('ipReputation.reEnable.done', { defaultValue: 'Ban on {{ip}} enforced on this tenant again', ip }));
      notifyIpChanged(ip);
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.reEnable', { defaultValue: 'Failed to re-enable the ban' })));
      return false;
    }
  }, [t, askConfirm]);

  const promote = useCallback(async ({ ip, banId }: IpActionTarget): Promise<boolean> => {
    if (banId == null) return false;
    const ok = await askConfirm({
      title: t('bans.promoteButton', { defaultValue: 'Promote to global' }),
      message: t('bans.promoteConfirm', {
        defaultValue: 'Promote the ban on {{ip}} to a global ban? It will be enforced on every agent of every tenant, and its reason becomes visible to every tenant.',
        ip,
      }),
      confirmLabel: t('bans.promoteButton', { defaultValue: 'Promote to global' }),
      danger: true,
    });
    if (!ok) return false;
    try {
      await ipReputationApi.promote(banId);
      toast.success(t('bans.promoted', { defaultValue: '{{ip}} is now banned globally', ip }));
      notifyIpChanged(ip);
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.promote', { defaultValue: 'Failed to promote the ban' })));
      return false;
    }
  }, [t, askConfirm]);

  const whitelist = useCallback(async ({ ip }: IpActionTarget): Promise<boolean> => {
    const label = await askText({
      title: t('ipReputation.whitelist.title', { defaultValue: 'Whitelist {{ip}}', ip }),
      message: perms.canWhitelistGlobally
        ? t('bans.whitelistGlobalHint', { defaultValue: 'Global whitelist entry: applies to every tenant and cannot be removed by other tenants.' })
        : t('bans.whitelistTenantHint', { defaultValue: 'Local whitelist entry: applies only to this tenant.' }),
      placeholder: t('ipReputation.whitelist.labelPlaceholder', { defaultValue: 'Label (optional), e.g. Office VPN' }),
      confirmLabel: t('ipReputation.actions.whitelist', { defaultValue: 'Whitelist' }),
    });
    if (label === null) return false;
    try {
      await ipReputationApi.whitelist(ip, label.trim() || null);
      toast.success(t('ipReputation.whitelist.done', { defaultValue: '{{ip}} whitelisted', ip }));
      notifyIpChanged(ip);
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.whitelist', { defaultValue: 'Failed to whitelist the IP' })));
      return false;
    }
  }, [t, askText, perms.canWhitelistGlobally]);

  /** Remove one whitelist entry (the drawer lists them) or the exact entry of `ip`. */
  const unwhitelist = useCallback(async ({ ip }: IpActionTarget, entry?: IpWhitelist): Promise<boolean> => {
    let target = entry;
    try {
      if (!target) {
        const entries = await ipReputationApi.whitelistEntries(ip);
        target = entries.find((e) => isExactTarget(e.ip, ip) && e.canDelete !== false);
        if (!target) {
          toast.error(entries.length > 0
            ? t('ipReputation.unwhitelist.locked', { defaultValue: '{{ip}} is covered by an entry this tenant cannot remove (a range or a global entry)', ip })
            : t('ipReputation.unwhitelist.notFound', { defaultValue: 'No whitelist entry was found for {{ip}}', ip }));
          return false;
        }
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.loadWhitelist', { defaultValue: 'Failed to load the whitelist entries' })));
      return false;
    }
    const ok = await askConfirm({
      title: t('ipReputation.unwhitelist.title', { defaultValue: 'Remove from whitelist' }),
      message: t('ipReputation.unwhitelist.confirm', { defaultValue: 'Remove the whitelist entry {{entry}}? The IP can be banned again.', entry: target.ip }),
      confirmLabel: t('ipReputation.actions.remove', { defaultValue: 'Remove' }),
      danger: true,
    });
    if (!ok) return false;
    try {
      await ipReputationApi.removeWhitelist(target.id);
      toast.success(t('ipReputation.unwhitelist.done', { defaultValue: '{{entry}} removed from the whitelist', entry: target.ip }));
      notifyIpChanged(ip);
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.unwhitelist', { defaultValue: 'Failed to remove the whitelist entry' })));
      return false;
    }
  }, [t, askConfirm]);

  const clear = useCallback(async ({ ip }: IpActionTarget): Promise<boolean> => {
    const ok = await askConfirm({
      title: t('ipReputation.clear.title', { defaultValue: 'Clear suspicious status' }),
      message: clearsGlobally
        ? t('ipReputation.clear.confirmGlobal', { defaultValue: 'Reset the failure counter of {{ip}} to 0 for every tenant?', ip })
        : t('ipReputation.clear.confirmLocal', { defaultValue: 'Mark {{ip}} as reviewed on this tenant? It becomes suspicious again if new failures arrive.', ip }),
      confirmLabel: t('ipReputation.actions.clear', { defaultValue: 'Clear' }),
    });
    if (!ok) return false;
    try {
      await ipReputationApi.clear(ip);
      toast.success(clearsGlobally
        ? t('ipReputation.clear.doneGlobal', { defaultValue: '{{ip}} reputation reset for every tenant', ip })
        : t('ipReputation.clear.doneLocal', { defaultValue: '{{ip}} marked as reviewed', ip }));
      notifyIpChanged(ip);
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.clear', { defaultValue: 'Failed to clear the suspicious status' })));
      return false;
    }
  }, [t, askConfirm, clearsGlobally]);

  /** Set (non-empty) or remove (empty) the display label of `ip`. */
  const editLabel = useCallback(async ({ ip }: IpActionTarget, current?: string | null): Promise<boolean> => {
    const value = await askText({
      title: current
        ? t('ipReputation.label.editTitle', { defaultValue: 'Edit label of {{ip}}', ip })
        : t('ipReputation.label.addTitle', { defaultValue: 'Label {{ip}}', ip }),
      message: t('ipReputation.label.hint', { defaultValue: 'Shown next to the IP everywhere (NetMap, lists). Leave empty to remove it.' }),
      defaultValue: current ?? '',
      placeholder: t('ipReputation.label.placeholder', { defaultValue: 'e.g. Home router, Office ISP…' }),
      confirmLabel: t('common.save', { defaultValue: 'Save' }),
    });
    if (value === null) return false;
    const label = value.trim();
    if (!label && !current) return false;
    try {
      if (label) await ipLabelsApi.upsert(ip, label);
      else await ipLabelsApi.remove(ip);
      toast.success(label
        ? t('ipReputation.label.saved', { defaultValue: 'Label saved for {{ip}}', ip })
        : t('ipReputation.label.removed', { defaultValue: 'Label removed for {{ip}}', ip }));
      notifyIpChanged(ip);
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.label', { defaultValue: 'Failed to save the label' })));
      return false;
    }
  }, [t, askText]);

  return { ban, lift, reEnable, promote, whitelist, unwhitelist, clear, editLabel, clearsGlobally };
}

// ── Drawer ───────────────────────────────────────────────────────────────────

/**
 * The single IP detail drawer of the app, driven by ?ip= (useIpDrawer) and
 * mounted once in AppLayout. Any page opens it with `useIpDrawer().open(ip)`.
 */
export function IpDetailDrawer() {
  const { ip, close } = useIpDrawer();
  if (!ip) return null;
  // Keyed: switching IPs starts from a clean state.
  return <IpDetailPanel key={ip} ip={ip} onClose={close} />;
}

interface LoadedData {
  detail: IpDetail | null;
  events: IpEvent[];
  bans: IpBanHistoryItem[];
  whitelist: IpWhitelist[];
  label: string | null;
}

const EVENTS_STEP = 25;

function IpDetailPanel({ ip, onClose }: { ip: string; onClose: () => void }) {
  const { t } = useTranslation();
  const perms = useIpsPermissions();
  const actions = useIpActions();
  const valid = isIpAddress(ip);

  const [data, setData] = useState<LoadedData | null>(null);
  const [loading, setLoading] = useState(valid);
  const [failed, setFailed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [eventsShown, setEventsShown] = useState(EVENTS_STEP);
  const [allUsernames, setAllUsernames] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!valid) return;
    setLoading(true);
    const [detail, events, bans, wl, labels] = await Promise.allSettled([
      ipReputationApi.getDetail(ip),
      ipReputationApi.eventsByIp(ip),
      ipReputationApi.banHistory(ip),
      ipReputationApi.whitelistEntries(ip),
      ipLabelsApi.list(),
    ]);
    const missing: string[] = [];
    if (detail.status === 'rejected') missing.push('detail');
    if (events.status === 'rejected') missing.push('events');
    if (bans.status === 'rejected') missing.push('bans');
    if (wl.status === 'rejected') missing.push('whitelist');
    const detailValue = detail.status === 'fulfilled' ? detail.value : null;
    setData({
      detail: detailValue,
      events: events.status === 'fulfilled' ? events.value : detailValue?.recentEvents ?? [],
      bans: bans.status === 'fulfilled' ? bans.value : [],
      whitelist: wl.status === 'fulfilled' ? wl.value : [],
      label: labels.status === 'fulfilled' ? labels.value.find((l) => l.ip === ip)?.label ?? null : null,
    });
    setFailed(missing);
    setLoading(false);
  }, [ip, valid]);

  useEffect(() => { void load(); }, [load]);
  // Another view (or this drawer) changed this IP: refresh.
  useIpChanged((changed) => { if (changed === null || changed === ip) void load(); });

  const rep = data?.detail?.reputation ?? null;
  const activeBan = useMemo(
    () => data?.bans.find((b) => (b.state ? b.state === 'active' : b.isActive && (!b.expiresAt || new Date(b.expiresAt) > new Date()))) ?? null,
    [data],
  );
  const activeBanId = rep?.activeBanId ?? activeBan?.id ?? null;
  const activeScope = rep?.activeBanScope ?? activeBan?.scope ?? null;
  const excluded = rep?.activeBanExcluded ?? activeBan?.isExcludedByTenant ?? false;
  const status = rep?.status
    ?? (activeBan ? 'banned' : (data?.whitelist.length ?? 0) > 0 ? 'whitelisted' : 'clean');
  const statusKey = resolveIpStatus({ status, activeBanExcluded: excluded });
  const banned = status === 'banned';
  const whitelisted = status === 'whitelisted';
  const label = data?.label ?? null;
  const target = { ip, banId: activeBanId };

  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ip);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('ipReputation.errors.copy', { defaultValue: 'Could not copy to the clipboard' }));
    }
  };

  // Primary action (one button) + the rest in the menu, each capability-gated.
  const canBanNow = perms.canBan && !banned && !whitelisted;
  const canLiftNow = perms.canLift && banned && !excluded && activeBanId != null;
  const canReEnableNow = perms.canLift && banned && excluded && activeBanId != null;
  const canPromoteNow = perms.canPromote && banned && activeBanId != null && activeScope != null && activeScope !== 'global';
  const canWhitelistNow = perms.canWhitelist && !whitelisted;
  const canClearNow = perms.canClear && status === 'suspicious';

  let primary: ReactNode = null;
  if (valid && data) {
    if (canLiftNow) {
      primary = (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => actions.lift(target))}>
          <Shield size={13} className="mr-1.5" />
          {perms.canLiftGlobally
            ? t('ipReputation.actions.liftGlobal', { defaultValue: 'Lift for every tenant' })
            : t('ipReputation.actions.liftLocal', { defaultValue: 'Lift on this tenant' })}
        </Button>
      );
    } else if (canReEnableNow) {
      primary = (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => actions.reEnable(target))}>
          <Eye size={13} className="mr-1.5" />{t('ipReputation.actions.reEnable', { defaultValue: 'Re-enable' })}
        </Button>
      );
    } else if (canBanNow) {
      primary = (
        <Button size="sm" variant="danger" loading={busy} onClick={() => run(() => actions.ban(target))}>
          <ShieldOff size={13} className="mr-1.5" />{t('ipReputation.actions.ban', { defaultValue: 'Ban' })}
        </Button>
      );
    }
  }

  // Ban is never in the menu: when it is allowed it is the primary action.
  const menu: ActionMenuItem[] = [
    { key: 'whitelist', icon: <ShieldCheck size={14} />, label: t('ipReputation.actions.whitelist', { defaultValue: 'Whitelist' }), onClick: () => run(() => actions.whitelist(target)), hidden: !canWhitelistNow },
    { key: 'promote', icon: <Globe size={14} />, label: t('bans.promoteButton', { defaultValue: 'Promote to global' }), onClick: () => run(() => actions.promote(target)), hidden: !canPromoteNow },
    { key: 'clear', icon: <Eraser size={14} />, label: t('ipReputation.actions.clear', { defaultValue: 'Clear' }), description: actions.clearsGlobally ? t('ipReputation.clear.globalHint', { defaultValue: 'Every tenant' }) : t('ipReputation.clear.localHint', { defaultValue: 'This tenant' }), onClick: () => run(() => actions.clear(target)), hidden: !canClearNow },
    { key: 'label', icon: <Tag size={14} />, label: label ? t('ipReputation.actions.editLabel', { defaultValue: 'Edit label' }) : t('ipReputation.actions.addLabel', { defaultValue: 'Add label' }), onClick: () => run(() => actions.editLabel(target, label)), hidden: !perms.canLabel, separator: true },
  ];
  const menuHasItems = menu.some((m) => !m.hidden);

  const footer = valid && data && (primary || menuHasItems) ? (
    <>
      {primary}
      {menuHasItems && (
        <ActionMenu
          items={menu}
          placement="top"
          disabled={busy}
          label={t('ipReputation.moreActions', { defaultValue: 'More actions' })}
        />
      )}
    </>
  ) : undefined;

  const services = rep?.affectedServices ?? [];
  const usernames = rep?.attemptedUsernames ?? [];
  const events = data?.events ?? [];
  const flag = countryFlag(rep?.geoCountryCode);
  const location = [rep?.geoCity, rep?.geoCountryCode].filter(Boolean).join(', ');

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      icon={<Globe size={16} className="text-text-muted" aria-hidden="true" />}
      title={<span className="font-mono">{anonIp(ip)}</span>}
      headerExtra={(
        <div className="flex items-center gap-1.5">
          {valid && data && <IpStatusBadge status={statusKey} />}
          <IconButton
            label={copied ? t('common.copied', { defaultValue: 'Copied!' }) : t('ipReputation.copyIp', { defaultValue: 'Copy IP' })}
            icon={copied ? <Check className="h-4 w-4 text-status-up" /> : <Copy className="h-4 w-4" />}
            size="sm"
            variant="plain"
            onClick={() => void copy()}
          />
        </div>
      )}
      footer={footer}
      bodyClassName="space-y-5 px-4 py-4"
    >
      {!valid ? (
        <EmptyState
          variant="filtered"
          title={t('ipReputation.drawer.invalidTitle', { defaultValue: 'Not a valid IP address' })}
          description={t('ipReputation.drawer.invalidBody', { defaultValue: 'The link points to "{{value}}", which is not a single IPv4 or IPv6 address.', value: ip })}
        />
      ) : loading && !data ? (
        <div className="flex items-center justify-center py-16" role="status" aria-label={t('common.loading', { defaultValue: 'Loading…' })}>
          <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
        </div>
      ) : data ? (
        <>
          {failed.length > 0 && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
              <span>{t('ipReputation.drawer.partial', { defaultValue: 'Some details could not be loaded.' })}</span>
              <button type="button" onClick={() => void load()} className="font-medium underline-offset-2 hover:underline">
                {t('common.refresh', { defaultValue: 'Refresh' })}
              </button>
            </div>
          )}

          {!rep && events.length === 0 && data.bans.length === 0 && data.whitelist.length === 0 && (
            <p className="rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
              {t('ipReputation.drawer.unknownIp', { defaultValue: 'No agent has reported this IP yet. You can still ban, whitelist or label it.' })}
            </p>
          )}

          {/* Summary */}
          <Section title={t('ipReputation.drawer.summary', { defaultValue: 'Summary' })}>
            {label && (
              <p className="mb-3 flex items-center gap-1.5 text-sm font-medium text-accent">
                <Tag size={12} className="shrink-0" aria-hidden="true" />{label}
              </p>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Fact label={t('ipReputation.columns.location', { defaultValue: 'Location' })}>
                {location ? <>{flag && <span className="mr-1">{flag}</span>}{location}</> : '—'}
              </Fact>
              <Fact label={t('ipReputation.columns.asn', { defaultValue: 'ASN' })}>
                <span className="font-mono">{rep?.asn || '—'}</span>
              </Fact>
              <Fact label={t('ipReputation.columns.firstSeen', { defaultValue: 'First seen' })}>{formatWhen(rep?.firstSeen)}</Fact>
              <Fact label={t('ipReputation.columns.lastSeen', { defaultValue: 'Last seen' })}>{formatWhen(rep?.lastSeen)}</Fact>
              <Fact label={t('ipReputation.columns.failures', { defaultValue: 'Failures' })}>
                <span className="tabular-nums">{(rep?.totalFailures ?? 0).toLocaleString()}</span>
              </Fact>
              <Fact label={t('ipReputation.columns.successes', { defaultValue: 'Successes' })}>
                <span className="tabular-nums">{(rep?.totalSuccesses ?? 0).toLocaleString()}</span>
              </Fact>
              <Fact label={t('ipReputation.columns.agents', { defaultValue: 'Agents' })}>
                <span className="inline-flex items-center gap-1.5">
                  <Server size={12} className="text-text-muted" aria-hidden="true" />
                  {t('ipReputation.drawer.agentsCount', { defaultValue: '{{count}} agent(s) reported it', count: rep?.affectedAgentsCount ?? 0 })}
                </span>
              </Fact>
              {rep?.clearedForTenant && (
                <Fact label={t('ipReputation.drawer.review', { defaultValue: 'Review' })}>
                  <span className="inline-flex items-center gap-1 text-blue-400"><Eraser size={12} aria-hidden="true" />{t('ipReputation.cleared', { defaultValue: 'Cleared' })}</span>
                </Fact>
              )}
            </dl>

            {services.length > 0 && (
              <div className="mt-4">
                <p className="mb-1.5 text-xs text-text-muted">{t('ipReputation.columns.services', { defaultValue: 'Services' })}</p>
                <div className="flex flex-wrap gap-1.5">
                  {services.map((svc) => (
                    <span key={svc} className="rounded-md bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{svc}</span>
                  ))}
                </div>
              </div>
            )}

            {usernames.length > 0 && (
              <div className="mt-4">
                <p className="mb-1.5 text-xs text-text-muted">{t('ipReputation.drawer.usernames', { defaultValue: 'Usernames attempted' })}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {(allUsernames ? usernames : usernames.slice(0, 12)).map((u) => (
                    <li key={u} className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-0.5 font-mono text-xs text-text-secondary">
                      <User size={10} className="text-text-muted" aria-hidden="true" />{anonUsername(u)}
                    </li>
                  ))}
                </ul>
                {usernames.length > 12 && (
                  <button type="button" onClick={() => setAllUsernames((v) => !v)} className="mt-1.5 text-xs text-accent hover:underline">
                    {allUsernames
                      ? t('ipReputation.drawer.showLess', { defaultValue: 'Show less' })
                      : t('ipReputation.drawer.showAllCount', { defaultValue: 'Show all ({{count}})', count: usernames.length })}
                  </button>
                )}
              </div>
            )}
          </Section>

          {/* Active ban */}
          {banned && (
            <Section title={t('ipReputation.drawer.activeBan', { defaultValue: 'Active ban' })}>
              <div className="space-y-2 rounded-lg bg-bg-tertiary p-3 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  {activeScope && <ScopeBadge scope={activeScope} scopeName={activeBan?.scopeName} />}
                  {activeBan && <BanTypePill type={activeBan.banType} />}
                  {activeBan && <TenantBadge tenantId={activeBan.tenantId} tenantName={activeBan.tenantName} />}
                  {excluded && <IpStatusBadge status="excluded" />}
                </div>
                {activeBan?.reason && <p className="text-text-secondary">{activeBan.reason}</p>}
                {activeBan && (
                  <p className="text-xs text-text-muted">
                    {t('ipReputation.drawer.bannedAt', { defaultValue: 'Banned {{when}}', when: formatWhen(activeBan.bannedAt) })}
                    {activeBan.createdByUsername && <> · {t('ipReputation.drawer.by', { defaultValue: 'by {{name}}', name: activeBan.createdByUsername })}</>}
                    {' · '}
                    {activeBan.expiresAt
                      ? t('ipReputation.drawer.expires', { defaultValue: 'expires {{when}}', when: formatWhen(activeBan.expiresAt) })
                      : t('ipReputation.drawer.permanent', { defaultValue: 'permanent' })}
                  </p>
                )}
                {excluded && (
                  <p className="text-xs text-text-muted">
                    {t('ipReputation.drawer.excludedHint', { defaultValue: 'Lifted on this tenant: your agents no longer enforce this global ban. Other tenants keep it.' })}
                  </p>
                )}
              </div>
            </Section>
          )}

          {/* Whitelist entries */}
          {data.whitelist.length > 0 && (
            <Section title={t('ipReputation.drawer.whitelistEntries', { defaultValue: 'Whitelist entries' })}>
              <ul className="divide-y divide-border/50 rounded-lg bg-bg-tertiary">
                {data.whitelist.map((w) => (
                  <li key={w.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-text-primary">{anonIp(w.ip)}</span>
                        <ScopeBadge scope={w.scope} />
                        <TenantBadge tenantId={w.tenantId} />
                      </div>
                      <p className="mt-0.5 text-xs text-text-muted">
                        {w.label ? <>{w.label} · </> : null}
                        {formatWhen(w.createdAt)}
                        {w.createdByUsername && <> · {t('ipReputation.drawer.by', { defaultValue: 'by {{name}}', name: w.createdByUsername })}</>}
                      </p>
                    </div>
                    {perms.canWhitelist && w.canDelete !== false && (
                      <IconButton
                        label={t('ipReputation.unwhitelist.title', { defaultValue: 'Remove from whitelist' })}
                        icon={<Trash2 className="h-4 w-4" />}
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => run(() => actions.unwhitelist(target, w))}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Events timeline */}
          <Section
            title={t('ipReputation.drawer.events', { defaultValue: 'Events' })}
            extra={events.length > 0 ? <span className="tabular-nums">{events.length}</span> : undefined}
          >
            {events.length === 0 ? (
              <EmptyState compact title={t('ipReputation.drawer.noEvents', { defaultValue: 'No events recorded for this IP' })} />
            ) : (
              <>
                <ol className="space-y-1.5">
                  {events.slice(0, eventsShown).map((ev) => (
                    <li key={ev.id} className="rounded-lg bg-bg-tertiary px-3 py-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span className="inline-flex items-center gap-1 text-text-muted">
                          <Clock size={10} aria-hidden="true" />{formatWhen(ev.timestamp)}
                        </span>
                        <EventTypeBadge type={ev.eventType} short />
                        {ev.service && <span className="text-text-secondary">{ev.service}</span>}
                        {ev.username && <span className="font-mono text-text-secondary">{anonUsername(ev.username)}</span>}
                        {ev.deviceHostname && (
                          <span className="ml-auto inline-flex items-center gap-1 text-text-muted">
                            <Server size={10} aria-hidden="true" />{anonHostname(ev.deviceHostname)}
                          </span>
                        )}
                      </div>
                      {ev.rawLog && (
                        <p className="mt-1 truncate font-mono text-[11px] text-text-muted" title={anonLog(ev.rawLog)}>
                          {anonLog(ev.rawLog)}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
                {events.length > eventsShown && (
                  <button
                    type="button"
                    onClick={() => setEventsShown((n) => n + EVENTS_STEP)}
                    className="mt-2 w-full rounded-lg py-1.5 text-xs text-accent hover:bg-bg-hover"
                  >
                    {t('ipReputation.drawer.moreEvents', { defaultValue: 'Show {{count}} more', count: Math.min(EVENTS_STEP, events.length - eventsShown) })}
                  </button>
                )}
              </>
            )}
          </Section>

          {/* Ban history */}
          <Section title={t('ipReputation.drawer.banHistory', { defaultValue: 'Ban history' })}>
            {data.bans.length === 0 ? (
              <EmptyState compact title={t('ipReputation.drawer.noBans', { defaultValue: 'This IP has never been banned' })} />
            ) : (
              <ul className="divide-y divide-border/50 rounded-lg bg-bg-tertiary">
                {data.bans.map((b) => (
                  <li key={b.id} className="px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <BanStatePill ban={b} />
                      <ScopeBadge scope={b.scope} scopeName={b.scopeName} />
                      <BanTypePill type={b.banType} />
                      <TenantBadge tenantId={b.tenantId} tenantName={b.tenantName} />
                      {b.cidrPrefix != null && !isExactTarget(`${targetHost(b.ip)}/${b.cidrPrefix}`, ip) && (
                        <span className="font-mono text-xs text-text-muted">{targetHost(b.ip)}/{b.cidrPrefix}</span>
                      )}
                    </div>
                    {b.reason && <p className="mt-1 text-xs text-text-secondary">{b.reason}</p>}
                    <p className="mt-0.5 text-xs text-text-muted">
                      {formatWhen(b.bannedAt)}
                      {b.createdByUsername && <> · {t('ipReputation.drawer.by', { defaultValue: 'by {{name}}', name: b.createdByUsername })}</>}
                      {b.liftedAt && <> · {t('ipReputation.drawer.liftedAt', { defaultValue: 'lifted {{when}}', when: formatWhen(b.liftedAt) })}</>}
                      {!b.liftedAt && b.expiresAt && <> · {t('ipReputation.drawer.expires', { defaultValue: 'expires {{when}}', when: formatWhen(b.expiresAt) })}</>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : null}
    </Drawer>
  );
}

// ── Small presentational pieces ──────────────────────────────────────────────

function Section({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-text-muted">
        <span>{title}</span>
        {extra && <span className="normal-case tracking-normal">{extra}</span>}
      </h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-text-primary">{children}</dd>
    </div>
  );
}

export function BanTypePill({ type }: { type: string }) {
  const { t } = useTranslation();
  const label = type === 'auto'
    ? t('ipReputation.banType.auto', { defaultValue: 'Auto-ban' })
    : type === 'remote'
      ? t('ipReputation.banType.remote', { defaultValue: 'Remote' })
      : type === 'external'
        ? t('ipReputation.banType.external', { defaultValue: 'External' })
        : t('ipReputation.banType.manual', { defaultValue: 'Manual' });
  return (
    <span className={cn(
      'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium',
      type === 'auto' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
        : type === 'remote' ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400'
          : type === 'external' ? 'border-purple-500/30 bg-purple-500/10 text-purple-400'
            : 'border-blue-500/30 bg-blue-500/10 text-blue-400',
    )}>
      {label}
    </span>
  );
}

function BanStatePill({ ban }: { ban: IpBanHistoryItem }) {
  const { t } = useTranslation();
  const state = ban.state
    ?? (ban.isActive
      ? (ban.expiresAt && new Date(ban.expiresAt) <= new Date() ? 'expired' : 'active')
      : (ban.expiresAt && new Date(ban.expiresAt) <= new Date() ? 'expired' : 'lifted'));
  const cfg = {
    active: { label: t('ipReputation.banState.active', { defaultValue: 'Active' }), color: 'border-red-400/30 bg-red-400/10 text-red-400' },
    expired: { label: t('ipReputation.banState.expired', { defaultValue: 'Expired' }), color: 'border-text-muted/20 bg-text-muted/10 text-text-muted' },
    lifted: { label: t('ipReputation.banState.lifted', { defaultValue: 'Lifted' }), color: 'border-status-up/30 bg-status-up/10 text-status-up' },
  }[state];
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', cfg.color)}>
      {cfg.label}
      {ban.isExcludedByTenant && state === 'active' && <> · {t('status.ip.excluded', { defaultValue: 'Excluded' })}</>}
    </span>
  );
}
