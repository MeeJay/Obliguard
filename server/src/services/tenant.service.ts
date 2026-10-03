import type { Knex } from 'knex';
import { db, withoutStatementTimeout } from '../db';
import { MASTER_TENANT_ID, normalizeTenantRole } from '@obliview/shared';
import type { Tenant, TenantWithRole, TenantRole } from '@obliview/shared';

// ── Tenant deletion lifecycle (C13, owner decision 13) ────────────────────────

/**
 * What DELETE /tenants/:id does with the tenant's enrolled agents:
 *   - 'refuse' (default): 409 TENANT_HAS_AGENTS while any remain; the admin
 *     runs "Uninstall all agents" first (POST /tenants/:id/uninstall-agents);
 *   - 'uninstall': the deletion sends 'uninstall' to the connected agents and
 *     deletes the tenant at once (offline agents are left installed, locked
 *     out: their key is deleted with the tenant).
 * Set with TENANT_DELETE_AGENT_POLICY; anything else falls back to 'refuse'.
 */
export type TenantDeleteAgentPolicy = 'refuse' | 'uninstall';

function parseAgentPolicy(v: string | undefined): TenantDeleteAgentPolicy {
  return v?.trim().toLowerCase() === 'uninstall' ? 'uninstall' : 'refuse';
}

/** Runtime knobs of the tenant deletion. Tests may override agentPolicy. */
export const tenantDeleteConfig: { agentPolicy: TenantDeleteAgentPolicy } = {
  agentPolicy: parseAgentPolicy(process.env.TENANT_DELETE_AGENT_POLICY),
};

/**
 * The tenant's installed agents. Only enrolled agents (approved or suspended)
 * hold the tenant's bans in their firewall and block a deletion; pending and
 * refused registrations never received any ban and are deleted with the
 * tenant. MikroTik and M365 devices are not agents: they are purged and
 * deleted with the tenant.
 */
export interface TenantAgentSummary {
  /** Enrolled agents (approved + suspended): a non-zero total blocks the deletion under 'refuse'. */
  total: number;
  approved: number;
  /** Suspended agents receive no command: reinstate or delete them. */
  suspended: number;
  /** Approved agents with an uninstall queued or delivered (the cleanup job removes them). */
  uninstalling: number;
  /** Pending / refused registrations (deleted with the tenant). */
  unenrolled: number;
  /** MikroTik routers (purged and deleted with the tenant). */
  routers: number;
}

/** Thrown inside the deletion transaction when agents remain under 'refuse'. */
export class TenantHasAgentsError extends Error {
  constructor(public readonly count: number) {
    super(`The tenant still has ${count} agent(s)`);
    this.name = 'TenantHasAgentsError';
  }
}

/** Rows removed by a tenant deletion, per table (audit details). */
export type TenantDeletionCounts = Record<string, number>;

const ENROLLED_STATUSES = ['approved', 'suspended'] as const;

function agentRows(q: Knex | Knex.Transaction, tenantId: number): Knex.QueryBuilder {
  return q('agent_devices')
    .where('tenant_id', tenantId)
    .whereRaw("COALESCE(device_type, 'agent') = 'agent'");
}

/**
 * Tables whose rows target a group / agent / tenant through (scope, scope_id)
 * without a foreign key: rows of ANY tenant aimed at the deleted tenant's
 * groups and agents (e.g. a Default god-view binding) would otherwise outlive
 * them and point at reused ids.
 */
const SCOPED_TABLES = [
  'service_template_assignments',
  'team_permissions',
  'notification_bindings',
  'settings',
  'ip_bans',
  'ip_whitelist',
  'rate_limit_policies',
] as const;

/**
 * Tenant-owned rows deleted explicitly, in dependency order (children first).
 * The tenants row cascades the rest (ip_events, live alerts, snapshots,
 * reputation clears, ...); listing these keeps the deletion readable and gives
 * the audit row its counts. smtp_servers is SET NULL on the foreign key: a
 * tenant's SMTP server would otherwise become a platform server.
 */
const OWNED_TABLES = [
  'ip_ban_exclusions',
  'ip_bans',
  'ip_whitelist',
  'rate_limit_policies',
  'service_templates',
  'notification_bindings',
  'notification_channel_tenants',
  'notification_channels',
  'ip_display_names',
  'remote_blocklists',
  'settings',
  'live_alerts',
  'user_tenants',
  'user_teams',
  'agent_devices',
  'agent_api_keys',
  'monitor_groups',
  'smtp_servers',
] as const;

interface TenantRow {
  id: number;
  name: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  email: string | null;
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const tenantService = {
  async getAll(): Promise<Tenant[]> {
    const rows = await db('tenants').select<TenantRow[]>('*').orderBy('id');
    return rows.map(rowToTenant);
  },

  async getById(id: number): Promise<Tenant | null> {
    const row = await db('tenants').where({ id }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  /** True when a tenant with this id exists (rejects non-positive / unsafe ids). */
  async exists(id: number): Promise<boolean> {
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    return !!(await db('tenants').where({ id }).first('id'));
  },

  async getBySlug(slug: string): Promise<Tenant | null> {
    const row = await db('tenants').where({ slug }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  async create(data: { name: string; slug: string }): Promise<Tenant> {
    const [row] = await db('tenants')
      .insert({ name: data.name, slug: data.slug })
      .returning('*');
    return rowToTenant(row as TenantRow);
  },

  async update(id: number, data: { name?: string; slug?: string }): Promise<Tenant | null> {
    const [row] = await db('tenants')
      .where({ id })
      .update({ ...data, updated_at: db.fn.now() })
      .returning('*');
    return row ? rowToTenant(row as TenantRow) : null;
  },

  /** The tenant's agents and routers (TenantAgentSummary). */
  async agentSummary(tenantId: number): Promise<TenantAgentSummary> {
    const rows = await db('agent_devices')
      .where('tenant_id', tenantId)
      .select(
        db.raw("COALESCE(device_type, 'agent') AS type"),
        'status',
        db.raw("(pending_command = 'uninstall' OR uninstall_commanded_at IS NOT NULL) AS uninstalling"),
      ) as Array<{ type: string; status: string; uninstalling: boolean | null }>;
    const s: TenantAgentSummary = { total: 0, approved: 0, suspended: 0, uninstalling: 0, unenrolled: 0, routers: 0 };
    for (const r of rows) {
      if (r.type === 'mikrotik') { s.routers++; continue; }
      if (r.type !== 'agent') continue;
      if (r.status === 'approved') {
        s.approved++;
        if (r.uninstalling) s.uninstalling++;
      } else if (r.status === 'suspended') {
        s.suspended++;
      } else {
        s.unenrolled++;
      }
    }
    s.total = s.approved + s.suspended;
    return s;
  },

  /**
   * Queue 'uninstall' on every approved agent of the tenant (delivered live
   * by the hub, or at the agent's next connection; cleanupUninstalledDevices
   * then deletes the rows). Agents already uninstalling are left as they are.
   * Returns the ids of the agents the command was queued for.
   */
  async queueUninstallAll(tenantId: number): Promise<number[]> {
    const rows = await agentRows(db, tenantId)
      .where('status', 'approved')
      .whereNull('uninstall_commanded_at')
      .update({ pending_command: 'uninstall', updated_at: new Date() }, ['id']) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  },

  /**
   * Delete a tenant and everything it owns, in ONE transaction (C13). The
   * tenants row is locked first: an agent registration (FK to tenants) waits
   * for the outcome, so the agent count checked here is final. Under the
   * 'refuse' policy a remaining enrolled agent throws TenantHasAgentsError
   * (nothing is deleted). Returns null when the tenant does not exist, else
   * the per-table counts. Never call it for the Default tenant (the route
   * refuses it; this guards it again).
   * Runs without the statement timeout: a large tenant cascades many events.
   */
  async deleteWithData(id: number, policy: TenantDeleteAgentPolicy = tenantDeleteConfig.agentPolicy): Promise<TenantDeletionCounts | null> {
    if (id === MASTER_TENANT_ID) throw new Error('The Default tenant cannot be deleted');
    return withoutStatementTimeout(async (trx) => {
      const locked = await trx('tenants').where({ id }).forUpdate().first('id');
      if (!locked) return null;

      if (policy === 'refuse') {
        const [{ n }] = await agentRows(trx, id)
          .whereIn('status', ENROLLED_STATUSES as unknown as string[])
          .count<{ n: string | number }[]>({ n: '*' });
        if (Number(n) > 0) throw new TenantHasAgentsError(Number(n));
      }

      const groupIds = await trx('monitor_groups').where('tenant_id', id).pluck('id') as number[];
      const deviceIds = await trx('agent_devices').where('tenant_id', id).pluck('id') as number[];
      const counts: TenantDeletionCounts = {};
      const add = (table: string, n: number) => { if (n > 0) counts[table] = (counts[table] ?? 0) + n; };

      for (const table of SCOPED_TABLES) {
        const n = await trx(table)
          .where((w) => {
            w.where((x) => x.where('scope', 'tenant').where('scope_id', id));
            if (groupIds.length > 0) w.orWhere((x) => x.where('scope', 'group').whereIn('scope_id', groupIds));
            if (deviceIds.length > 0) w.orWhere((x) => x.where('scope', 'agent').whereIn('scope_id', deviceIds));
          })
          .delete();
        add(table, n);
      }
      for (const table of OWNED_TABLES) {
        add(table, await trx(table).where('tenant_id', id).delete());
      }
      add('tenants', await trx('tenants').where({ id }).delete());
      return counts;
    });
  },

  /** Returns the first tenant accessible by userId (lowest id). */
  async getFirstTenantForUser(userId: number): Promise<Tenant | null> {
    const row = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .first<TenantRow & { role: string }>('tenants.*');
    return row ? rowToTenant(row) : null;
  },

  /** The user's favourite workspace id (opened at sign-in), or null if none set. */
  async getPreferredTenant(userId: number): Promise<number | null> {
    const row = await db('users').where({ id: userId }).first<{ preferred_tenant_id: number | null } | undefined>('preferred_tenant_id');
    return row?.preferred_tenant_id ?? null;
  },

  /** Set (or clear, with null) the user's favourite workspace. The caller validates access. */
  async setPreferredTenant(userId: number, tenantId: number | null): Promise<void> {
    await db('users').where({ id: userId }).update({ preferred_tenant_id: tenantId, updated_at: db.fn.now() });
  },

  /**
   * Tenant a fresh session lands on (password login, 2FA verify, SSO callback
   * fallback, /auth/me repair):
   *   1. the user's favourite workspace, when it is still usable (platform admin:
   *      the tenant exists; anyone else: still a member);
   *   2. else the first membership (lowest id);
   *   3. else Default for platform admins — they have implicit access to every
   *      tenant and may have no user_tenants row (bootstrap admin from
   *      ensureDefaultAdmin, SSO platform admins);
   *   4. else null: a non-admin without membership must never be placed on the
   *      god-view tenant; the session tenant stays unset (no tenant access).
   * Same access predicate as middleware/tenant canUseTenant (uncached here).
   */
  async resolveLoginTenant(userId: number, role: string | null | undefined): Promise<number | null> {
    const preferred = await tenantService.getPreferredTenant(userId);
    if (preferred !== null) {
      const usable = role === 'admin' ? await tenantService.exists(preferred) : await tenantService.userHasAccess(userId, preferred);
      if (usable) return preferred;
    }
    const first = await tenantService.getFirstTenantForUser(userId);
    if (first) return first.id;
    return role === 'admin' ? MASTER_TENANT_ID : null;
  },

  /** Returns all tenants accessible by userId, with tenant-level role (permission-set slug). */
  async getTenantsForUser(userId: number): Promise<TenantWithRole[]> {
    const rows = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .select<(TenantRow & { role: string })[]>('tenants.*', 'user_tenants.role');
    return rows.map((r) => ({ ...rowToTenant(r), role: normalizeTenantRole(r.role) }));
  },

  /** Check if user has access to a specific tenant. */
  async userHasAccess(userId: number, tenantId: number): Promise<boolean> {
    const row = await db('user_tenants')
      .where({ user_id: userId, tenant_id: tenantId })
      .first('user_id');
    return !!row;
  },

  async getMembers(tenantId: number): Promise<(UserRow & { tenantRole: string })[]> {
    const rows = await db('users')
      .join('user_tenants', 'users.id', 'user_tenants.user_id')
      .where('user_tenants.tenant_id', tenantId)
      .select<(UserRow & { tenantRole: string })[]>(
        'users.id',
        'users.username',
        'users.display_name',
        'users.role',
        'users.is_active',
        'users.email',
        db.raw('user_tenants.role as "tenantRole"'),
      )
      .orderBy('users.username');
    return rows.map((r) => ({ ...r, tenantRole: normalizeTenantRole(r.tenantRole) }));
  },

  /**
   * Add (or re-role) a member. `role` is a validated permission-set slug
   * (permissionSetService.resolveRole); the legacy 'member' is stored as 'user'.
   */
  async addUser(tenantId: number, userId: number, role: TenantRole): Promise<void> {
    role = normalizeTenantRole(role);
    await db('user_tenants')
      .insert({ tenant_id: tenantId, user_id: userId, role })
      .onConflict(['user_id', 'tenant_id'])
      .merge({ role });
  },

  async removeUser(tenantId: number, userId: number): Promise<void> {
    await db('user_tenants').where({ tenant_id: tenantId, user_id: userId }).delete();
  },

  /** Change a member's role (validated slug; 'member' stored as 'user'). */
  async updateUserRole(tenantId: number, userId: number, role: TenantRole): Promise<void> {
    role = normalizeTenantRole(role);
    await db('user_tenants')
      .where({ tenant_id: tenantId, user_id: userId })
      .update({ role });
  },
};
