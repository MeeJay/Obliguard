import { db } from '../db';
import { codedError } from '../utils/errorCodes';
import { readTenantsFor } from '../middleware/tenant';
import type {
  ServiceTemplate,
  ServiceTemplateAssignment,
  ServiceTemplateMode,
  ResolvedServiceConfig,
  CreateServiceTemplateRequest,
  UpdateServiceTemplateRequest,
  UpsertServiceAssignmentRequest,
} from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';

// ── Row interfaces ───────────────────────────────────────────────────────────

interface ServiceTemplateRow {
  id: number;
  name: string;
  service_type: string;
  is_builtin: boolean;
  default_log_path: string | null;
  custom_regex: string | null;
  threshold: number;
  window_seconds: number;
  enabled: boolean;
  mode: string;
  tenant_id: number | null;
  owner_scope: string | null;
  owner_scope_id: number | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  /** Joined from tenants (list queries only). */
  tenant_name?: string | null;
}

/** A listed template with its owning tenant's name (W10-5; null tenant = platform template). */
export type ServiceTemplateListItem = ServiceTemplate & { tenantName: string | null };

interface ServiceTemplateAssignmentRow {
  id: number;
  template_id: number;
  scope: string;
  scope_id: number;
  log_path_override: string | null;
  threshold_override: number | null;
  window_seconds_override: number | null;
  enabled_override: boolean | null;
  sample_requested: boolean;
  created_at: Date;
}

// ── Row → Model ──────────────────────────────────────────────────────────────

function rowToTemplate(
  row: ServiceTemplateRow,
  assignments?: ServiceTemplateAssignment[],
): ServiceTemplate {
  const tpl: ServiceTemplate = {
    id: row.id,
    name: row.name,
    serviceType: row.service_type as ServiceTemplate['serviceType'],
    isBuiltin: row.is_builtin,
    defaultLogPath: row.default_log_path,
    customRegex: row.custom_regex,
    threshold: row.threshold,
    windowSeconds: row.window_seconds,
    enabled: row.enabled,
    mode: (row.mode ?? 'ban') as ServiceTemplateMode,
    tenantId: row.tenant_id,
    ownerScope: (row.owner_scope as 'agent' | 'group' | null) ?? null,
    ownerScopeId: row.owner_scope_id ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  if (assignments !== undefined) {
    tpl.assignments = assignments;
  }
  return tpl;
}

function rowToAssignment(row: ServiceTemplateAssignmentRow): ServiceTemplateAssignment {
  return {
    id: row.id,
    templateId: row.template_id,
    scope: row.scope as 'group' | 'agent',
    scopeId: row.scope_id,
    logPathOverride: row.log_path_override,
    thresholdOverride: row.threshold_override,
    windowSecondsOverride: row.window_seconds_override,
    enabledOverride: row.enabled_override,
    sampleRequested: row.sample_requested,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * One resolved entry of an agent: agent assignment override > nearest group
 * assignment override > template default. Group-owned templates get no group
 * assignment (they belong TO the group).
 */
function buildResolvedEntry(
  tpl: ServiceTemplateRow,
  agentAssignment: ServiceTemplateAssignmentRow | null,
  groupAssignment: ServiceTemplateAssignmentRow | null,
  templateOwnerScope: 'group' | null,
): ResolvedServiceConfig {
  const logPath =
    agentAssignment?.log_path_override ??
    groupAssignment?.log_path_override ??
    tpl.default_log_path;

  const threshold =
    agentAssignment?.threshold_override ??
    groupAssignment?.threshold_override ??
    tpl.threshold;

  const windowSeconds =
    agentAssignment?.window_seconds_override ??
    groupAssignment?.window_seconds_override ??
    tpl.window_seconds;

  const enabledOverrideScope: ResolvedServiceConfig['enabledOverrideScope'] =
    agentAssignment?.enabled_override !== null && agentAssignment?.enabled_override !== undefined
      ? 'agent'
      : groupAssignment?.enabled_override !== null && groupAssignment?.enabled_override !== undefined
        ? 'group'
        : null;

  const enabled =
    agentAssignment?.enabled_override ??
    groupAssignment?.enabled_override ??
    tpl.enabled;

  const thresholdOverrideScope: ResolvedServiceConfig['thresholdOverrideScope'] =
    agentAssignment?.threshold_override !== null && agentAssignment?.threshold_override !== undefined
      ? 'agent'
      : groupAssignment?.threshold_override !== null && groupAssignment?.threshold_override !== undefined
        ? 'group'
        : null;

  const thresholdOverride =
    agentAssignment?.threshold_override !== undefined ? agentAssignment.threshold_override :
    groupAssignment?.threshold_override !== undefined ? groupAssignment.threshold_override :
    null;

  const windowSecondsOverride =
    agentAssignment?.window_seconds_override !== undefined ? agentAssignment.window_seconds_override :
    groupAssignment?.window_seconds_override !== undefined ? groupAssignment.window_seconds_override :
    null;

  return {
    templateId: tpl.id,
    name: tpl.name,
    serviceType: tpl.service_type as ResolvedServiceConfig['serviceType'],
    isBuiltin: tpl.is_builtin,
    logPath,
    customRegex: tpl.custom_regex,
    threshold,
    windowSeconds,
    enabled,
    mode: (tpl.mode ?? 'ban') as ServiceTemplateMode,
    sampleRequested: agentAssignment?.sample_requested ?? false,
    enabledOverrideScope,
    templateOwnerScope,
    thresholdOverrideScope,
    thresholdOverride,
    windowSecondsOverride,
  };
}

/** Sort of a resolved list: enabled first, then by name. */
function sortResolved(resolved: ResolvedServiceConfig[]): ResolvedServiceConfig[] {
  return resolved.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** An agent to resolve: its id and its ancestor group ids, closest first. */
export interface AgentTemplateScope {
  deviceId: number;
  groupIds: number[];
}

// ── Service ──────────────────────────────────────────────────────────────────

class ServiceTemplateService {
  /**
   * Lists all service templates visible to the caller:
   *   - Platform-wide built-in templates (tenant_id IS NULL)
   *   - Tenant-owned custom templates of the read tenants (readTenantsFor,
   *     W10-5): every tenant from Default (narrowed by `tenantIds`, the
   *     tenant chips), the operating tenant alone anywhere else - the
   *     platform role grants nothing extra
   *   - Excludes local templates (owner_scope IS NOT NULL) — use listLocal() for those
   * Rows carry tenantId + tenantName (null = platform template).
   */
  async list(tenantId: number, _isAdmin?: boolean, tenantIds?: number[]): Promise<ServiceTemplateListItem[]> {
    const tenants = readTenantsFor(tenantId, tenantIds);
    const query = db<ServiceTemplateRow>('service_templates as st')
      .leftJoin('tenants as tt', 'tt.id', 'st.tenant_id')
      .whereNull('st.owner_scope')  // exclude local templates
      .where((builder) => {
        builder.whereNull('st.tenant_id');
        if (tenants === 'all') builder.orWhereNotNull('st.tenant_id');
        else if (tenants.length > 0) builder.orWhereIn('st.tenant_id', tenants);
      })
      .select('st.*', 'tt.name as tenant_name');

    const rows = await query.orderBy('st.is_builtin', 'desc').orderBy('st.name', 'asc').orderBy('st.id', 'asc') as ServiceTemplateRow[];
    return rows.map((row) => ({ ...rowToTemplate(row), tenantName: row.tenant_name ?? null }));
  }

  /**
   * Lists local templates for a specific agent or group.
   * Local templates are only visible on the owning entity's detail page.
   */
  async listLocal(scope: 'agent' | 'group', scopeId: number): Promise<ServiceTemplate[]> {
    const rows = await db<ServiceTemplateRow>('service_templates')
      .where('owner_scope', scope)
      .where('owner_scope_id', scopeId)
      .orderBy('name', 'asc');
    return rows.map((row) => rowToTemplate(row));
  }

  /**
   * Fetches a single template by ID, including its assignments.
   * Outside Default, only platform-wide or the operating tenant's own
   * templates are readable, whatever the platform role (W10-5).
   */
  async getById(
    id: number,
    tenantId: number,
    _isAdmin?: boolean,
  ): Promise<ServiceTemplate | null> {
    const row = await db<ServiceTemplateRow>('service_templates').where({ id }).first();
    if (!row) return null;

    // Access control: platform templates, or the operating tenant's own (all from Default).
    if (!isMasterTenant(tenantId) && row.tenant_id !== null && Number(row.tenant_id) !== Number(tenantId)) {
      return null;
    }

    const assignmentRows = await db<ServiceTemplateAssignmentRow>(
      'service_template_assignments',
    )
      .where({ template_id: id })
      .orderBy('scope', 'asc')
      .orderBy('scope_id', 'asc');

    const assignments = assignmentRows.map(rowToAssignment);
    return rowToTemplate(row, assignments);
  }

  /**
   * Creates a new custom service template scoped to the caller's tenant.
   * Only admins may create platform-wide templates (tenant_id = null).
   */
  async create(
    data: CreateServiceTemplateRequest,
    userId: number,
    tenantId: number,
  ): Promise<ServiceTemplate> {
    const now = new Date();

    const [row] = await db<ServiceTemplateRow>('service_templates')
      .insert({
        name: data.name,
        service_type: data.serviceType,
        is_builtin: false,
        default_log_path: data.defaultLogPath ?? null,
        custom_regex: data.customRegex ?? null,
        threshold: data.threshold ?? 5,
        window_seconds: data.windowSeconds ?? 300,
        enabled: data.enabled ?? false,
        mode: data.mode ?? 'ban',
        tenant_id: tenantId,
        owner_scope: data.ownerScope ?? null,
        owner_scope_id: data.ownerScopeId ?? null,
        created_by: userId,
        created_at: now,
        updated_at: now,
      } as ServiceTemplateRow)
      .returning('*');

    if (!row) throw new Error('Failed to create service template');

    // Auto-assign local templates to their owner immediately
    if (data.ownerScope && data.ownerScopeId != null) {
      await db('service_template_assignments').insert({
        template_id: row.id,
        scope: data.ownerScope,
        scope_id: data.ownerScopeId,
        log_path_override: null,
        threshold_override: null,
        window_seconds_override: null,
        enabled_override: null,
        sample_requested: false,
        created_at: now,
      }).onConflict(['template_id', 'scope', 'scope_id']).ignore();
    }

    return rowToTemplate(row, []);
  }

  /**
   * Updates a service template.
   * Built-in templates may have some fields updated (e.g. enabled, threshold),
   * but custom_regex cannot be set on built-ins.
   */
  async update(
    id: number,
    data: UpdateServiceTemplateRequest,
    tenantId: number,
  ): Promise<ServiceTemplate> {
    const existing = await db<ServiceTemplateRow>('service_templates').where({ id }).first();
    if (!existing) throw codedError(404, 'SERVICE_TEMPLATE_NOT_FOUND', 'Service template not found');

    // Tenant access control: non-null tenant_id must match caller's tenant
    if (existing.tenant_id !== null && existing.tenant_id !== tenantId) {
      throw codedError(404, 'SERVICE_TEMPLATE_NOT_FOUND', 'Service template not found');
    }

    const updates: Partial<ServiceTemplateRow> = {
      updated_at: new Date(),
    };

    if (data.name !== undefined) updates.name = data.name;
    if (data.defaultLogPath !== undefined) updates.default_log_path = data.defaultLogPath;
    if (data.threshold !== undefined) updates.threshold = data.threshold;
    if (data.windowSeconds !== undefined) updates.window_seconds = data.windowSeconds;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.mode !== undefined) updates.mode = data.mode;

    // customRegex only allowed on non-builtin templates
    if (data.customRegex !== undefined) {
      if (existing.is_builtin) {
        throw codedError(400, 'SERVICE_TEMPLATE_BUILTIN_REGEX', 'Cannot set custom regex on a built-in template');
      }
      updates.custom_regex = data.customRegex;
    }

    const [updated] = await db<ServiceTemplateRow>('service_templates')
      .where({ id })
      .update(updates)
      .returning('*');

    if (!updated) throw new Error('Failed to update service template');
    return rowToTemplate(updated);
  }

  /**
   * Deletes a service template.
   * Built-in templates cannot be deleted.
   */
  async delete(id: number, tenantId: number): Promise<void> {
    const existing = await db<ServiceTemplateRow>('service_templates').where({ id }).first();
    if (!existing) throw codedError(404, 'SERVICE_TEMPLATE_NOT_FOUND', 'Service template not found');

    if (existing.is_builtin) {
      throw codedError(400, 'SERVICE_TEMPLATE_BUILTIN_DELETE', 'Cannot delete a built-in service template');
    }

    if (existing.tenant_id !== null && existing.tenant_id !== tenantId) {
      throw codedError(404, 'SERVICE_TEMPLATE_NOT_FOUND', 'Service template not found');
    }

    // Remove assignments first (FK constraint)
    await db('service_template_assignments').where({ template_id: id }).del();
    await db('service_templates').where({ id }).del();
  }

  /**
   * Creates or updates an assignment linking a template to a group or agent.
   * The assignment carries optional override values for log path, threshold,
   * window seconds, and enabled state.
   */
  async upsertAssignment(
    templateId: number,
    scope: 'group' | 'agent',
    scopeId: number,
    data: UpsertServiceAssignmentRequest,
  ): Promise<ServiceTemplateAssignment> {
    const template = await db<ServiceTemplateRow>('service_templates')
      .where({ id: templateId })
      .first();
    if (!template) throw codedError(404, 'SERVICE_TEMPLATE_NOT_FOUND', 'Service template not found');

    const existing = await db<ServiceTemplateAssignmentRow>('service_template_assignments')
      .where({ template_id: templateId, scope, scope_id: scopeId })
      .first();

    if (existing) {
      const updates: Partial<ServiceTemplateAssignmentRow> = {};
      if (data.logPathOverride !== undefined) updates.log_path_override = data.logPathOverride;
      if (data.thresholdOverride !== undefined) updates.threshold_override = data.thresholdOverride;
      if (data.windowSecondsOverride !== undefined) updates.window_seconds_override = data.windowSecondsOverride;
      if (data.enabledOverride !== undefined) updates.enabled_override = data.enabledOverride;
      if (data.sampleRequested !== undefined) updates.sample_requested = data.sampleRequested;

      const [updated] = await db<ServiceTemplateAssignmentRow>('service_template_assignments')
        .where({ id: existing.id })
        .update(updates)
        .returning('*');

      if (!updated) throw new Error('Failed to update service template assignment');
      return rowToAssignment(updated);
    }

    const now = new Date();
    const [created] = await db<ServiceTemplateAssignmentRow>('service_template_assignments')
      .insert({
        template_id: templateId,
        scope,
        scope_id: scopeId,
        log_path_override: data.logPathOverride ?? null,
        threshold_override: data.thresholdOverride ?? null,
        window_seconds_override: data.windowSecondsOverride ?? null,
        enabled_override: data.enabledOverride ?? null,
        sample_requested: data.sampleRequested ?? false,
        created_at: now,
      } as ServiceTemplateAssignmentRow)
      .returning('*');

    if (!created) throw new Error('Failed to create service template assignment');
    return rowToAssignment(created);
  }

  /**
   * Deletes a specific assignment by template + scope + scopeId.
   */
  async deleteAssignment(
    templateId: number,
    scope: string,
    scopeId: number,
  ): Promise<void> {
    const deleted = await db('service_template_assignments')
      .where({ template_id: templateId, scope, scope_id: scopeId })
      .del();

    if (!deleted) throw codedError(404, 'SERVICE_TEMPLATE_ASSIGNMENT_NOT_FOUND', 'Service template assignment not found');
  }

  /**
   * Resolves the effective service configuration for a given agent,
   * walking the inheritance chain:
   *   agent assignment override > nearest group assignment override > template default
   *
   * ALL global templates (owner_scope IS NULL) are included by default (opt-out model).
   * An assignment with enabled_override=false at group or agent level acts as an "unbind".
   *
   * @param deviceId - The agent device ID
   * @param groupIds - Ordered array of ancestor group IDs, closest first
   */
  async resolveForAgent(
    deviceId: number,
    groupIds: number[],
  ): Promise<ResolvedServiceConfig[]> {
    const resolved = await this.resolveForAgents([{ deviceId, groupIds }]);
    return resolved.get(deviceId) ?? [];
  }

  /**
   * resolveForAgent for many agents at once (ban engine cycle, W11-3): at
   * most four queries whatever the number of agents (global templates,
   * group-owned templates of every direct group, agent assignments, group
   * assignments of every ancestor group). Each agent gets exactly what
   * resolveForAgent returns for it; every agent of `agents` has an entry.
   */
  async resolveForAgents(
    agents: ReadonlyArray<AgentTemplateScope>,
  ): Promise<Map<number, ResolvedServiceConfig[]>> {
    const out = new Map<number, ResolvedServiceConfig[]>();
    if (agents.length === 0) return out;

    // 1. ALL global templates (opt-out — every global template applies by default)
    const globalTemplates = await db<ServiceTemplateRow>('service_templates')
      .whereNull('owner_scope')
      .orderBy('id');

    // 2. Group-owned templates of each agent's direct group (groupIds[0] = depth-0 = self)
    const directGroupIds = [...new Set(
      agents.map((a) => (a.groupIds.length > 0 ? a.groupIds[0] : null)).filter((g): g is number => g !== null),
    )];
    const groupOwnedTemplates: ServiceTemplateRow[] = directGroupIds.length > 0
      ? await db<ServiceTemplateRow>('service_templates')
          .where('owner_scope', 'group')
          .whereRaw('owner_scope_id = ANY(?::int[])', [directGroupIds])
          .orderBy('id')
      : [];
    const ownedByGroup = new Map<number, ServiceTemplateRow[]>();
    for (const tpl of groupOwnedTemplates) {
      const gid = Number(tpl.owner_scope_id);
      const list = ownedByGroup.get(gid);
      if (list) list.push(tpl); else ownedByGroup.set(gid, [tpl]);
    }

    if (globalTemplates.length === 0 && groupOwnedTemplates.length === 0) {
      for (const a of agents) out.set(a.deviceId, []);
      return out;
    }

    const allTemplateIds = [...globalTemplates, ...groupOwnedTemplates].map(t => t.id);
    const globalTemplateIds = globalTemplates.map(t => t.id);

    // 3. Agent-level assignments of every agent, in one query
    const deviceIds = [...new Set(agents.map((a) => a.deviceId))];
    const agentAssignments = await db<ServiceTemplateAssignmentRow>('service_template_assignments')
      .where('scope', 'agent')
      .whereRaw('scope_id = ANY(?::int[])', [deviceIds])
      .whereRaw('template_id = ANY(?::int[])', [allTemplateIds])
      .orderBy('id');
    const agentAssignmentByKey = new Map<string, ServiceTemplateAssignmentRow>();
    for (const asgn of agentAssignments) {
      agentAssignmentByKey.set(`${asgn.scope_id}:${asgn.template_id}`, asgn);
    }

    // 4. Group-level assignments of GLOBAL templates for every ancestor group
    const ancestorIds = [...new Set(agents.flatMap((a) => a.groupIds))];
    const groupAssignmentsByGroup = new Map<number, ServiceTemplateAssignmentRow[]>();
    if (ancestorIds.length > 0 && globalTemplateIds.length > 0) {
      const allGroupAssignments = await db<ServiceTemplateAssignmentRow>('service_template_assignments')
        .where('scope', 'group')
        .whereRaw('scope_id = ANY(?::int[])', [ancestorIds])
        .whereRaw('template_id = ANY(?::int[])', [globalTemplateIds])
        .orderBy('id');
      for (const asgn of allGroupAssignments) {
        const list = groupAssignmentsByGroup.get(asgn.scope_id);
        if (list) list.push(asgn); else groupAssignmentsByGroup.set(asgn.scope_id, [asgn]);
      }
    }

    for (const { deviceId, groupIds } of agents) {
      // Nearest group assignment per template (walk closest → farthest)
      const groupAssignmentByTemplate = new Map<number, ServiceTemplateAssignmentRow>();
      for (const groupId of groupIds) {
        for (const asgn of groupAssignmentsByGroup.get(groupId) ?? []) {
          if (!groupAssignmentByTemplate.has(asgn.template_id)) {
            groupAssignmentByTemplate.set(asgn.template_id, asgn);
          }
        }
      }
      const agentAssignment = (tplId: number) => agentAssignmentByKey.get(`${deviceId}:${tplId}`) ?? null;

      const resolved: ResolvedServiceConfig[] = [];
      // 5. Global templates — agent + group overrides
      for (const tpl of globalTemplates) {
        resolved.push(buildResolvedEntry(tpl, agentAssignment(tpl.id), groupAssignmentByTemplate.get(tpl.id) ?? null, null));
      }
      // 6. Group-owned templates — agent override only (no group-level bind/unbind)
      const directGroupId = groupIds.length > 0 ? groupIds[0] : null;
      for (const tpl of directGroupId !== null ? ownedByGroup.get(directGroupId) ?? [] : []) {
        resolved.push(buildResolvedEntry(tpl, agentAssignment(tpl.id), null, 'group'));
      }
      out.set(deviceId, sortResolved(resolved));
    }
    return out;
  }

  /**
   * Public API: resolves templates for a device by ID.
   * Loads the device's group ancestry from the DB, then delegates to resolveForAgent.
   */
  async getResolvedForDevice(deviceId: number): Promise<ResolvedServiceConfig[]> {
    const groupRows = await db('group_closure as gc')
      .join('agent_devices as d', 'd.group_id', 'gc.descendant_id')
      .where('d.id', deviceId)
      .select('gc.ancestor_id')
      .orderBy('gc.depth', 'asc') as { ancestor_id: number }[];

    const groupIds = groupRows.map(r => r.ancestor_id);
    return this.resolveForAgent(deviceId, groupIds);
  }

  /**
   * Resolves template statuses for a group (not a specific agent).
   * Returns ALL global templates with the effective enabled state at this group level
   * (considering ancestor group overrides, but NOT agent-level overrides).
   *
   * enabledOverrideScope will be:
   *  'group'  — this group or an ancestor group has enabled_override set
   *  null     — no group override, using template default
   */
  async getResolvedForGroup(groupId: number): Promise<ResolvedServiceConfig[]> {
    // Get ancestor group IDs for this group (closest first, including self at depth=0)
    const ancestorRows = await db('group_closure')
      .where('descendant_id', groupId)
      .select('ancestor_id')
      .orderBy('depth', 'asc') as { ancestor_id: number }[];

    const groupIds = ancestorRows.map(r => r.ancestor_id);

    // Fetch all global templates
    const globalTemplates = await db<ServiceTemplateRow>('service_templates')
      .whereNull('owner_scope');

    if (globalTemplates.length === 0) return [];

    const templateIds = globalTemplates.map(t => t.id);

    // Fetch group-level assignments for these groups
    const groupAssignmentByTemplate = new Map<number, ServiceTemplateAssignmentRow>();
    if (groupIds.length > 0) {
      const allGroupAssignments = await db<ServiceTemplateAssignmentRow>('service_template_assignments')
        .where('scope', 'group')
        .whereIn('scope_id', groupIds)
        .whereIn('template_id', templateIds);

      for (const gid of groupIds) {
        for (const asgn of allGroupAssignments.filter(a => a.scope_id === gid)) {
          if (!groupAssignmentByTemplate.has(asgn.template_id)) {
            groupAssignmentByTemplate.set(asgn.template_id, asgn);
          }
        }
      }
    }

    const resolved: ResolvedServiceConfig[] = [];

    for (const tpl of globalTemplates) {
      const groupAssignment = groupAssignmentByTemplate.get(tpl.id) ?? null;

      const enabledOverrideScope: ResolvedServiceConfig['enabledOverrideScope'] =
        groupAssignment?.enabled_override !== null && groupAssignment?.enabled_override !== undefined
          ? 'group'
          : null;

      const enabled = groupAssignment?.enabled_override ?? tpl.enabled;

      const groupThresholdOverride = groupAssignment?.threshold_override ?? null;
      const groupWindowOverride    = groupAssignment?.window_seconds_override ?? null;

      resolved.push({
        templateId: tpl.id,
        name: tpl.name,
        serviceType: tpl.service_type as ResolvedServiceConfig['serviceType'],
        isBuiltin: tpl.is_builtin,
        logPath: groupAssignment?.log_path_override ?? tpl.default_log_path,
        customRegex: tpl.custom_regex,
        threshold: groupThresholdOverride ?? tpl.threshold,
        windowSeconds: groupWindowOverride ?? tpl.window_seconds,
        enabled,
        mode: (tpl.mode ?? 'ban') as ServiceTemplateMode,
        sampleRequested: false,
        enabledOverrideScope,
        templateOwnerScope: null,
        thresholdOverrideScope: groupThresholdOverride !== null ? 'group' : null,
        thresholdOverride: groupThresholdOverride,
        windowSecondsOverride: groupWindowOverride,
      });
    }

    resolved.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return resolved;
  }

  /**
   * Requests a log sample from the agent on the next push cycle.
   * Sets sample_requested = true on the agent-level assignment for this device.
   * If no agent-level assignment exists, one is created.
   */
  async requestLogSample(templateId: number, deviceId: number): Promise<void> {
    const template = await db<ServiceTemplateRow>('service_templates')
      .where({ id: templateId })
      .first();
    if (!template) throw codedError(404, 'SERVICE_TEMPLATE_NOT_FOUND', 'Service template not found');

    const existing = await db<ServiceTemplateAssignmentRow>('service_template_assignments')
      .where({ template_id: templateId, scope: 'agent', scope_id: deviceId })
      .first();

    if (existing) {
      await db('service_template_assignments')
        .where({ id: existing.id })
        .update({ sample_requested: true });
    } else {
      // Create a minimal agent assignment with only sample_requested = true
      const now = new Date();
      await db('service_template_assignments').insert({
        template_id: templateId,
        scope: 'agent',
        scope_id: deviceId,
        log_path_override: null,
        threshold_override: null,
        window_seconds_override: null,
        enabled_override: null,
        sample_requested: true,
        created_at: now,
      });
    }
  }
}

export const serviceTemplateService = new ServiceTemplateService();
