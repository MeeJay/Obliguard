import type { Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { sanitizeImportedAgentGroupConfig } from '../utils/agentUpdate';
import { invalidateAgentUpdatePolicyCache } from '../services/agent.service';

type ExportSection =
  | 'monitorGroups'
  | 'monitors'
  | 'settings'
  | 'notificationChannels'
  | 'agentGroups'
  | 'teams'
  | 'remediationActions'
  | 'remediationBindings';

/**
 * What to do when an imported item's UUID already exists in the database.
 *  - update      : overwrite the existing record with the imported data (default)
 *  - generateNew : create a brand-new copy with a fresh UUID
 *  - ignore      : skip the item entirely
 */
type ConflictStrategy = 'update' | 'generateNew' | 'ignore';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * agent_group_config as stored on import (C17): known keys only, and never an
 * imported updatePolicy 'auto' (an import must not silently turn auto-update on).
 */
function importedAgentGroupConfigJson(cfg: unknown): string | null {
  const clean = sanitizeImportedAgentGroupConfig(cfg);
  return clean ? JSON.stringify(clean) : null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ensureUniqueSlugTrx(trx: Knex.Transaction, slug: string, tenantId: number): Promise<string> {
  let candidate = slug;
  let i = 1;
  for (;;) {
    const exists = await trx('monitor_groups').where({ slug: candidate, tenant_id: tenantId }).first();
    if (!exists) return candidate;
    candidate = `${slug}-${i++}`;
  }
}

/** Topological sort — parents before children. Cycles are silently ignored. */
function topoSort<T extends Record<string, unknown>>(
  items: T[],
  uuidKey: string,
  parentKey: string,
): T[] {
  const byUuid = new Map<string, T>(
    items.filter(i => i[uuidKey]).map(i => [i[uuidKey] as string, i]),
  );
  const sorted: T[] = [];
  const visited = new Set<string | undefined>();

  function visit(item: T) {
    const uuid = item[uuidKey] as string | undefined;
    if (visited.has(uuid)) return;
    visited.add(uuid);
    const parentUuid = item[parentKey] as string | null | undefined;
    if (parentUuid) {
      const parent = byUuid.get(parentUuid);
      if (parent) visit(parent);
    }
    sorted.push(item);
  }

  for (const item of items) visit(item);
  return sorted;
}

/** Insert closure-table entries for a newly created group */
async function insertGroupClosure(
  trx: Knex.Transaction,
  groupId: number,
  parentId: number | null,
): Promise<void> {
  await trx('group_closure').insert({ ancestor_id: groupId, descendant_id: groupId, depth: 0 });
  if (parentId !== null) {
    await trx.raw(
      `INSERT INTO group_closure (ancestor_id, descendant_id, depth)
       SELECT gc.ancestor_id, ?, gc.depth + 1
       FROM   group_closure gc
       WHERE  gc.descendant_id = ?`,
      [groupId, parentId],
    );
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

export const importExportController = {

  // ── EXPORT ──────────────────────────────────────────────────────────────────

  async exportData(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawSections = (req.query.sections as string | undefined) ?? '';
      const requested   = rawSections ? rawSections.split(',').map(s => s.trim()) : [];
      const all         = requested.length === 0 || requested.includes('all');
      const want        = (s: ExportSection) => all || requested.includes(s);

      const tenantId = req.session.currentTenantId ?? 1;

      const payload: Record<string, unknown> = {
        version:    1,
        exportedAt: new Date().toISOString(),
        _note: [
          'UUIDs are optional — omit them to always create new records on import.',
          'When a UUID is present and matches an existing record, the conflict strategy',
          'chosen at import time determines whether to update, ignore, or duplicate it.',
          'UUIDs are automatically assigned to all records on first export.',
        ].join(' '),
        sections: all
          ? (['monitorGroups', 'monitors', 'settings', 'notificationChannels', 'agentGroups', 'teams', 'remediationActions', 'remediationBindings'] as ExportSection[])
          : (requested as ExportSection[]),
      };

      // ── Lazily-built UUID maps (shared across sections) ─────────────────────
      let _groupUuidMap:   Map<number, string> | null = null;
      let _monitorUuidMap: Map<number, string> | null = null;

      async function getGroupUuidMap(): Promise<Map<number, string>> {
        if (!_groupUuidMap) {
          const rows = await db('monitor_groups').where({ tenant_id: tenantId }).select('id', 'uuid');
          _groupUuidMap = new Map(rows.map((r: { id: number; uuid: string }) => [r.id, r.uuid]));
        }
        return _groupUuidMap;
      }

      async function getMonitorUuidMap(): Promise<Map<number, string>> {
        if (!_monitorUuidMap) {
          const rows = await db('monitors').where({ tenant_id: tenantId }).select('id', 'uuid');
          _monitorUuidMap = new Map(rows.map((r: { id: number; uuid: string }) => [r.id, r.uuid]));
        }
        return _monitorUuidMap;
      }

      // ── Monitor Groups (kind='monitor') ─────────────────────────────────────
      if (want('monitorGroups')) {
        const groups  = await db('monitor_groups').where({ kind: 'monitor', tenant_id: tenantId }).orderBy('sort_order').orderBy('name');
        const selfMap = new Map<number, string>(groups.map((g: any) => [g.id as number, g.uuid as string]));

        payload.monitorGroups = groups.map((g: any) => ({
          uuid:               g.uuid,
          name:               g.name,
          description:        g.description,
          parentUuid:         g.parent_id != null ? (selfMap.get(g.parent_id) ?? null) : null,
          sortOrder:          g.sort_order,
          isGeneral:          g.is_general,
          groupNotifications: g.group_notifications,
        }));
      }

      // ── Monitors (exclude agent-type monitors) ───────────────────────────────
      if (want('monitors')) {
        const monitors = await db('monitors').where({ tenant_id: tenantId }).whereNot({ type: 'agent' }).orderBy('id');
        const guMap    = await getGroupUuidMap();

        payload.monitors = monitors.map((m: any) => ({
          uuid:                       m.uuid,
          name:                       m.name,
          description:                m.description,
          type:                       m.type,
          groupUuid:                  m.group_id != null ? (guMap.get(m.group_id) ?? null) : null,
          isActive:                   m.is_active,
          intervalSeconds:            m.interval_seconds,
          retryIntervalSeconds:       m.retry_interval_seconds,
          maxRetries:                 m.max_retries,
          timeoutMs:                  m.timeout_ms,
          upsideDown:                 m.upside_down,
          url:                        m.url,
          method:                     m.method,
          headers:                    m.headers,
          body:                       m.body,
          expectedStatusCodes:        m.expected_status_codes,
          keyword:                    m.keyword,
          keywordIsPresent:           m.keyword_is_present,
          ignoreSsl:                  m.ignore_ssl,
          jsonPath:                   m.json_path,
          jsonExpectedValue:          m.json_expected_value,
          hostname:                   m.hostname,
          port:                       m.port,
          dnsRecordType:              m.dns_record_type,
          dnsResolver:                m.dns_resolver,
          dnsExpectedValue:           m.dns_expected_value,
          sslWarnDays:                m.ssl_warn_days,
          smtpHost:                   m.smtp_host,
          smtpPort:                   m.smtp_port,
          dockerHost:                 m.docker_host,
          dockerContainerName:        m.docker_container_name,
          gameType:                   m.game_type,
          gameHost:                   m.game_host,
          gamePort:                   m.game_port,
          pushToken:                  m.push_token,
          pushMaxIntervalSec:         m.push_max_interval_sec,
          scriptCommand:              m.script_command,
          scriptExpectedExit:         m.script_expected_exit,
          browserUrl:                 m.browser_url,
          browserKeyword:             m.browser_keyword,
          browserKeywordIsPresent:    m.browser_keyword_is_present,
          browserWaitForSelector:     m.browser_wait_for_selector,
          browserScreenshotOnFailure: m.browser_screenshot_on_failure,
          valueWatcherUrl:            m.value_watcher_url,
          valueWatcherJsonPath:       m.value_watcher_json_path,
          valueWatcherOperator:       m.value_watcher_operator,
          valueWatcherThreshold:      m.value_watcher_threshold,
          valueWatcherThresholdMax:   m.value_watcher_threshold_max,
          valueWatcherHeaders:        m.value_watcher_headers,
        }));
      }

      // ── Settings (all scopes) ────────────────────────────────────────────────
      if (want('settings')) {
        const settings = await db('settings').where({ tenant_id: tenantId }).orderBy('scope').orderBy('scope_id').orderBy('key');
        const guMap    = await getGroupUuidMap();
        const muMap    = await getMonitorUuidMap();

        payload.settings = settings
          .map((s: any) => ({
            scope:     s.scope,
            scopeUuid:
              s.scope === 'global'  ? null :
              s.scope === 'group'   ? (guMap.get(s.scope_id) ?? null) :
              s.scope === 'monitor' ? (muMap.get(s.scope_id) ?? null) :
              null,
            key:   s.key,
            value: s.value,
          }))
          .filter((s: any) => s.scope === 'global' || s.scopeUuid !== null);
      }

      // ── Notification Channels + Bindings ─────────────────────────────────────
      if (want('notificationChannels')) {
        const channels = await db('notification_channels').where({ tenant_id: tenantId }).orderBy('id');
        const bindings = await db('notification_bindings').orderBy('channel_id');
        const guMap    = await getGroupUuidMap();
        const muMap    = await getMonitorUuidMap();

        payload.notificationChannels = channels.map((c: any) => ({
          uuid:      c.uuid,
          name:      c.name,
          type:      c.type,
          config:    c.config,
          isEnabled: c.is_enabled,
          bindings:  bindings
            .filter((b: any) => b.channel_id === c.id)
            .map((b: any) => ({
              scope:        b.scope,
              scopeUuid:
                b.scope === 'global'  ? null :
                b.scope === 'group'   ? (guMap.get(b.scope_id) ?? null) :
                b.scope === 'monitor' ? (muMap.get(b.scope_id) ?? null) :
                null,
              overrideMode: b.override_mode,
            }))
            .filter((b: any) => b.scope === 'global' || b.scopeUuid !== null),
        }));
      }

      // ── Agent Groups (kind='agent') ──────────────────────────────────────────
      if (want('agentGroups')) {
        const groups  = await db('monitor_groups').where({ kind: 'agent', tenant_id: tenantId }).orderBy('sort_order').orderBy('name');
        const selfMap = new Map<number, string>(groups.map((g: any) => [g.id as number, g.uuid as string]));

        payload.agentGroups = groups.map((g: any) => ({
          uuid:             g.uuid,
          name:             g.name,
          description:      g.description,
          parentUuid:       g.parent_id != null ? (selfMap.get(g.parent_id) ?? null) : null,
          sortOrder:        g.sort_order,
          agentThresholds:  g.agent_thresholds,
          agentGroupConfig: g.agent_group_config,
        }));
      }

      // ── Remediation Actions ──────────────────────────────────────────────────
      if (want('remediationActions')) {
        const includeSSHCredentials = req.query.includeSSHCredentials === 'true';
        const actions = await db('remediation_actions').where({ tenant_id: tenantId }).orderBy('id');

        payload.remediationActions = actions.map((a: any) => {
          let config = a.config;
          // config is stored as JSONB — Knex returns it already parsed
          const parsedConfig: Record<string, unknown> =
            typeof config === 'string' ? (JSON.parse(config) as Record<string, unknown>) : (config as Record<string, unknown>) ?? {};

          // Redact SSH credentials unless explicitly requested
          if (a.type === 'ssh' && !includeSSHCredentials) {
            const redacted = { ...parsedConfig };
            if ('credentialEnc' in redacted) redacted.credentialEnc = '[redacted]';
            if ('password' in redacted) redacted.password = '[redacted]';
            if ('privateKey' in redacted) redacted.privateKey = '[redacted]';
            config = redacted;
          } else {
            config = parsedConfig;
          }

          return {
            uuid:    a.uuid,
            name:    a.name,
            type:    a.type,
            config,
            enabled: a.enabled,
          };
        });
      }

      // ── Remediation Bindings ─────────────────────────────────────────────────
      if (want('remediationBindings')) {
        const bindings  = await db('remediation_bindings').orderBy('id');
        const actions   = await db('remediation_actions').where({ tenant_id: tenantId }).select('id', 'uuid');
        const guMap     = await getGroupUuidMap();
        const muMap     = await getMonitorUuidMap();
        const actionUuidById = new Map<number, string>(
          actions.map((a: { id: number; uuid: string }) => [a.id, a.uuid]),
        );

        payload.remediationBindings = bindings
          .map((b: any) => {
            const actionUuid = actionUuidById.get(b.action_id);
            if (!actionUuid) return null;

            const scopeUuid =
              b.scope === 'global'  ? null :
              b.scope === 'group'   ? (guMap.get(b.scope_id) ?? null) :
              b.scope === 'monitor' ? (muMap.get(b.scope_id) ?? null) :
              null;

            if (b.scope !== 'global' && scopeUuid === null) return null;

            return {
              actionUuid,
              scope:           b.scope,
              scopeUuid,
              overrideMode:    b.override_mode,
              triggerOn:       b.trigger_on,
              cooldownSeconds: b.cooldown_seconds,
            };
          })
          .filter(Boolean);
      }

      // ── Teams + Permissions (no memberships — users are never exported) ───────
      if (want('teams')) {
        const teams       = await db('user_teams').where({ tenant_id: tenantId }).orderBy('id');
        const permissions = await db('team_permissions').orderBy('team_id');
        const guMap       = await getGroupUuidMap();
        const muMap       = await getMonitorUuidMap();

        payload.teams = teams.map((t: any) => ({
          uuid:        t.uuid,
          name:        t.name,
          description: t.description,
          canCreate:   t.can_create,
          permissions: permissions
            .filter((p: any) => p.team_id === t.id)
            .map((p: any) => ({
              scope:     p.scope,
              scopeUuid: p.scope === 'group'
                ? (guMap.get(p.scope_id) ?? null)
                : (muMap.get(p.scope_id) ?? null),
              level: p.level,
            }))
            .filter((p: any) => p.scopeUuid !== null),
        }));
      }

      const filename = `obliview-export-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json');
      res.json(payload);
    } catch (err) {
      next(err);
    }
  },

  // ── IMPORT ──────────────────────────────────────────────────────────────────

  async importData(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        sections,
        data,
        conflictStrategy = 'update',
      } = req.body as {
        sections:         ExportSection[];
        data:             Record<string, unknown>;
        conflictStrategy: ConflictStrategy;
      };

      if (!Array.isArray(sections) || sections.length === 0)
        throw new AppError(400, 'sections array is required');
      if (!data || typeof data !== 'object')
        throw new AppError(400, 'data object is required');
      if (!['update', 'generateNew', 'ignore'].includes(conflictStrategy))
        throw new AppError(400, 'conflictStrategy must be "update", "generateNew", or "ignore"');

      const want = (s: ExportSection) => sections.includes(s);
      const tenantId = req.session.currentTenantId ?? 1;

      type SectionResult = { created: number; updated: number; skipped: number };
      const results: Record<string, SectionResult> = {};

      await db.transaction(async (trx) => {

        // ── Pre-populate UUID → DB id maps (scoped to current tenant) ─────────
        const groupIdByUuid:   Map<string, number> = new Map();
        const monitorIdByUuid: Map<string, number> = new Map();
        const channelIdByUuid: Map<string, number> = new Map();
        const teamIdByUuid:    Map<string, number> = new Map();

        for (const r of await trx('monitor_groups').where({ tenant_id: tenantId }).select('id', 'uuid'))
          groupIdByUuid.set(r.uuid, r.id);
        for (const r of await trx('monitors').where({ tenant_id: tenantId }).select('id', 'uuid'))
          monitorIdByUuid.set(r.uuid, r.id);
        for (const r of await trx('notification_channels').where({ tenant_id: tenantId }).select('id', 'uuid'))
          channelIdByUuid.set(r.uuid, r.id);
        for (const r of await trx('user_teams').where({ tenant_id: tenantId }).select('id', 'uuid'))
          teamIdByUuid.set(r.uuid, r.id);

        /**
         * Batch resolution maps: track original-UUID → new DB id for items
         * imported in this run.  Used to resolve parent references for
         * children imported in the same batch (even when generateNew created
         * a fresh UUID for the parent).
         */
        const batchGroupByOrigUuid: Map<string, number> = new Map();

        /** Resolve a group UUID → DB id: batch-result first, then existing DB */
        function resolveGroup(uuid: string | null | undefined): number | null {
          if (!uuid) return null;
          return batchGroupByOrigUuid.get(uuid) ?? groupIdByUuid.get(uuid) ?? null;
        }

        /** Resolve a monitor UUID → DB id (for settings / bindings) */
        function resolveMonitor(uuid: string | null | undefined): number | null {
          if (!uuid) return null;
          return monitorIdByUuid.get(uuid) ?? null;
        }

        // ── Cross-tenant UUID collision pre-check ─────────────────────────────
        // UUIDs have a global UNIQUE constraint across all tenants.  If an
        // imported UUID belongs to a *different* tenant, we must never try to
        // INSERT with that UUID (→ unique-constraint violation = 500) nor
        // UPDATE it (→ wrong tenant mutation).  We auto-treat these as
        // 'generateNew' regardless of the user-chosen conflictStrategy.

        // Collect all UUIDs present in the import payload (groups covers both
        // monitor groups AND agent groups since they share the same table).
        const _importedGroupUuids   = [
          ...((data.monitorGroups        as any[]) ?? []).map((g: any) => g.uuid),
          ...((data.agentGroups          as any[]) ?? []).map((g: any) => g.uuid),
        ].filter(Boolean) as string[];
        const _importedMonitorUuids = ((data.monitors              as any[]) ?? []).map((m: any) => m.uuid).filter(Boolean) as string[];
        const _importedChannelUuids = ((data.notificationChannels  as any[]) ?? []).map((c: any) => c.uuid).filter(Boolean) as string[];
        const _importedTeamUuids    = ((data.teams                 as any[]) ?? []).map((t: any) => t.uuid).filter(Boolean) as string[];
        const _importedActionUuids  = ((data.remediationActions    as any[]) ?? []).map((a: any) => a.uuid).filter(Boolean) as string[];

        // For each table, find which of those UUIDs are already owned by another tenant.
        const foreignGroupUuids   = new Set<string>(_importedGroupUuids.length   ? (await trx('monitor_groups')       .whereIn('uuid', _importedGroupUuids)  .whereNot({ tenant_id: tenantId }).pluck('uuid') as string[]) : []);
        const foreignMonitorUuids = new Set<string>(_importedMonitorUuids.length ? (await trx('monitors')             .whereIn('uuid', _importedMonitorUuids).whereNot({ tenant_id: tenantId }).pluck('uuid') as string[]) : []);
        const foreignChannelUuids = new Set<string>(_importedChannelUuids.length ? (await trx('notification_channels').whereIn('uuid', _importedChannelUuids).whereNot({ tenant_id: tenantId }).pluck('uuid') as string[]) : []);
        const foreignTeamUuids    = new Set<string>(_importedTeamUuids.length    ? (await trx('user_teams')           .whereIn('uuid', _importedTeamUuids)   .whereNot({ tenant_id: tenantId }).pluck('uuid') as string[]) : []);
        const foreignActionUuids  = new Set<string>(_importedActionUuids.length  ? (await trx('remediation_actions')  .whereIn('uuid', _importedActionUuids) .whereNot({ tenant_id: tenantId }).pluck('uuid') as string[]) : []);

        /**
         * Determine the effective (uuid, strategy) for an item being imported.
         *
         * Rules:
         *  - No UUID in data                         → CREATE with a fresh UUID
         *  - UUID belongs to a different tenant      → CREATE with a fresh UUID
         *    (regardless of conflictStrategy — cannot reuse or mutate foreign UUIDs)
         *  - UUID not in target tenant               → CREATE with the given UUID
         *  - UUID exists in target tenant            → apply conflictStrategy
         *    · update      → UPDATE existing record
         *    · generateNew → CREATE with new random UUID
         *    · ignore      → SKIP
         */
        function resolveConflict(
          inputUuid: string | null | undefined,
          idMap: Map<string, number>,
          foreignUuids: Set<string>,
        ): { action: 'create'; uuid: string } | { action: 'update'; uuid: string; existingId: number } | { action: 'skip' } {
          if (!inputUuid) {
            return { action: 'create', uuid: randomUUID() };
          }
          // UUID belongs to another tenant → must generate a fresh one
          if (foreignUuids.has(inputUuid)) {
            return { action: 'create', uuid: randomUUID() };
          }
          const existingId = idMap.get(inputUuid);
          if (existingId === undefined) {
            // UUID not in target tenant at all → create with provided UUID
            return { action: 'create', uuid: inputUuid };
          }
          // UUID conflict in target tenant → apply strategy
          if (conflictStrategy === 'update')      return { action: 'update', uuid: inputUuid, existingId };
          if (conflictStrategy === 'generateNew') return { action: 'create', uuid: randomUUID() };
          /* ignore */                            return { action: 'skip' };
        }

        // ── Monitor Groups ────────────────────────────────────────────────────
        if (want('monitorGroups') && Array.isArray(data.monitorGroups)) {
          let created = 0, updated = 0, skipped = 0;

          const sorted = topoSort(
            data.monitorGroups as Record<string, unknown>[],
            'uuid', 'parentUuid',
          );

          for (const g of sorted) {
            if (!g.name) { skipped++; continue; }

            const decision  = resolveConflict(g.uuid as string | undefined, groupIdByUuid, foreignGroupUuids);
            const parentId  = resolveGroup(g.parentUuid as string | null | undefined);

            if (decision.action === 'skip') {
              // Still register so children can resolve their parent
              if (g.uuid) batchGroupByOrigUuid.set(g.uuid as string, groupIdByUuid.get(g.uuid as string)!);
              skipped++;
              continue;
            }

            if (decision.action === 'update') {
              await trx('monitor_groups').where({ uuid: decision.uuid, tenant_id: tenantId }).update({
                name:                g.name,
                description:         (g.description as string | null) ?? null,
                sort_order:          (g.sortOrder as number) ?? 0,
                is_general:          (g.isGeneral as boolean) ?? false,
                group_notifications: (g.groupNotifications as boolean) ?? false,
                parent_id:           parentId,
                updated_at:          new Date(),
              });
              batchGroupByOrigUuid.set(decision.uuid, decision.existingId);
              if (g.uuid && g.uuid !== decision.uuid)
                batchGroupByOrigUuid.set(g.uuid as string, decision.existingId);
              updated++;
            } else {
              // create
              const slug  = await ensureUniqueSlugTrx(trx, slugify(g.name as string), tenantId);
              const [row] = await trx('monitor_groups').insert({
                uuid:                decision.uuid,
                name:                g.name,
                slug,
                description:         (g.description as string | null) ?? null,
                parent_id:           parentId,
                sort_order:          (g.sortOrder as number) ?? 0,
                is_general:          (g.isGeneral as boolean) ?? false,
                group_notifications: (g.groupNotifications as boolean) ?? false,
                kind:                'monitor',
                tenant_id:           tenantId,
              }).returning('*');

              await insertGroupClosure(trx, row.id, parentId);
              groupIdByUuid.set(decision.uuid, row.id);
              // Map original UUID (if different) to new DB id for child resolution
              if (g.uuid) batchGroupByOrigUuid.set(g.uuid as string, row.id);
              batchGroupByOrigUuid.set(decision.uuid, row.id);
              created++;
            }
          }
          results.monitorGroups = { created, updated, skipped };
        }

        // ── Monitors ─────────────────────────────────────────────────────────
        if (want('monitors') && Array.isArray(data.monitors)) {
          let created = 0, updated = 0, skipped = 0;

          for (const m of data.monitors as Record<string, unknown>[]) {
            if (!m.name || !m.type) { skipped++; continue; }

            const decision = resolveConflict(m.uuid as string | undefined, monitorIdByUuid, foreignMonitorUuids);
            const groupId  = resolveGroup(m.groupUuid as string | null | undefined);

            if (decision.action === 'skip') { skipped++; continue; }

            // Resolve push_token conflict: null it out if another monitor owns this token
            let pushToken: string | null = (m.pushToken as string | null) ?? null;
            if (pushToken) {
              const conflict = await trx('monitors')
                .where({ push_token: pushToken })
                .whereNot({ uuid: decision.uuid })
                .first();
              if (conflict) pushToken = null;
            }

            const row: Record<string, unknown> = {
              name:                       m.name,
              description:                (m.description as string | null) ?? null,
              type:                       m.type,
              group_id:                   groupId,
              is_active:                  (m.isActive as boolean) ?? true,
              status:                     'pending',
              interval_seconds:           (m.intervalSeconds as number | null) ?? null,
              retry_interval_seconds:     (m.retryIntervalSeconds as number | null) ?? null,
              max_retries:                (m.maxRetries as number | null) ?? null,
              timeout_ms:                 (m.timeoutMs as number | null) ?? null,
              upside_down:                (m.upsideDown as boolean) ?? false,
              url:                        (m.url as string | null) ?? null,
              method:                     (m.method as string | null) ?? null,
              headers:                    m.headers ? JSON.stringify(m.headers) : null,
              body:                       (m.body as string | null) ?? null,
              expected_status_codes:      (m.expectedStatusCodes as number[] | null) ?? null,
              keyword:                    (m.keyword as string | null) ?? null,
              keyword_is_present:         (m.keywordIsPresent as boolean | null) ?? null,
              ignore_ssl:                 (m.ignoreSsl as boolean) ?? false,
              json_path:                  (m.jsonPath as string | null) ?? null,
              json_expected_value:        (m.jsonExpectedValue as string | null) ?? null,
              hostname:                   (m.hostname as string | null) ?? null,
              port:                       (m.port as number | null) ?? null,
              dns_record_type:            (m.dnsRecordType as string | null) ?? null,
              dns_resolver:               (m.dnsResolver as string | null) ?? null,
              dns_expected_value:         (m.dnsExpectedValue as string | null) ?? null,
              ssl_warn_days:              (m.sslWarnDays as number | null) ?? null,
              smtp_host:                  (m.smtpHost as string | null) ?? null,
              smtp_port:                  (m.smtpPort as number | null) ?? null,
              docker_host:                (m.dockerHost as string | null) ?? null,
              docker_container_name:      (m.dockerContainerName as string | null) ?? null,
              game_type:                  (m.gameType as string | null) ?? null,
              game_host:                  (m.gameHost as string | null) ?? null,
              game_port:                  (m.gamePort as number | null) ?? null,
              push_token:                 pushToken,
              push_max_interval_sec:      (m.pushMaxIntervalSec as number | null) ?? null,
              script_command:             (m.scriptCommand as string | null) ?? null,
              script_expected_exit:       (m.scriptExpectedExit as number | null) ?? null,
              browser_url:                (m.browserUrl as string | null) ?? null,
              browser_keyword:            (m.browserKeyword as string | null) ?? null,
              browser_keyword_is_present: (m.browserKeywordIsPresent as boolean | null) ?? null,
              browser_wait_for_selector:  (m.browserWaitForSelector as string | null) ?? null,
              browser_screenshot_on_failure: (m.browserScreenshotOnFailure as boolean) ?? false,
              value_watcher_url:          (m.valueWatcherUrl as string | null) ?? null,
              value_watcher_json_path:    (m.valueWatcherJsonPath as string | null) ?? null,
              value_watcher_operator:     (m.valueWatcherOperator as string | null) ?? null,
              value_watcher_threshold:    (m.valueWatcherThreshold as number | null) ?? null,
              value_watcher_threshold_max:(m.valueWatcherThresholdMax as number | null) ?? null,
              value_watcher_headers:      m.valueWatcherHeaders ? JSON.stringify(m.valueWatcherHeaders) : null,
              tenant_id:                  tenantId,
              updated_at:                 new Date(),
            };

            if (decision.action === 'update') {
              await trx('monitors').where({ uuid: decision.uuid, tenant_id: tenantId }).update(row);
              updated++;
            } else {
              const [inserted] = await trx('monitors').insert({ ...row, uuid: decision.uuid }).returning('id');
              // Map original UUID to new DB id so settings/bindings can resolve it
              if (m.uuid) monitorIdByUuid.set(m.uuid as string, inserted.id);
              monitorIdByUuid.set(decision.uuid, inserted.id);
              created++;
            }
          }
          results.monitors = { created, updated, skipped };
        }

        // ── Settings ─────────────────────────────────────────────────────────
        if (want('settings') && Array.isArray(data.settings)) {
          let created = 0, skipped = 0;

          for (const s of data.settings as Record<string, unknown>[]) {
            if (!s.scope || !s.key) { skipped++; continue; }

            const scope = s.scope as string;
            let scopeId: number | null = null;

            if (scope !== 'global') {
              const scopeUuid = s.scopeUuid as string | null;
              if (!scopeUuid) { skipped++; continue; }
              if (scope === 'group')   scopeId = resolveGroup(scopeUuid);
              if (scope === 'monitor') scopeId = resolveMonitor(scopeUuid);
              if (scopeId === null) { skipped++; continue; }
            }

            const value = typeof s.value === 'string' ? s.value : JSON.stringify(s.value);

            // Delete-then-insert avoids NULL-uniqueness ambiguity for global settings
            await trx('settings').where({ scope, scope_id: scopeId, key: s.key, tenant_id: tenantId }).del();
            await trx('settings').insert({ scope, scope_id: scopeId, key: s.key, value, tenant_id: tenantId, updated_at: new Date() });
            created++;
          }
          results.settings = { created, updated: 0, skipped };
        }

        // ── Notification Channels ─────────────────────────────────────────────
        if (want('notificationChannels') && Array.isArray(data.notificationChannels)) {
          let created = 0, updated = 0, skipped = 0;

          for (const c of data.notificationChannels as Record<string, unknown>[]) {
            if (!c.name || !c.type) { skipped++; continue; }

            const decision = resolveConflict(c.uuid as string | undefined, channelIdByUuid, foreignChannelUuids);

            if (decision.action === 'skip') { skipped++; continue; }

            const channelRow: Record<string, unknown> = {
              name:       c.name,
              type:       c.type,
              config:     typeof c.config === 'string' ? c.config : JSON.stringify(c.config ?? {}),
              is_enabled: (c.isEnabled as boolean) ?? true,
              tenant_id:  tenantId,
              updated_at: new Date(),
            };

            let channelId: number;
            if (decision.action === 'update') {
              await trx('notification_channels').where({ uuid: decision.uuid, tenant_id: tenantId }).update(channelRow);
              channelId = decision.existingId;
              updated++;
            } else {
              const [inserted] = await trx('notification_channels')
                .insert({ ...channelRow, uuid: decision.uuid })
                .returning('id');
              channelId = inserted.id;
              if (c.uuid) channelIdByUuid.set(c.uuid as string, channelId);
              channelIdByUuid.set(decision.uuid, channelId);
              created++;
            }

            // Rebuild bindings (delete old, insert resolved)
            if (Array.isArray(c.bindings)) {
              await trx('notification_bindings').where({ channel_id: channelId }).del();
              for (const b of c.bindings as Record<string, unknown>[]) {
                const bScope   = b.scope as string;
                let   bScopeId: number | null = null;

                if (bScope !== 'global') {
                  const bUuid = b.scopeUuid as string | null;
                  if (!bUuid) continue;
                  if (bScope === 'group')   bScopeId = resolveGroup(bUuid);
                  if (bScope === 'monitor') bScopeId = resolveMonitor(bUuid);
                  if (bScopeId === null) continue;
                }

                await trx('notification_bindings').insert({
                  channel_id:    channelId,
                  scope:         bScope,
                  scope_id:      bScopeId,
                  override_mode: (b.overrideMode as string) ?? 'merge',
                });
              }
            }
          }
          results.notificationChannels = { created, updated, skipped };
        }

        // ── Agent Groups ──────────────────────────────────────────────────────
        if (want('agentGroups') && Array.isArray(data.agentGroups)) {
          let created = 0, updated = 0, skipped = 0;

          const sorted = topoSort(
            data.agentGroups as Record<string, unknown>[],
            'uuid', 'parentUuid',
          );

          for (const g of sorted) {
            if (!g.name) { skipped++; continue; }

            const decision = resolveConflict(g.uuid as string | undefined, groupIdByUuid, foreignGroupUuids);
            const parentId = resolveGroup(g.parentUuid as string | null | undefined);

            if (decision.action === 'skip') {
              if (g.uuid) batchGroupByOrigUuid.set(g.uuid as string, groupIdByUuid.get(g.uuid as string)!);
              skipped++;
              continue;
            }

            if (decision.action === 'update') {
              await trx('monitor_groups').where({ uuid: decision.uuid, tenant_id: tenantId }).update({
                name:             g.name,
                description:      (g.description as string | null) ?? null,
                sort_order:       (g.sortOrder as number) ?? 0,
                agent_thresholds: g.agentThresholds  ? JSON.stringify(g.agentThresholds)  : null,
                agent_group_config: importedAgentGroupConfigJson(g.agentGroupConfig),
                updated_at:       new Date(),
              });
              batchGroupByOrigUuid.set(decision.uuid, decision.existingId);
              if (g.uuid) batchGroupByOrigUuid.set(g.uuid as string, decision.existingId);
              updated++;
            } else {
              const slug  = await ensureUniqueSlugTrx(trx, slugify(g.name as string), tenantId);
              const [row] = await trx('monitor_groups').insert({
                uuid:               decision.uuid,
                name:               g.name,
                slug,
                description:        (g.description as string | null) ?? null,
                parent_id:          parentId,
                sort_order:         (g.sortOrder as number) ?? 0,
                is_general:         false,
                group_notifications: false,
                kind:               'agent',
                agent_thresholds:   g.agentThresholds  ? JSON.stringify(g.agentThresholds)  : null,
                agent_group_config: importedAgentGroupConfigJson(g.agentGroupConfig),
                tenant_id:          tenantId,
              }).returning('*');

              await insertGroupClosure(trx, row.id, parentId);
              groupIdByUuid.set(decision.uuid, row.id);
              if (g.uuid) batchGroupByOrigUuid.set(g.uuid as string, row.id);
              batchGroupByOrigUuid.set(decision.uuid, row.id);
              created++;
            }
          }
          results.agentGroups = { created, updated, skipped };
        }

        // ── Teams ─────────────────────────────────────────────────────────────
        if (want('teams') && Array.isArray(data.teams)) {
          let created = 0, updated = 0, skipped = 0;

          for (const t of data.teams as Record<string, unknown>[]) {
            if (!t.name) { skipped++; continue; }

            const decision = resolveConflict(t.uuid as string | undefined, teamIdByUuid, foreignTeamUuids);

            if (decision.action === 'skip') { skipped++; continue; }

            const teamRow: Record<string, unknown> = {
              name:        t.name,
              description: (t.description as string | null) ?? null,
              can_create:  (t.canCreate as boolean) ?? false,
              tenant_id:   tenantId,
              updated_at:  new Date(),
            };

            let teamId: number;
            if (decision.action === 'update') {
              try {
                await trx('user_teams').where({ uuid: decision.uuid, tenant_id: tenantId }).update(teamRow);
              } catch {
                // Name conflict with another team — keep existing
              }
              teamId = decision.existingId;
              updated++;
            } else {
              // Skip if a different team in this tenant already owns this name
              const nameConflict = await trx('user_teams').where({ name: t.name, tenant_id: tenantId }).first();
              if (nameConflict) { skipped++; continue; }

              const [inserted] = await trx('user_teams').insert({ ...teamRow, uuid: decision.uuid }).returning('id');
              teamId = inserted.id;
              if (t.uuid) teamIdByUuid.set(t.uuid as string, teamId);
              teamIdByUuid.set(decision.uuid, teamId);
              created++;
            }

            if (Array.isArray(t.permissions)) {
              await trx('team_permissions').where({ team_id: teamId }).del();
              for (const p of t.permissions as Record<string, unknown>[]) {
                const pScope = p.scope as string;
                const pUuid  = p.scopeUuid as string | null;
                if (!pUuid) continue;

                let scopeId: number | null = null;
                if (pScope === 'group')   scopeId = resolveGroup(pUuid);
                if (pScope === 'monitor') scopeId = resolveMonitor(pUuid);
                if (scopeId === null) continue;

                await trx('team_permissions').insert({
                  team_id:  teamId,
                  scope:    pScope,
                  scope_id: scopeId,
                  level:    (p.level as string) ?? 'ro',
                }).onConflict(['team_id', 'scope', 'scope_id']).ignore();
              }
            }
          }
          results.teams = { created, updated, skipped };
        }

        // ── Remediation Actions ─────────────────────────────────────────────────
        if (want('remediationActions') && Array.isArray(data.remediationActions)) {
          let created = 0, updated = 0, skipped = 0;

          // Build UUID map for remediation_actions (scoped to tenant)
          const actionIdByUuid: Map<string, number> = new Map();
          for (const r of await trx('remediation_actions').where({ tenant_id: tenantId }).select('id', 'uuid'))
            actionIdByUuid.set(r.uuid, r.id);

          // Also track newly imported actions so bindings can reference them in same run
          const batchActionByOrigUuid: Map<string, number> = new Map();

          for (const a of data.remediationActions as Record<string, unknown>[]) {
            if (!a.name || !a.type) { skipped++; continue; }

            const decision = resolveConflict(a.uuid as string | undefined, actionIdByUuid, foreignActionUuids);

            if (decision.action === 'skip') {
              if (a.uuid) batchActionByOrigUuid.set(a.uuid as string, actionIdByUuid.get(a.uuid as string)!);
              skipped++;
              continue;
            }

            const configVal = typeof a.config === 'string'
              ? a.config
              : JSON.stringify(a.config ?? {});

            const actionRow: Record<string, unknown> = {
              name:       a.name,
              type:       a.type,
              config:     configVal,
              enabled:    (a.enabled as boolean) ?? true,
              tenant_id:  tenantId,
              updated_at: new Date(),
            };

            if (decision.action === 'update') {
              await trx('remediation_actions').where({ uuid: decision.uuid, tenant_id: tenantId }).update(actionRow);
              batchActionByOrigUuid.set(decision.uuid, decision.existingId);
              if (a.uuid) batchActionByOrigUuid.set(a.uuid as string, decision.existingId);
              updated++;
            } else {
              const [inserted] = await trx('remediation_actions')
                .insert({ ...actionRow, uuid: decision.uuid })
                .returning('id');
              actionIdByUuid.set(decision.uuid, inserted.id);
              if (a.uuid) batchActionByOrigUuid.set(a.uuid as string, inserted.id);
              batchActionByOrigUuid.set(decision.uuid, inserted.id);
              created++;
            }
          }

          // Store batch map on outer scope so remediationBindings can use it
          (trx as any).__remediationActionBatchMap = batchActionByOrigUuid;
          (trx as any).__remediationActionIdByUuid = actionIdByUuid;

          results.remediationActions = { created, updated, skipped };
        }

        // ── Remediation Bindings ────────────────────────────────────────────────
        if (want('remediationBindings') && Array.isArray(data.remediationBindings)) {
          let created = 0, skipped = 0;

          // Resolve action UUID → DB id: prefer batch map (from this import run)
          // then fall back to looking up existing actions from DB
          const batchActionMap: Map<string, number> =
            (trx as any).__remediationActionBatchMap ?? new Map<string, number>();
          let actionIdByUuid: Map<string, number> =
            (trx as any).__remediationActionIdByUuid ?? new Map<string, number>();

          // If remediationActions wasn't imported in this run, load from DB (scoped to tenant)
          if (actionIdByUuid.size === 0) {
            const rows = await trx('remediation_actions').where({ tenant_id: tenantId }).select('id', 'uuid');
            actionIdByUuid = new Map(rows.map((r: { id: number; uuid: string }) => [r.uuid, r.id]));
          }

          function resolveAction(uuid: string | null | undefined): number | null {
            if (!uuid) return null;
            return batchActionMap.get(uuid) ?? actionIdByUuid.get(uuid) ?? null;
          }

          for (const b of data.remediationBindings as Record<string, unknown>[]) {
            const bScope = b.scope as string;
            if (!bScope) { skipped++; continue; }

            const actionId = resolveAction(b.actionUuid as string | null | undefined);
            if (actionId === null) { skipped++; continue; }

            let bScopeId: number | null = null;
            if (bScope !== 'global') {
              const bUuid = b.scopeUuid as string | null;
              if (!bUuid) { skipped++; continue; }
              if (bScope === 'group')   bScopeId = resolveGroup(bUuid);
              if (bScope === 'monitor') bScopeId = resolveMonitor(bUuid);
              if (bScopeId === null) { skipped++; continue; }
            }

            // Upsert — replace existing binding for this action+scope combination
            await trx('remediation_bindings')
              .where({ action_id: actionId, scope: bScope, scope_id: bScopeId })
              .del();

            await trx('remediation_bindings').insert({
              action_id:       actionId,
              scope:           bScope,
              scope_id:        bScopeId,
              override_mode:   (b.overrideMode as string) ?? 'merge',
              trigger_on:      (b.triggerOn   as string) ?? 'down',
              cooldown_seconds:(b.cooldownSeconds as number) ?? 300,
            });
            created++;
          }
          results.remediationBindings = { created, updated: 0, skipped };
        }

      }); // end transaction

      // Imported groups may carry an update policy: drop the cached chains.
      invalidateAgentUpdatePolicyCache();
      res.json({ success: true, data: results });
    } catch (err) {
      next(err);
    }
  },
};
