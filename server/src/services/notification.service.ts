import { db } from '../db';
import type {
  NotificationChannel,
  NotificationBinding,
  NotificationTypeConfig,
  OverrideMode,
  NotificationEventFields,
  NotificationKind,
} from '@obliview/shared';
import { DEFAULT_NOTIFICATION_TYPES, NOTIFICATION_REDACTED, MASTER_TENANT_ID, isMasterTenant } from '@obliview/shared';
import type { NotificationPayload } from '../notifications/types';
import { getPlugin } from '../notifications/registry';
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
}

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
  const passwordFields = new Set(
    (getPlugin(type)?.configFields ?? []).filter((f) => f.type === 'password').map((f) => f.key),
  );
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = passwordFields.has(k) || SECRET_KEY_TEST.test(k) ? NOTIFICATION_REDACTED : v;
  }
  return out;
}

/**
 * `currentTenantId` is the caller's tenant (request handlers). Background jobs
 * omit it and get the full config. The Default tenant owns every channel.
 */
function rowToChannel(row: ChannelRow, currentTenantId?: number): NotificationChannel {
  const isOwner = currentTenantId === undefined
    || row.tenant_id === currentTenantId
    || isMasterTenant(currentTenantId);
  const ch: NotificationChannel = {
    id: row.id,
    name: row.name,
    type: row.type,
    config: isOwner ? parseConfig(row.config) : redactConfig(row.type, row.config),
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

function rowToBinding(row: BindingRow): NotificationBinding {
  return {
    id: row.id,
    channelId: row.channel_id,
    scope: row.scope as NotificationBinding['scope'],
    scopeId: row.scope_id,
    overrideMode: row.override_mode as OverrideMode,
  };
}

/** Channel ids visible to a tenant: its own channels plus those shared to it. */
function visibleChannelIdsQuery(tenantId: number) {
  return db('notification_channels')
    .select('id')
    .where('tenant_id', tenantId)
    .orWhereIn('id', db('notification_channel_tenants').select('channel_id').where({ tenant_id: tenantId }));
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
    const plugin = getPlugin(data.type);
    if (!plugin) throw new Error(`Unknown notification type: ${data.type}`);

    const [row] = await db<ChannelRow>('notification_channels')
      .insert({
        name: data.name,
        type: data.type,
        config: JSON.stringify(data.config) as unknown as Record<string, unknown>,
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
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.config !== undefined) {
      // A form that round-trips a masked value must never overwrite the stored secret.
      const current = await db<ChannelRow>('notification_channels').where({ id }).first();
      const stored = parseConfig(current?.config);
      const merged: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data.config)) {
        merged[k] = v === NOTIFICATION_REDACTED ? stored[k] : v;
      }
      updateData.config = JSON.stringify(merged);
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

  async testChannel(id: number): Promise<void> {
    const channel = await this.getChannelById(id);
    if (!channel) throw new Error('Channel not found');

    const plugin = getPlugin(channel.type);
    if (!plugin) throw new Error(`No plugin for type: ${channel.type}`);

    try {
      const resolvedConfig = await this.resolveChannelConfig(channel);
      await plugin.sendTest(resolvedConfig);
      await this.logNotification(channel.id, 'test', true, 'Test notification');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      await this.logNotification(channel.id, 'test', false, 'Test notification', errMsg);
      throw error;
    }
  },

  // ── Bindings ──

  /** Raw bindings of one scope (resolution engine; not tenant-filtered). */
  async getBindings(scope: string, scopeId: number | null): Promise<NotificationBinding[]> {
    const q = db<BindingRow>('notification_bindings').where({ scope });
    if (scopeId === null) q.whereNull('scope_id');
    else q.where('scope_id', scopeId);
    const rows = await q;
    return rows.map(rowToBinding);
  },

  /**
   * Global bindings that apply to agents of `tenantId`. Bindings carry no
   * tenant: a global binding belongs to its channel's owner. A Default-owned
   * channel bound globally covers every tenant (platform on-call channel);
   * another tenant's global binding covers only its own agents.
   * `tenantId` null (unknown owner) keeps every global binding.
   */
  async getGlobalBindingsForTenant(tenantId: number | null): Promise<NotificationBinding[]> {
    const q = db<BindingRow>('notification_bindings as b')
      .join('notification_channels as c', 'c.id', 'b.channel_id')
      .where('b.scope', 'global')
      .whereNull('b.scope_id')
      .select('b.id', 'b.channel_id', 'b.scope', 'b.scope_id', 'b.override_mode');
    if (tenantId !== null) q.whereIn('c.tenant_id', [MASTER_TENANT_ID, tenantId]);
    const rows = await q;
    return rows.map(rowToBinding);
  },

  /**
   * Bindings visible to the caller tenant, optionally narrowed to one scope
   * (and scope id). Global rows: channel visible to the tenant and owned by
   * it or by Default (a global binding covers its owner's agents). Group/agent
   * rows: target owned by the tenant. The Default tenant sees every row.
   */
  async listBindingsForTenant(
    tenantId: number,
    scope?: BindingScope,
    scopeId?: number | null,
  ): Promise<NotificationBinding[]> {
    const q = db<BindingRow>('notification_bindings as b')
      .select('b.id', 'b.channel_id', 'b.scope', 'b.scope_id', 'b.override_mode')
      .orderBy('b.id');
    if (scope) {
      q.where('b.scope', scope);
      if (scope === 'global' || scopeId === null) q.whereNull('b.scope_id');
      else if (scopeId !== undefined) q.where('b.scope_id', scopeId);
    }
    if (!isMasterTenant(tenantId)) {
      q.where(function () {
        this.where(function () {
          // Only global rows that actually cover this tenant (owner = tenant
          // or Default, see getGlobalBindingsForTenant) on a visible channel.
          this.where('b.scope', 'global')
            .whereIn('b.channel_id', visibleChannelIdsQuery(tenantId))
            .whereIn('b.channel_id', db('notification_channels').select('id').whereIn('tenant_id', [MASTER_TENANT_ID, tenantId]));
        })
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

  async addBinding(channelId: number, scope: string, scopeId: number | null, overrideMode: OverrideMode = 'merge'): Promise<NotificationBinding> {
    // Upsert in code, NOT via .onConflict(): Postgres treats a NULL scope_id
    // (global scope) as distinct in the unique index, so ON CONFLICT never
    // matched a global binding and every "enable globally" inserted a duplicate.
    const existing = await db<BindingRow>('notification_bindings')
      .where({ channel_id: channelId, scope })
      .modify((qb) => {
        if (scopeId === null) qb.whereNull('scope_id');
        else qb.where('scope_id', scopeId);
      })
      .first();
    if (existing) {
      const [row] = await db<BindingRow>('notification_bindings')
        .where({ id: existing.id })
        .update({ override_mode: overrideMode })
        .returning('*');
      return rowToBinding(row);
    }
    const [row] = await db<BindingRow>('notification_bindings')
      .insert({
        channel_id: channelId,
        scope,
        scope_id: scopeId,
        override_mode: overrideMode,
      })
      .returning('*');
    return rowToBinding(row);
  },

  async removeBinding(channelId: number, scope: string, scopeId: number | null): Promise<boolean> {
    const count = await db('notification_bindings')
      .where({ channel_id: channelId, scope })
      .modify((qb) => {
        if (scopeId === null) qb.whereNull('scope_id');
        else qb.where('scope_id', scopeId);
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
    const globalBindings = await this.getGlobalBindingsForTenant(groupTenant?.tenant_id ?? null);
    applyBindingsWithSources(globalBindings, 'global', null, 'Global', false);

    // 2. Parent chain (ancestors of this group, self excluded)
    const ancestorRows = await db('group_closure')
      .where('descendant_id', scopeId)
      .where('depth', '>', 0)
      .orderBy('depth', 'desc')
      .select('ancestor_id');

    for (const row of ancestorRows) {
      const groupBindings = await this.getBindings('group', row.ancestor_id);
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
    const directBindings = await this.getBindings(scope, scopeId);
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
    const globalBindings = await this.getGlobalBindingsForTenant(groupTenant?.tenant_id ?? null);
    channelIds = this._applyBindings(channelIds, globalBindings);

    // 2. Group chain (root → leaf, including self via depth >= 0)
    const ancestorRows = await db('group_closure')
      .where('descendant_id', groupId)
      .orderBy('depth', 'desc')
      .select('ancestor_id');

    for (const row of ancestorRows) {
      const groupBindings = await this.getBindings('group', row.ancestor_id);
      channelIds = this._applyBindings(channelIds, groupBindings);
    }

    return Array.from(channelIds);
  },

  /**
   * Resolve which channels should fire for a given agent device.
   * Chain: Global → Agent Group ancestors (root→leaf) → Agent-level bindings.
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
        const groupBindings = await this.getBindings('group', row.ancestor_id);
        channelIds = this._applyBindings(channelIds, groupBindings);
      }
    }

    // 3. Agent-level bindings
    const agentBindings = await this.getBindings('agent', deviceId);
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
        const groupBindings = await this.getBindings('group', row.ancestor_id);
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
    const agentBindings = await this.getBindings('agent', deviceId);
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
   * Resolve the effective notification types for an agent device.
   * Chain: device notification_types → group agentGroupConfig.notificationTypes (ancestor chain) → system defaults.
   * Each field uses the first non-null value found in the chain.
   */
  async resolveNotificationTypesForDevice(deviceId: number): Promise<{
    global: boolean; down: boolean; up: boolean; threat: boolean; attack: boolean;
  }> {
    // Accumulated values — undefined means "not yet resolved"
    let global: boolean | undefined;
    let down:   boolean | undefined;
    let up:     boolean | undefined;
    let threat: boolean | undefined;
    let attack: boolean | undefined;

    const applyConfig = (cfg: NotificationTypeConfig | null | undefined) => {
      if (!cfg) return;
      if (global === undefined && cfg.global !== null && cfg.global !== undefined) global = cfg.global;
      if (down   === undefined && cfg.down   !== null && cfg.down   !== undefined) down   = cfg.down;
      if (up     === undefined && cfg.up     !== null && cfg.up     !== undefined) up     = cfg.up;
      if (threat === undefined && cfg.threat !== null && cfg.threat !== undefined) threat = cfg.threat;
      if (attack === undefined && cfg.attack !== null && cfg.attack !== undefined) attack = cfg.attack;
    };

    // 1. Device-level override
    const deviceRow = await db('agent_devices')
      .where({ id: deviceId })
      .select('group_id', 'notification_types')
      .first() as { group_id: number | null; notification_types: unknown } | undefined;

    if (deviceRow?.notification_types) {
      const nt = typeof deviceRow.notification_types === 'string'
        ? JSON.parse(deviceRow.notification_types)
        : deviceRow.notification_types as NotificationTypeConfig;
      applyConfig(nt);
    }

    // 2. Walk up the group hierarchy (leaf → root)
    if (deviceRow?.group_id) {
      const ancestorRows = await db('group_closure')
        .where('descendant_id', deviceRow.group_id)
        .orderBy('depth', 'asc')
        .select('ancestor_id');

      for (const row of ancestorRows) {
        const groupRow = await db('monitor_groups')
          .where({ id: row.ancestor_id })
          .select('agent_group_config')
          .first() as { agent_group_config: unknown } | undefined;
        if (groupRow?.agent_group_config) {
          const cfg = typeof groupRow.agent_group_config === 'string'
            ? JSON.parse(groupRow.agent_group_config)
            : groupRow.agent_group_config as { notificationTypes?: NotificationTypeConfig | null };
          applyConfig(cfg.notificationTypes);
        }
      }
    }

    // 3. Global agent defaults (from app_config agent_global_config)
    if (global === undefined || down === undefined || up === undefined || threat === undefined || attack === undefined) {
      const { appConfigService } = await import('./appConfig.service');
      const globalTypes = await appConfigService.getResolvedAgentNotificationTypes();
      if (global === undefined) global = globalTypes.global;
      if (down   === undefined) down   = globalTypes.down;
      if (up     === undefined) up     = globalTypes.up;
      if (threat === undefined) threat = globalTypes.threat;
      if (attack === undefined) attack = globalTypes.attack;
    }

    // 4. Hardcoded system defaults for any still-unresolved fields
    return {
      global: global ?? DEFAULT_NOTIFICATION_TYPES.global,
      down:   down   ?? DEFAULT_NOTIFICATION_TYPES.down,
      up:     up     ?? DEFAULT_NOTIFICATION_TYPES.up,
      threat: threat ?? DEFAULT_NOTIFICATION_TYPES.threat,
      attack: attack ?? DEFAULT_NOTIFICATION_TYPES.attack,
    };
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

    await this._dispatch(channels, payload, `agent_${kind ?? 'status_change'}`, `device "${deviceName}"`);
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

    await this._dispatch(channels, enrichedPayload, 'group_status_change', `group "${groupName}"`);
  },

  /**
   * Send one payload to every channel. A failing channel (plugin error, SMTP
   * server gone, log insert error) never stops the others.
   */
  async _dispatch(channels: ChannelRow[], payload: IpsNotificationPayload, eventType: string, label: string): Promise<void> {
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
        await this.logNotification(channel.id, eventType, true, payload.message);
        logger.info(`Notification sent: ${channel.name} (${channel.type}) for ${label}`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        await this.logNotification(channel.id, eventType, false, payload.message, errMsg);
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
  ): Promise<void> {
    try {
      await db('notification_log').insert({
        channel_id: channelId,
        event_type: eventType.slice(0, 50),
        success,
        message: message ? message.slice(0, 2000) : null,
        error: error ? error.slice(0, 2000) : null,
      });
    } catch (err) {
      logger.warn({ err, channelId, eventType }, 'Failed to write notification_log row');
    }
  },
};
