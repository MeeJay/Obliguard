/**
 * Agent API key lifecycle (W10-2: FLEET-AGENT-13, SECURITY-PARITY-19,
 * UI-PAGES-FLEET-14). Mirrors Obliance's key handlers (agent.controller
 * listKeys / createKey / updateKey / deleteKey) with owner decision 19: an
 * is_active revocation flag, keys stored as is (not hashed).
 *
 *   - list: masked values only (prefix + last 4). The full key is returned
 *     once by create; reveal() serves the Add-Agent install commands (same
 *     capability, active keys only).
 *   - rename / setActive / setDefaultGroup / remove: tenant-scoped, no master
 *     bypass (credentials are never god-viewed).
 *   - findActiveByValue: the agent channel lookup (agentAuth, WS gate). A
 *     disabled key answers exactly like an unknown one. No cache: every
 *     lookup reads is_active, so disabling is immediate.
 *
 * DB only: the caller closes live sessions (obliguardHub.closeByApiKey), so
 * this module stays free of the hub ↔ agent.service import cycle.
 */
import { db } from '../db';
import { logger } from '../utils/logger';
import { isAgentApiKeyFormat } from '../utils/agentIdentity';
import type { ErrorCode, ErrorParams } from '../utils/errorCodes';

// The listed shape (never the full value) and the create() result live in
// shared (W10 integration) so client and server agree on GET /agent/keys.
import type { AgentKeyView, AgentKeyCreated } from '@obliview/shared';
export type { AgentKeyView, AgentKeyCreated };

/** What the agent channel needs from an active key. */
export interface ActiveAgentKey {
  id: number;
  tenantId: number;
  defaultGroupId: number | null;
}

interface KeyRow {
  id: number;
  tenant_id: number;
  name: string;
  key: string;
  is_active: boolean | null;
  revoked_at: Date | null;
  revoked_by: number | null;
  default_group_id: number | null;
  default_group_name?: string | null;
  created_by: number | null;
  created_at: Date;
  last_used_at: Date | null;
  device_count?: string | number | null;
  pending_count?: string | number | null;
}

export const AGENT_KEY_NAME_MAX = 255;

export class AgentKeyError extends Error {
  constructor(
    public readonly status: 400 | 404,
    message: string,
    /** Error catalogue code (utils/errorCodes.ts), sent as `code` next to the message. */
    public readonly code?: ErrorCode,
    public readonly params?: ErrorParams,
  ) {
    super(message);
  }
}

/** "1a2b3c4d…9f0e": enough to tell keys apart, useless to enrol. */
export function maskAgentKey(key: string): string {
  if (key.length <= 12) return '…';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function toView(row: KeyRow): AgentKeyView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    keyMasked: maskAgentKey(String(row.key)),
    isActive: row.is_active !== false,
    revokedAt: iso(row.revoked_at),
    revokedBy: row.revoked_by ?? null,
    defaultGroupId: row.default_group_id ?? null,
    defaultGroupName: row.default_group_name ?? null,
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    lastUsedAt: iso(row.last_used_at),
    deviceCount: Number(row.device_count ?? 0),
    pendingCount: Number(row.pending_count ?? 0),
  };
}

/** Validated key name (trimmed, 1-255 chars) or an AgentKeyError(400). */
export function parseKeyName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new AgentKeyError(400, 'Name is required', 'AGENT_KEY_NAME_REQUIRED');
  if (name.length > AGENT_KEY_NAME_MAX) throw new AgentKeyError(400, `Name is limited to ${AGENT_KEY_NAME_MAX} characters`, 'AGENT_KEY_NAME_TOO_LONG', { max: AGENT_KEY_NAME_MAX });
  return name;
}

/**
 * Validated default group id: null clears it, otherwise a positive integer
 * naming a group of `tenantId` (AgentKeyError(400) else).
 */
async function resolveDefaultGroup(raw: unknown, tenantId: number): Promise<number | null> {
  if (raw === null) return null;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(id) || id <= 0) throw new AgentKeyError(400, 'Invalid default group', 'AGENT_KEY_GROUP_INVALID');
  const row = await db('monitor_groups').where({ id, tenant_id: tenantId }).first('id');
  if (!row) throw new AgentKeyError(400, 'Invalid default group', 'AGENT_KEY_GROUP_INVALID');
  return id;
}

function baseListQuery() {
  return db('agent_api_keys as k')
    .leftJoin('monitor_groups as g', 'g.id', 'k.default_group_id')
    .select(
      'k.*',
      'g.name as default_group_name',
      db.raw('(SELECT COUNT(*) FROM agent_devices d WHERE d.api_key_id = k.id) AS device_count'),
      db.raw("(SELECT COUNT(*) FROM agent_devices d WHERE d.api_key_id = k.id AND d.status = 'pending') AS pending_count"),
    );
}

export const agentKeyService = {
  /** Keys of the tenant, newest first, masked. */
  async list(tenantId: number): Promise<AgentKeyView[]> {
    const rows = await baseListQuery()
      .where('k.tenant_id', tenantId)
      .orderBy('k.created_at', 'desc')
      .orderBy('k.id', 'desc') as KeyRow[];
    return rows.map(toView);
  },

  async get(id: number, tenantId: number): Promise<AgentKeyView | null> {
    const row = await baseListQuery().where({ 'k.id': id, 'k.tenant_id': tenantId }).first() as KeyRow | undefined;
    return row ? toView(row) : null;
  },

  /** New active key. The full value is in the result, and nowhere else afterwards. */
  async create(
    tenantId: number,
    input: { name: unknown; defaultGroupId?: unknown },
    createdBy: number | null,
  ): Promise<AgentKeyCreated> {
    const name = parseKeyName(input.name);
    const defaultGroupId = input.defaultGroupId === undefined
      ? null
      : await resolveDefaultGroup(input.defaultGroupId, tenantId);
    const [row] = await db('agent_api_keys')
      .insert({
        name,
        tenant_id: tenantId,
        created_by: createdBy && createdBy > 0 ? createdBy : null,
        default_group_id: defaultGroupId,
        is_active: true,
      })
      .returning('*') as KeyRow[];
    logger.info({ apiKeyId: row.id, tenantId, byUserId: createdBy, defaultGroupId }, 'Agent API key created');
    const view = (await this.get(row.id, tenantId))!;
    return { ...view, key: String(row.key) };
  },

  /**
   * Partial update: name, isActive, defaultGroupId (null clears). Returns the
   * updated view and whether the key went from active to disabled (the caller
   * then closes its live sessions). AgentKeyError 400 / 404.
   */
  async update(
    id: number,
    tenantId: number,
    patch: { name?: unknown; isActive?: unknown; defaultGroupId?: unknown },
    byUserId: number | null,
  ): Promise<{ key: AgentKeyView; disabled: boolean; enabled: boolean }> {
    if (patch.name === undefined && patch.defaultGroupId === undefined && patch.isActive === undefined) {
      throw new AgentKeyError(400, 'Nothing to update', 'AGENT_KEY_NOTHING_TO_UPDATE');
    }
    const current = await db('agent_api_keys').where({ id, tenant_id: tenantId }).first('id', 'is_active') as
      { id: number; is_active: boolean | null } | undefined;
    if (!current) throw new AgentKeyError(404, 'API key not found', 'AGENT_KEY_NOT_FOUND');

    const update: Record<string, unknown> = {};
    if (patch.name !== undefined) update.name = parseKeyName(patch.name);
    if (patch.defaultGroupId !== undefined) update.default_group_id = await resolveDefaultGroup(patch.defaultGroupId, tenantId);
    let disabled = false;
    let enabled = false;
    if (patch.isActive !== undefined) {
      if (typeof patch.isActive !== 'boolean') throw new AgentKeyError(400, 'isActive must be a boolean', 'FIELD_BOOLEAN', { field: 'isActive' });
      const wasActive = current.is_active !== false;
      if (wasActive && !patch.isActive) {
        update.is_active = false;
        update.revoked_at = new Date();
        update.revoked_by = byUserId && byUserId > 0 ? byUserId : null;
        disabled = true;
      } else if (!wasActive && patch.isActive) {
        update.is_active = true;
        update.revoked_at = null;
        update.revoked_by = null;
        enabled = true;
      }
    }

    if (Object.keys(update).length > 0) {
      await db('agent_api_keys').where({ id, tenant_id: tenantId }).update(update);
      logger.info(
        { apiKeyId: id, tenantId, byUserId, changes: Object.keys(update), disabled, enabled },
        disabled ? 'Agent API key disabled' : enabled ? 'Agent API key re-enabled' : 'Agent API key updated',
      );
    }
    return { key: (await this.get(id, tenantId))!, disabled, enabled };
  },

  /**
   * Delete a key of the tenant. Its devices are released (FK SET NULL): prefer
   * disabling a leaked key. The caller closes the key's live sessions.
   */
  async remove(id: number, tenantId: number): Promise<boolean> {
    const count = await db('agent_api_keys').where({ id, tenant_id: tenantId }).del();
    return count > 0;
  },

  /**
   * Full value of an ACTIVE key of the tenant (Add-Agent install commands,
   * offline wizard). Null for an unknown, foreign or disabled key.
   */
  async reveal(id: number, tenantId: number): Promise<string | null> {
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = await db('agent_api_keys')
      .where({ id, tenant_id: tenantId })
      .first('key', 'is_active') as { key: string; is_active: boolean | null } | undefined;
    if (!row || row.is_active === false) return null;
    return String(row.key);
  },

  /**
   * Agent channel lookup by raw X-API-Key value: the key when it exists AND is
   * active, else null (unknown and disabled keys are indistinguishable to the
   * caller). The format is checked first: a non-uuid value would make the PG
   * uuid cast throw.
   */
  async findActiveByValue(raw: unknown): Promise<ActiveAgentKey | null> {
    if (!isAgentApiKeyFormat(raw)) return null;
    const row = await db('agent_api_keys')
      .where({ key: raw })
      .first('id', 'tenant_id', 'is_active', 'default_group_id') as
      { id: number; tenant_id: number; is_active: boolean | null; default_group_id: number | null } | undefined;
    if (!row || row.is_active === false) return null;
    return { id: row.id, tenantId: row.tenant_id, defaultGroupId: row.default_group_id ?? null };
  },

  /** True when the key exists and is active (re-check after an await). */
  async isActive(id: number): Promise<boolean> {
    const row = await db('agent_api_keys').where({ id }).first('is_active') as { is_active: boolean | null } | undefined;
    return !!row && row.is_active !== false;
  },

  /**
   * Group a new device enrolled with `apiKeyId` lands in: the key's default
   * group when it still belongs to the key's tenant, else null.
   */
  async defaultGroupFor(apiKeyId: number): Promise<number | null> {
    const row = await db('agent_api_keys as k')
      .join('monitor_groups as g', function () {
        this.on('g.id', '=', 'k.default_group_id').andOn('g.tenant_id', '=', 'k.tenant_id');
      })
      .where('k.id', apiKeyId)
      .first('g.id as group_id') as { group_id: number } | undefined;
    return row?.group_id ?? null;
  },
};
