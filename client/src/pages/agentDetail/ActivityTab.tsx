import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { auditApi, type AuditLogRow } from '@/api/audit.api';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { AuditActionPill, AuditDetails, auditTargetLabel } from '@/pages/AuditLogPage';
import { anonIp, anonUsername } from '@/utils/anonymize';
import { SectionTitle, formatTs, type AgentTabProps } from './parts';

/** Tab id of the Activity tab (registered by AgentDetailPage; W13-2 merges it into Timeline). */
export const ACTIVITY_TAB_ID = 'activity';

/** Rows the tab shows (the latest actions on this agent). */
const LIMIT = 100;

/**
 * Activity of one agent (FLEET-AGENT-18): the audit rows linked to it, newest
 * first: approval, edits, update requests, commands, firewall rule writes,
 * local templates / bans / whitelist entries scoped to it. Needs audit.read
 * (the page only registers the tab for holders); the header links to the
 * full audit log.
 */
export function ActivityTab({ device, refreshKey }: AgentTabProps) {
  const { t } = useTranslation();
  const devId = device.id;
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await auditApi.byDevice(devId, LIMIT));
      setFailed(false);
    } catch {
      setRows([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [devId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const toggle = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="rounded-lg border border-border bg-bg-secondary flex flex-col">
      <SectionTitle
        extra={(
          <>
            <Link to={`/audit-log?device=${devId}`} className="text-accent hover:underline">
              {t('agentDetail.activity.fullLog', { defaultValue: 'Full audit log' })}
            </Link>
            <IconButton
              size="sm"
              label={t('common.refresh', { defaultValue: 'Refresh' })}
              icon={<RefreshCw size={12} className={loading ? 'animate-spin' : ''} />}
              onClick={() => void load()}
            />
          </>
        )}
      >
        {t('agentDetail.activity.title', { defaultValue: 'Activity' })}
      </SectionTitle>

      <div className="flex-1 min-h-[200px]">
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-16"><LoadingSpinner /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={failed
              ? t('agentDetail.activity.loadFailed', { defaultValue: 'Failed to load the activity' })
              : t('agentDetail.activity.empty', { defaultValue: 'No recorded action on this agent yet' })}
            compact
          />
        ) : (
          <TableScroll className="rounded-none">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="text-[10px] uppercase text-text-muted border-b border-border">
                  <th className="text-left px-4 py-2 font-medium whitespace-nowrap">{t('agentDetail.activity.colWhen', { defaultValue: 'When' })}</th>
                  <th className="text-left px-4 py-2 font-medium">{t('agentDetail.activity.colAction', { defaultValue: 'Action' })}</th>
                  <th className="text-left px-4 py-2 font-medium">{t('agentDetail.activity.colActor', { defaultValue: 'Actor' })}</th>
                  <th className="text-left px-4 py-2 font-medium">{t('agentDetail.activity.colTarget', { defaultValue: 'Target' })}</th>
                  <th className="text-left px-4 py-2 font-medium">{t('agentDetail.activity.colIp', { defaultValue: 'IP' })}</th>
                  <th className="w-6 px-2 py-2"><span className="sr-only">{t('agentDetail.activity.details', { defaultValue: 'Details' })}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => {
                  const open = expanded.has(row.id);
                  return (
                    <Fragment key={row.id}>
                      <tr className="cursor-pointer hover:bg-bg-hover transition-colors" onClick={() => toggle(row.id)} aria-expanded={open}>
                        <td className="px-4 py-2 whitespace-nowrap text-text-muted" title={row.createdAt}>{formatTs(row.createdAt)}</td>
                        <td className="px-4 py-2"><AuditActionPill action={row.action} success={row.success} /></td>
                        <td className="px-4 py-2 text-text-primary max-w-[10rem] truncate">
                          {row.username
                            ? anonUsername(row.username)
                            : <span className="italic text-text-muted">{t('agentDetail.activity.system', { defaultValue: 'system' })}</span>}
                        </td>
                        <td className="px-4 py-2 font-mono text-text-secondary max-w-[14rem] truncate" title={auditTargetLabel(row)}>{auditTargetLabel(row)}</td>
                        <td className="px-4 py-2 font-mono text-text-muted whitespace-nowrap">{row.ipAddress ? anonIp(row.ipAddress) : '—'}</td>
                        <td className="px-2 py-2 text-text-muted">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                      </tr>
                      {open && (
                        <tr className="bg-bg-primary/40">
                          <td colSpan={6} className="px-6 py-3"><AuditDetails row={row} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>
    </div>
  );
}
