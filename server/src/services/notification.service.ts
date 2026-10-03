import type { Knex } from 'knex';
import { db } from '../db';
import type {
  NotificationChannel,
  NotificationBinding,
  OverrideMode,
  NotificationEventFields,
  NotificationKind,
} from '@obliview/shared';
import { NOTIFICATION_REDACTED, MASTER_TENANT_ID, isMasterTenant } from '@obliview/shared';
import type { NotificationPayload } from '../notifications/types';
import { getPlugin } from '../notifications/registry';
import {
  configHasPlaintextSecrets,
  openChannelConfig,
  sealChannelConfig,
  secretFieldsFor,
  unreadableSecretFields,
} from '../notifications/secretFields';
import { smtpServerService } from './smtpServer.service';
import { config } from '../config';
import { logger } from '../utils/logger';

/** Payload handed to the plugins: legacy status fields plus the IPS event fields. */
export type IpsNotificationPayload = NotificationPayload & NotificationEventFields;

export type BindingScope = 'global' | 'group' | 'agent';

/** Structured data of an agent IPS event (all optional; looked up when missing). */
export interface AgentEventDetails {
  ip?: string;
  service?: string;
  failureCount?: number;
  username?: string;
}

interface ChannelRow {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  is_enabled: boolean;
  created_by: number | null;
  tenant_id: number;
  created_at: Date;
  updated_at: Date;
}

interface BindingRow {
  id: number;
  channel_id: number;
  scope: string;
  scope_id: number | null;
  override_mode: string;
  tenant_id: number;
}

/** A binding with the tenant it belongs to (migration 034). */
export type TenantNotificationBinding = NotificationBinding & { tenantId: number };

/** Who a delivery was for (notification_log.tenant_id / scope / scope_id). */
export interface NotificationLogContext {
  tenantId?: number | null;
  scope?: 'global' | 'group' | 'agent' | null;
  scopeId?: number | null;
}

// One-shot re-encryption of legacy plaintext channel secrets, started on the
// first access of the service, in the background (a failure is logged, never
// thrown; configs left plaintext are sealed on their next write).
let reencryption: Promise<number> | null = null;

function startReencryption(): void {
  if (reencryption) return;
  reencryption = notificationService.reencryptSecrets().catch((err) => {
    logger.warn({ err }, 'Notification secret re-encryption failed');
    return 0;
  });
}

const BINDING_COLUMNS = ['b.id', 'b.channel_id', 'b.scope', 'b.scope_id', 'b.override_mode', 'b.tenant_id'] as const;

// A channel shared to another tenant is visible there (so its admins can bind
// it to their groups/agents) but its secrets are not: every config key that
// looks like a credential, plus every field the plugin declares as a password,
// is replaced by NOTIFICATION_REDACTED, and the channel is flagged readOnly so
// the client disables the edit form.
const SECRET_KEY_TEST = /(secret|token|password|pass|api[_-]?key|key|webhook|url|topic)$/i;

function parseConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function redactConfig(type: string, raw: unknown): Record<string, unknown> {
  const cfg = parseConfig(raw);
  // The plugin's password fields plus its other secret keys (secretFields.ts).
  const passwordFields = new Set(secretFieldsFor(type));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = passwordFields.has(k) || SECRET_KEY_TEST.test(k) ? NOTIFICATION_REDACTED : v;
  }
  return out;
}

/**
 * `currentTenantId` is the caller's tenant (request handlers). Background jobs
 * omit it and get the full config. The Default tenant owns every channel.
 * Owners get the secret fields decrypted (they are sealed at rest, see
 * notifications/secretFields); a non-owner gets them redacted.
 */
function rowToChannel(row: ChannelRow, currentTenantId?: number): NotificationChannel {
  const isOwner = currentTenantId === undefined
    || row.tenant_id === currentTenantId
    || isMasterTenant(currentTenantId);
  const ch: NotificationChannel = {
    id: row.id,
    name: row.name,
    type: row.type,
    config: isOwner ? openChannelConfig(row.type, parseConfig(row.config)) : redactConfig(row.type, row.config),
    isEnabled: row.is_enabled,
    createdBy: row.created_by,
    tenantId: row.tenant_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  if (currentTenantId !== undefined) {
    ch.isShared = row.tenant_id !== currentTenantId;
    ch.readOnly = !isOwner;
  }
  return ch;
}

function rowToBinding(row: BindingRow): TenantNotificationBinding {
  return {
    id: row.id,
    channelId: row.channel_id,
    scope: row.scope as NotificationBinding['scope'],
    scopeId: row.scope_id,
    overrideMode: row.override_mode as OverrideMode,
    tenantId: row.tenant_id,
  };
}

/** Channel ids visible to a tenant: its own channels plus those shared to it. */
function visibleChannelIdsQuery(tenantId: number) {
  return db('notification_channels')
    .select('id')
    .where('tenant_id', tenantId)
    .orWhereIn('id', db('notification_channel_tenants').select('channel_id').where({ tenant_id: tenantId }));
}

/**
 * Resolution filter for the bindings of a non-Default tenant: a merge/replace
 * row only counts while its channel is still visible to the tenant (a revoked
 * share stops the tenant's alerts from reaching the former sharer's channel).
 * Exclude rows always count. The Default tenant's rows are never filtered.
 */
function onlyVisibleChannels(qb: Knex.QueryBuilder, tenantId: number, column = 'channel_id'): void {
  if (isMasterTenant(tenantId)) return;
  const modeColumn = column.includes('.') ? `${column.split('.')[0]}.override_mode` : 'override_mode';
  qb.where(function () {
    this.where(modeColumn, 'exclude').orWhereIn(column, visibleChannelIdsQuery(tenantId));
  });
}

// ── IPS message builders ─────────────────────────────────────────────────────

/** Legacy status vocabulary (icons/colours of the plugins) for each IPS kind. */
const KIND_STATUS: Record<NotificationKind, string> = {
  threat: 'alert',
  attack: 'down',
  ban: 'down',
  down: 'down',
  up: 'up',
  test: 'up',
};

const KINDS: readonly NotificationKind[] = ['threat', 'attack', 'ban', 'down', 'up', 'test'];

function toKind(value: string): NotificationKind | null {
  return (KINDS as readonly string[]).includes(value) ? value as NotificationKind : null;
}

function failures(n: number): string {
  return `${n} failure${n === 1 ? '' : 's'}`;
}

/** ban.service violation text: "<ip> banned (<count> <service> failures)". */
const BAN_VIOLATION_RE = /^(\S+) banned \((\d+) (\S+) failures?\)/;

/**
 * Title and message of an agent IPS notification. Never falls back to the
 * Obliview "metrics are back to normal" text: every kind has its own wording.
 */
export function buildAgentMessage(
  kind: NotificationKind | null,
  agentName: string,
  details: AgentEventDetails,
  violations: string[] = [],
): { title: string; message: string } {
  const { ip, service, failureCount } = details;
  switch (kind) {
    case 'threat': {
      const parts = [service, failureCount !== undefined ? failures(failureCount) : null].filter(Boolean);
      return {
        title: `${agentName}: suspicious activity`,
        message: ip
          ? `Agent ${agentName}: suspicious activity from ${ip}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`
          : `Agent ${agentName}: suspicious activity detected`,
      };
    }
    case 'attack':
    case 'ban': {
      let text: string;
      if (violations.length > 0) {
        text = violations.join('; ');
      } else if (ip) {
        const why = failureCount !== undefined
          ? ` (${failureCount} ${service ? `${service} ` : ''}${failureCount === 1 ? 'failure' : 'failures'})`
          : service ? ` (${service})` : '';
        text = `${ip} banned${why}`;
      } else {
        text = 'An attacking IP was banned';
      }
      return {
        title: ip ? `${agentName}: ${ip} banned` : `${agentName}: attacker banned`,
        message: `${text} - attack on agent ${agentName}`,
      };
    }
    case 'down':
      return {
        title: `${agentName} is offline`,
        message: `Agent ${agentName} is offline - bans are no longer enforced`,
      };
    case 'up':
      return {
        title: `${agentName} is back online`,
        message: `Agent ${agentName} is back online`,
      };
    default:
      return {
        title: agentName,
        message: violations.length > 0 ? violations.join('; ') : `Agent ${agentName}: status changed`,
      };
  }
}

export const notificationService = {
  // ── Channel CRUD ──

  async getAllChannels(tenantId: number): Promise<NotificationChannel[]> {
    startReencryption();
    // Own channels + channels shared to this tenant via the junction table
    const rows = await db<ChannelRow>('notification_channels')
      .where(function () {
        this.where('notification_channels.tenant_id', tenantId)
          .orWhereIn(
            'notification_channels.id',
            db('notification_channel_tenants').select('channel_id').where({ tenant_id: tenantId }),
          );
      })
      .orderBy('name');
    return rows.map((row) => rowToChannel(row, tenantId));
  },

  /**
   * Tenant-agnostic lookup (background jobs). Request handlers pass the
   * caller's tenant so a channel they do not own comes back redacted.
   */
  async getChannelById(id: number, currentTenantId?: number): Promise<NotificationChannel | null> {
    startReencryption();
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = await db<ChannelRow>('notification_channels').where({ id }).first();
    return row ? rowToChannel(row, currentTenantId) : null;
  },

  async createChannel(data: {
    name: string;
    type: string;
    config: Record<string, unknown>;
    isEnabled?: boolean;
    createdBy?: number;
  }, tenantId: number): Promise<NotificationChannel> {
    startReencryption();
    const plugin = getPlugin(data.type);
    if (!plugin) throw new Error(`Unknown notification type: ${data.type}`);

    const [row] = await db<ChannelRow>('notification_channels')
      .insert({
        name: data.name,
        type: data.type,
        config: JSON.stringify(sealChannelConfig(data.type, data.config)) as unknown as Record<string, unknown>,
        is_enabled: data.isEnabled ?? true,
        created_by: data.createdBy ?? null,
        tenant_id: tenantId,
      })
      .returning('*');

    return rowToChannel(row, tenantId);
  },

  async updateChannel(id: number, data: {
    name?: string;
    config?: Record<string, unknown>;
    isEnabled?: boolean;
  }, currentTenantId?: number): Promise<NotificationChannel | null> {
    startReencryption();
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    const current = await db<ChannelRow>('notification_channels').where({ id }).first();
    const stored = parseConfig(current?.config);
    if (data.config !== undefined) {
      // A form that round-trips a masked value must never overwrite the stored
      // secret (kept as stored, i.e. sealed); new secret values are sealed.
      const merged: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data.config)) {
        merged[k] = v === NOTIFICATION_REDACTED ? stored[k] : v;
      }
      updateData.config = JSON.stringify(sealChannelConfig(current?.type ?? '', merged));
    } else if (current && configHasPlaintextSecrets(current.type, stored)) {
      // Any write also seals legacy plaintext secrets left in place.
      updateData.config = JSON.stringify(sealChannelConfig(current.type, stored));
    }
    if (data.isEnabled !== undefined) updateData.is_enabled = data.isEnabled;

    const [row] = await db<ChannelRow>('notification_channels')
      .where({ id })
      .update(updateData)
      .returning('*');
    return row ? rowToChannel(row, currentTenantId) : null;
  },

  async deleteChannel(id: number): Promise<boolean> {
    const count = await db('notification_channels').where({ id }).del();
    return count > 0;
  },

  /**
   * Seals the legacy plaintext secrets of every channel config. Idempotent:
   * configs without plaintext secrets are left alone. Each row is re-read
   * under a row lock, so a concurrent update is never overwritten; updated_at
   * is left alone (not a user change). Returns the number of rows sealed.
   */
  async reencryptSecrets(): Promise<number> {
    const candidates = await db<ChannelRow>('notification_channels').select('id', 'type', 'config');
    let sealed = 0;
    for (const c of candidates) {
      if (!configHasPlaintextSecrets(c.type, parseConfig(c.config))) continue;
      await db.transaction(async (trx) => {
        const row = await trx<ChannelRow>('notification_channels').where({ id: c.id }).forUpdate().first('id', 'type', 'config');
        if (!row) return;
        const cfg = parseConfig(row.config);
        if (!configHasPlaintextSecrets(row.type, cfg)) return;
        await trx('notification_channels').where({ id: row.id })
          .update({ config: JSON.stringify(sealChannelConfig(row.type, cfg)) });
        sealed++;
      });
    }
    if (sealed > 0) logger.info({ count: sealed }, 'Notification channel secrets encrypted at rest');
    return sealed;
  },

  // ── Cross-tenant channel sharing ──

  /** Returns the list of tenant IDs the channel is shared to (not including its own tenant). */
  async getChannelTenants(channelId: number): Promise<number[]> {
    const rows = await db('notification_channel_tenants')
      .where({ channel_id: channelId })
      .select('tenant_id');
    return rows.map((r: { tenant_id: number }) => r.tenant_id);
  },

  /** Replaces the sharing list for a channel (full replace — not additive). */
  async setChannelTenants(channelId: number, tenantIds: number[]): Promise<void> {
    await db.transaction(async (trx) => {
      await trx('notification_channel_tenants').where({ channel_id: channelId }).del();
      if (tenantIds.length > 0) {
        await trx('notification_channel_tenants').insert(
          tenantIds.map((tenant_id) => ({ channel_id: channelId, tenant_id })),
        );
      }
    });
  },

  /**
   * Resolve the effective config for a channel.
   * For smtp channels using smtpServerId, fetches the SMTP server and injects its credentials.
   * For all other channels, returns config as-is (backward-compat).
   */
  async resolveChannelConfig(channel: NotificationChannel): Promise<Record<string, unknown>> {
    // Secrets come decrypted from rowToChannel; one still sealed could not be.
    const unreadable = unreadableSecretFields(channel.type, channel.config);
    if (unreadable.length > 0) {
      throw new Error(`Channel secret cannot be decrypted (${unreadable.join(', ')}): CREDENTIAL_ENCRYPTION_KEY / SESSION_SECRET changed?`);
    }
    if (channel.type === 'smtp' && channel.config.smtpServerId) {
      const server = await smtpServerService.getTransportConfig(Number(channel.config.smtpServerId));
      if (!server) throw new Error(`SMTP server #${channel.config.smtpServerId} not found`);
      return {
        host: server.host,
        port: server.port,
        secure: server.secure,
        username: server.username,
        password: server.password,
        from: channel.config.fromOverride || server.fromAddress,
        to: channel.config.to,
      };
    }
    return channel.config;
  },

  /** `tenantId`: the caller's tenant, recorded in notification_log (default: the channel's). */
  async testChannel(id: number, tenantId?: number): Promise<void> {
    const channel = await this.getChannelById(id);
    if (!channel) throw new Error('Channel not found');

    const plugin = getPlugin(channel.type);
    if (!plugin) throw new Error(`No plugin for type: ${channel.type}`);

    const ctx: NotificationLogContext = { tenantId: tenantId ?? channel.tenantId };
    try {
      const resolvedConfig = await this.resolveChannelConfig(channel);
      await plugin.sendTest(resolvedConfig);
      await this.logNotification(channel.id, 'test', true, 'Test notification', undefined, ctx);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      await this.logNotification(channel.id, 'test', false, 'Test notification', errMsg, ctx);
      throw error;
    }
  },

  // ── Bindings ──
  //
  // Every binding belongs to a tenant (notification_bindings.tenant_id,
  // migration 034). Group/agent bindings carry the tenant of their target. A
  // 'global' binding covers the agents of its own tenant only, except a
  // global binding of the Default tenant, which covers every tenant (the
  // platform on-call channel, owner decision).

  /**
   * Raw bindings of one scope (resolution engine). `tenantId` narrows them to
   * one tenant (plus the Default tenant's rows): the resolvers pass the
   * tenant of the device / group, so a stale row left by a device moved to
   * another tenant never fires.
   */
  async getBindings(scope: string, scopeId: number | null, tenantId?: number | null): Promise<TenantNotificationBinding[]> {
    const q = db<BindingRow>('notification_bindings').where({ scope });
    if (scopeId === null) q.whereNull('scope_id');
    else q.where('scope_id', scopeId);
    if (tenantId !== undefined && tenantId !== null) {
      // The target tenant's rows (on a still-visible channel), plus the
      // Default tenant's: legacy rows made from Default on another tenant's
      // target before bindings were tenant-checked (migration 034 keeps them
      // as Default rows so they keep firing).
      q.where(function () {
        this.where('tenant_id', MASTER_TENANT_ID);
        if (!isMasterTenant(tenantId)) {
          this.orWhere(function () {
            this.where('tenant_id', tenantId);
            onlyVisibleChannels(this, tenantId);
          });
        }
      });
    }
    const rows = await q.orderBy('id');
    return rows.map(rowToBinding);
  },

  /**
   * Global bindings that apply to agents of `tenantId`: the tenant's own
   * global bindings plus the Default tenant's. `tenantId` null (unknown
   * owner) gets the Default tenant's only.
   */
  async getGlobalBindingsForTenant(tenantId: number | null): Promise<TenantNotificationBinding[]> {
    const own = tenantId !== null && !isMasterTenant(tenantId) ? tenantId : null;
    const rows = await db<BindingRow>('notification_bindings as b')
      .where('b.scope', 'global')
      .whereNull('b.scope_id')
      .where(function () {
        this.where('b.tenant_id', MASTER_TENANT_ID);
        if (own !== null) {
          this.orWhere(function () {
            this.where('b.tenant_id', own);
            onlyVisibleChannels(this, own, 'b.channel_id');
          });
        }
      })
      .orderBy('b.id')
      .select(...BINDING_COLUMNS);
    return rows.map(rowToBinding);
  },

  /**
   * Bindings of the caller tenant, optionally narrowed to one scope (and
   * scope id). A tenant sees only its own rows (group/agent rows: on a target
   * it still owns). The Default tenant sees every tenant's rows (god view),
   * each with its tenantId so the UI can tell its own from the others.
   */
  async listBindingsForTenant(
    tenantId: number,
    scope?: BindingScope,
    scopeId?: number | null,
  ): Promise<TenantNotificationBinding[]> {
    const q = db<BindingRow>('notification_bindings as b')
      .select(...BINDING_COLUMNS)
      .orderBy('b.id');
    if (scope) {
      q.where('b.scope', scope);
      if (scope === 'global' || scopeId === null) q.whereNull('b.scope_id');
      else if (scopeId !== undefined) q.where('b.scope_id', scopeId);
    }
    if (!isMasterTenant(tenantId)) {
      q.where('b.tenant_id', tenantId);
      q.where(function () {
        this.where('b.scope', 'global')
          .orWhere(function () {
            this.where('b.scope', 'group')
              .whereIn('b.scope_id', db('monitor_groups').select('id').where({ tenant_id: tenantId }));
          })
          .orWhere(function () {
            this.where('b.scope', 'agent')
              .whereIn('b.scope_id', db('agent_devices').select('id').where({ tenant_id: tenantId }));
          });
      });
    }
    const rows = await q;
    return rows.map(rowToBinding);
  },

  /**
   * Create or update the binding of `tenantId` (the operating tenant). Upsert
   * in code, NOT via .onConflict(): the unique index is on an expression
   * (COALESCE(scope_id, 0)), which ON CONFLICT cannot target by columns, and
   * a NULL scope_id (global scope) never matched the old column constraint,
   * so every "enable globally" inserted a duplicate. A concurrent insert that
   * loses the race against the unique index (23505) becomes an update.
   */
  async addBinding(
    channelId: number,
    scope: string,
    scopeId: number | null,
    tenantId: number,
    overrideMode: OverrideMode = 'merge',
  ): Promise<TenantNotificationBinding> {
    const findExisting = () => db<BindingRow>('notification_bindings')
      .where({ channel_id: channelId, scope, tenant_id: tenantId })
      .modify((qb) => {
        if (scopeId === null) qb.whereNull('scope_id');
        else qb.where('scope_id', scopeId);
      })
      .first();
    const updateExisting = async (id: number): Promise<TenantNotificationBinding> => {
      const [row] = await db<BindingRow>('notification_bindings')
        .where({ id })
        .update({ override_mode: overrideMode })
        .returning('*');
      return rowToBinding(row);
    };

    const existing = await findExisting();
    if (existing) return updateExisting(existing.id);
    try {
      const [row] = await db<BindingRow>('notification_bindings')
        .insert({
          tenant_id: tenantId,
          channel_id: channelId,
          scope,
          scope_id: scopeId,
          override_mode: overrideMode,
        })
        .returning('*');
      return rowToBinding(row);
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      const raced = await findExisting();
      if (!raced) throw err;
      return updateExisting(raced.id);
    }
  },

  /**
   * Remove a binding. Global scope: only the row of `tenantId` (a tenant
   * never removes another tenant's global binding). Group/agent scope: the
   * caller has checked that the target is its own; every row on it goes
   * (stale rows of a previous owner included).
   */
  async removeBinding(channelId: number, scope: string, scopeId: number | null, tenantId: number): Promise<boolean> {
    const count = await db('notification_bindings')
      .where({ channel_id: channelId, scope })
      .modify((qb) => {
        if (scopeId === null) qb.whereNull('scope_id');
        else qb.where('scope_id', scopeId);
        if (scope === 'global') qb.where('tenant_id', tenantId);
      })
      .del();
    return count > 0;
  },

  // ── Resolution (merge/replace/exclude inheritance) ──

  /**
   * Apply a set of bindings to the current channel set.
   * 1. If any binding has 'replace' mode → clear the set first
   * 2. Add all 'merge' (and 'replace') bindings to the set
   * 3. Remove all 'exclude' bindings from the set
   */
  _applyBindings(channelIds: Set<number>, bindings: NotificationBinding[]): Set<number> {
    if (bindings.length === 0) return channelIds;

    const hasReplace = bindings.some((b) => b.overrideMode === 'replace');
    if (hasReplace) {
      channelIds = new Set();
    }

    // Add merge/replace bindings
    for (const b of bindings) {
      if (b.overrideMode !== 'exclude') {
        channelIds.add(b.channelId);
      }
    }

    // Remove exclude bindings
    for (const b of bindings) {
      if (b.overrideMode === 'exclude') {
        channelIds.delete(b.channelId);
      }
    }

    return channelIds;
  },

  /**
   * Resolve bindings for a group WITH source info (for the UI).
   * Shows which channels are active and where they come from.
   * Also tracks excluded channels so the UI can show "Unbind" state.
   */
  async resolveBindingsWithSources(
    scope: 'group',
    scopeId: number,
  ): Promise<{
    channelId: number;
    channelName: string;
    channelType: string;
    source: 'global' | 'group';
    sourceId: number | null;
    sourceName: string;
    isDirect: boolean;
    isExcluded: boolean;
  }[]> {
    interface SourceInfo {
      channelId: number;
      source: 'global' | 'group';
      sourceId: number | null;
      sourceName: string;
      isDirect: boolean;
      isExcluded: boolean;
    }

    // Build the inheritance chain
    const result: Map<number, SourceInfo> = new Map();
    // Track excluded channel IDs separately for the final output
    const excludedSet: Set<number> = new Set();

    const applyBindingsWithSources = (
      bindings: NotificationBinding[],
      source: SourceInfo['source'],
      sourceId: number | null,
      sourceName: string,
      isDirect: boolean,
    ) => {
      if (bindings.length === 0) return;

      const hasReplace = bindings.some((b) => b.overrideMode === 'replace');
      if (hasReplace) {
        result.clear();
        excludedSet.clear();
      }

      // Add merge/replace bindings
      for (const b of bindings) {
        if (b.overrideMode !== 'exclude') {
          result.set(b.channelId, {
            channelId: b.channelId,
            source,
            sourceId,
            sourceName,
            isDirect,
            isExcluded: false,
          });
          excludedSet.delete(b.channelId);
        }
      }

      // Process excludes
      for (const b of bindings) {
        if (b.overrideMode === 'exclude') {
          // Keep the entry in result (for UI to show it) but mark as excluded
          const existing = result.get(b.channelId);
          if (existing) {
            existing.isExcluded = true;
          }
          excludedSet.add(b.channelId);
        }
      }
    };

    // 1. Global bindings that apply to the group's tenant
    const groupTenant = await db('monitor_groups').where({ id: scopeId }).first('tenant_id') as { tenant_id: number | null } | undefined;
    const tenantId = groupTenant?.tenant_id ?? null;
    const globalBindings = await this.getGlobalBindingsForTenant(tenantId);
    applyBindingsWithSources(globalBindings, 'global', null, 'Global', false);

    // 2. Parent chain (ancestors of this group, self excluded)
    const ancestorRows = await db('group_closure')
      .where('descendant_id', scopeId)
      .where('depth', '>', 0)
      .orderBy('depth', 'desc')
      .select('ancestor_id');

    for (const row of ancestorRows) {
      const groupBindings = await this.getBindings('group', row.ancestor_id, tenantId);
      const groupRow = await db('monitor_groups').where({ id: row.ancestor_id }).first('name');
      applyBindingsWithSources(
        groupBindings,
        'group',
        row.ancestor_id,
        groupRow?.name || `Group #${row.ancestor_id}`,
        false,
      );
    }

    // 3. Direct bindings at this scope
    const directBindings = await this.getBindings(scope, scopeId, tenantId);
    applyBindingsWithSources(directBindings, scope, scopeId, 'Direct', true);

    // Enrich with channel name/type
    const channelIds = Array.from(result.keys());
    if (channelIds.length === 0) return [];

    const channels = await db<ChannelRow>('notification_channels').whereIn('id', channelIds);
    const channelMap = new Map(channels.map((c) => [c.id, c]));

    return Array.from(result.values()).map((r) => {
      const ch = channelMap.get(r.channelId);
      return {
        ...r,
        channelName: ch?.name || `Channel #${r.channelId}`,
        channelType: ch?.type || 'unknown',
      };
    });
  },

  // ── Send notifications ──

  /**
   * Resolve channels for a group-level notification.
   * Chain: Global → Group ancestors (root→leaf, including the group itself).
   */
  async resolveChannelsForGroup(groupId: number): Promise<number[]> {
    let channelIds: Set<number> = new Set();

    // 1. Global bindings that apply to the group's tenant
    const groupTenant = await db('monitor_groups').where({ id: groupId }).first('tenant_id') as { tenant_id: number | null } | undefined;
    const tenantId = groupTenant?.tenant_id ?? null;
    const globalBindings = await this.getGlobalBindingsForTenant(tenantId);
    channelIds = this._applyBindings(channelIds, globalBindings);

    // 2. Group chain (root → leaf, including self via depth >= 0)
    const ancestorRows = await db('group_closure')
      .where('descendant_id', groupId)
      .orderBy('depth', 'desc')
      .select('ancestor_id');

    for (const row of ancestorRows) {
      const groupBindings = await this.getBindings('group', row.ancestor_id, tenantId);
      channelIds = this._applyBindings(channelIds, groupBindings);
    }

    return Array.from(channelIds);
  },

  /**
   * Resolve which channels should fire for a given agent device.
   * Chain: Global (the device tenant's + the Default tenant's) → Agent Group
   * ancestors (root→leaf) → Agent-level bindings, all of the device's tenant.
   */
  async resolveChannelsForAgent(deviceId: number): Promise<number[]> {
    let channelIds: Set<number> = new Set();

    const device = await db('agent_devices').where({ id: deviceId }).select('group_id', 'tenant_id').first() as
      { group_id: number | null; tenant_id: number | null } | undefined;

    // 1. Global bindings that apply to the agent's tenant
    const globalBindings = await this.getGlobalBindingsForTenant(device?.tenant_id ?? null);
    channelIds = this._applyBindings(channelIds, globalBindings);

    // 2. Agent group hierarchy (root → leaf)
    if (device?.group_id) {
      const ancestorRows = await db('group_closure')
        .where('descendant_id', device.group_id)
        .orderBy('depth', 'desc')
        .select('ancestor_id');

      for (const row of ancestorRows) {
        const groupBindings = await this.getBindings('group', row.ancestor_id, device.tenant_id);
        channelIds = this._applyBindings(channelIds, groupBindings);
      }
    }

    // 3. Agent-level bindings
    const agentBindings = device ? await this.getBindings('agent', deviceId, device.tenant_id) : [];
    channelIds = this._applyBindings(channelIds, agentBindings);

    return Array.from(channelIds);
  },

  /**
   * Resolve bindings for an agent device WITH source info (for the UI).
   * Chain: Global → Agent Group ancestors (root→leaf) → Agent-level bindings.
   */
  async resolveBindingsWithSourcesForAgent(
    deviceId: number,
  ): Promise<{
    channelId: number;
    channelName: string;
    channelType: string;
    source: 'global' | 'group' | 'agent';
    sourceId: number | null;
    sourceName: string;
    isDirect: boolean;
    isExcluded: boolean;
  }[]> {
    interface SourceInfo {
      channelId: number;
      source: 'global' | 'group' | 'agent';
      sourceId: number | null;
      sourceName: string;
      isDirect: boolean;
      isExcluded: boolean;
    }

    const result: Map<number, SourceInfo> = new Map();
    const excludedSet: Set<number> = new Set();

    const applyBindingsWithSources = (
      bindings: NotificationBinding[],
      source: SourceInfo['source'],
      sourceId: number | null,
      sourceName: string,
      isDirect: boolean,
    ) => {
      if (bindings.length === 0) return;

      const hasReplace = bindings.some((b) => b.overrideMode === 'replace');
      if (hasReplace) {
        result.clear();
        excludedSet.clear();
      }

      for (const b of bindings) {
        if (b.overrideMode !== 'exclude') {
          result.set(b.channelId, {
            channelId: b.channelId,
            source,
            sourceId,
            sourceName,
            isDirect,
            isExcluded: false,
          });
          excludedSet.delete(b.channelId);
        }
      }

      for (const b of bindings) {
        if (b.overrideMode === 'exclude') {
          const existing = result.get(b.channelId);
          if (existing) {
            existing.isExcluded = true;
          }
          excludedSet.add(b.channelId);
        }
      }
    };

    const device = await db('agent_devices').where({ id: deviceId }).select('group_id', 'tenant_id').first() as
      { group_id: number | null; tenant_id: number | null } | undefined;

    // 1. Global bindings that apply to the agent's tenant
    const globalBindings = await this.getGlobalBindingsForTenant(device?.tenant_id ?? null);
    applyBindingsWithSources(globalBindings, 'global', null, 'Global', false);

    // 2. Agent group hierarchy (root → leaf)
    if (device?.group_id) {
      const ancestorRows = await db('group_closure')
        .where('descendant_id', device.group_id)
        .orderBy('depth', 'desc')
        .select('ancestor_id');

      for (const row of ancestorRows) {
        const groupBindings = await this.getBindings('group', row.ancestor_id, device.tenant_id);
        const groupRow = await db('monitor_groups').where({ id: row.ancestor_id }).first('name') as { name: string } | undefined;
        applyBindingsWithSources(
          groupBindings,
          'group',
          row.ancestor_id,
          groupRow?.name || `Group #${row.ancestor_id}`,
          false,
        );
      }
    }

    // 3. Agent-level bindings
    const agentBindings = device ? await this.getBindings('agent', deviceId, device.tenant_id) : [];
    applyBindingsWithSources(agentBindings, 'agent', deviceId, 'Direct', true);

    // Enrich with channel name/type
    const channelIds = Array.from(result.keys());
    if (channelIds.length === 0) return [];

    const channels = await db<ChannelRow>('notification_channels').whereIn('id', channelIds);
    const channelMap = new Map(channels.map((c) => [c.id, c]));

    return Array.from(result.values()).map((r) => {
      const ch = channelMap.get(r.channelId);
      return {
        ...r,
        channelName: ch?.name || `Channel #${r.channelId}`,
        channelType: ch?.type || 'unknown',
      };
    });
  },

  /**
   * Resolve the effective notification types for an agent device through the
   * IPS settings cascade (W13): default → global → tenant → group chain →
   * agent, each field on its own. The legacy columns (agent_devices
   * .notification_types, agent_group_config, agent_global_config) are kept in
   * sync by every write path but no longer read here.
   */
  async resolveNotificationTypesForDevice(deviceId: number): Promise<{
    global: boolean; down: boolean; up: boolean; threat: boolean; attack: boolean;
  }> {
    const { agentConfigService } = await import('./agentConfig.service');
    return agentConfigService.resolveNotificationTypesForDevice(deviceId);
  },

  /**
   * Most active attacker of an agent over the last minutes, used to describe a
   * threat when the caller did not pass the event details. Best-effort.
   */
  async _latestThreatDetails(deviceId: number): Promise<AgentEventDetails> {
    try {
      const since = new Date(Date.now() - 5 * 60 * 1000);
      const row = await db('ip_events')
        .where({ device_id: deviceId, event_type: 'auth_failure' })
        .where('timestamp', '>=', since)
        .groupBy('ip', 'service')
        .select(db.raw('host(ip) as ip'), 'service', db.raw('count(*)::int as failures'), db.raw('max(username) as username'))
        .orderBy('failures', 'desc')
        .first() as { ip: string; service: string; failures: number; username: string | null } | undefined;
      if (!row) return {};
      return { ip: row.ip, service: row.service, failureCount: Number(row.failures), username: row.username ?? undefined };
    } catch (err) {
      logger.warn({ err, deviceId }, 'Notification: failed to look up threat details');
      return {};
    }
  },

  /**
   * Send notifications for an agent IPS event (threat, attack/ban, down, up).
   * Resolves channels using the global → group → agent chain.
   */
  async sendForAgent(
    deviceId: number,
    deviceName: string,
    newStatus: string,
    previousStatus: string,
    violations?: string[],
    notifType?: 'threat' | 'attack' | 'up' | 'down',
    details?: AgentEventDetails,
  ): Promise<void> {
    // Only notify on status transitions
    if (newStatus === previousStatus) return;

    // Check notification type preferences
    const types = await this.resolveNotificationTypesForDevice(deviceId);
    if (!types.global) {
      logger.info(`Agent notification suppressed (global=off) for device ${deviceId}`);
      return;
    }
    const kind: NotificationKind | null = notifType ?? toKind(newStatus);
    const prefKey = kind === 'ban' ? 'attack' : kind;
    if (prefKey === 'threat' || prefKey === 'attack' || prefKey === 'up' || prefKey === 'down') {
      if (!types[prefKey]) {
        logger.info(`Agent notification suppressed (${prefKey} type disabled) for device ${deviceId}`);
        return;
      }
    }

    const channelIds = await this.resolveChannelsForAgent(deviceId);
    if (channelIds.length === 0) {
      logger.warn(`No notification channels resolved for agent device ${deviceId} (event: ${newStatus}) — check global/agent bindings`);
      return;
    }

    // Event details: explicit > parsed from the ban violation > recent events.
    let eventDetails: AgentEventDetails = { ...(details ?? {}) };
    if ((kind === 'attack' || kind === 'ban') && !eventDetails.ip && violations && violations.length > 0) {
      const m = BAN_VIOLATION_RE.exec(violations[0]);
      if (m) eventDetails = { ip: m[1], failureCount: Number(m[2]), service: m[3], ...eventDetails };
    }
    if (kind === 'threat' && !eventDetails.ip) {
      eventDetails = { ...(await this._latestThreatDetails(deviceId)), ...eventDetails };
    }

    const { title, message } = buildAgentMessage(kind, deviceName, eventDetails, violations ?? []);

    let tenantName: string | undefined;
    try {
      const t = await db('agent_devices as d')
        .join('tenants as t', 't.id', 'd.tenant_id')
        .where('d.id', deviceId)
        .first('t.name') as { name: string } | undefined;
      tenantName = t?.name;
    } catch { /* tenant name is decorative */ }

    const url = `${config.appUrl.replace(/\/+$/, '')}/agents/${deviceId}`;
    const payload: IpsNotificationPayload = {
      monitorName: deviceName,
      monitorUrl: url,
      oldStatus: previousStatus,
      // Legacy vocabulary for icons/colours; the IPS meaning is in `kind`.
      newStatus: kind ? KIND_STATUS[kind] : newStatus,
      message,
      timestamp: new Date().toISOString(),
      appName: config.appName,
      kind: kind ?? undefined,
      title,
      ip: eventDetails.ip,
      service: eventDetails.service,
      failureCount: eventDetails.failureCount,
      username: eventDetails.username,
      agentName: deviceName,
      tenantName,
      url,
    };

    const channels = await db<ChannelRow>('notification_channels')
      .whereIn('id', channelIds)
      .where({ is_enabled: true });

    const deviceTenant = await db('agent_devices').where({ id: deviceId }).first('tenant_id') as { tenant_id: number | null } | undefined;
    await this._dispatch(channels, payload, `agent_${kind ?? 'status_change'}`, `device "${deviceName}"`, {
      tenantId: deviceTenant?.tenant_id ?? null, scope: 'agent', scopeId: deviceId,
    });
  },

  /**
   * Send a group-level notification.
   * Resolves channels at the group level (no agent bindings) and dispatches.
   */
  async sendForGroup(
    groupId: number,
    groupName: string,
    payload: NotificationPayload,
  ): Promise<void> {
    const channelIds = await this.resolveChannelsForGroup(groupId);
    if (channelIds.length === 0) return;

    const enrichedPayload: NotificationPayload = { ...payload, appName: config.appName };

    const channels = await db<ChannelRow>('notification_channels')
      .whereIn('id', channelIds)
      .where({ is_enabled: true });

    const groupTenant = await db('monitor_groups').where({ id: groupId }).first('tenant_id') as { tenant_id: number | null } | undefined;
    await this._dispatch(channels, enrichedPayload, 'group_status_change', `group "${groupName}"`, {
      tenantId: groupTenant?.tenant_id ?? null, scope: 'group', scopeId: groupId,
    });
  },

  /**
   * Send one payload to every channel. A failing channel (plugin error, SMTP
   * server gone, log insert error) never stops the others.
   */
  async _dispatch(
    channels: ChannelRow[],
    payload: IpsNotificationPayload,
    eventType: string,
    label: string,
    ctx: NotificationLogContext = {},
  ): Promise<void> {
    startReencryption();
    for (const row of channels) {
      const channel = rowToChannel(row);
      const plugin = getPlugin(channel.type);
      if (!plugin) {
        logger.warn(`No plugin for notification type "${channel.type}"`);
        continue;
      }

      try {
        const resolvedConfig = await this.resolveChannelConfig(channel);
        await plugin.send(resolvedConfig, payload);
        await this.logNotification(channel.id, eventType, true, payload.message, undefined, ctx);
        logger.info(`Notification sent: ${channel.name} (${channel.type}) for ${label}`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        await this.logNotification(channel.id, eventType, false, payload.message, errMsg, ctx);
        logger.error(`Notification failed: ${channel.name} (${channel.type}) for ${label}: ${errMsg}`);
      }
    }
  },

  /** Best-effort delivery log: an insert failure is logged, never thrown. */
  async logNotification(
    channelId: number,
    eventType: string,
    success: boolean,
    message?: string,
    error?: string,
    ctx: NotificationLogContext = {},
  ): Promise<void> {
    try {
      await db('notification_log').insert({
        channel_id: channelId,
        event_type: eventType.slice(0, 50),
        success,
        message: message ? message.slice(0, 2000) : null,
        error: error ? error.slice(0, 2000) : null,
        tenant_id: ctx.tenantId ?? null,
        scope: ctx.scope ?? null,
        scope_id: ctx.scopeId ?? null,
      });
    } catch (err) {
      logger.warn({ err, channelId, eventType }, 'Failed to write notification_log row');
    }
  },
};
