import { db } from '../db';
import type {
  ServiceTemplate,
  ServiceTemplateAssignment,
  ServiceTemplateMode,
  ResolvedServiceConfig,
  CreateServiceTemplateRequest,
  UpdateServiceTemplateRequest,
  UpsertServiceAssignmentRequest,
} from '@obliview/shared';

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
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

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

// ── Service ──────────────────────────────────────────────────────────────────

class ServiceTemplateService {
  /**
   * Lists all service templates visible to the caller:
   *   - Platform-wide built-in templates (tenant_id IS NULL)
   *   - Tenant-owned custom templates for this tenant
   * Admins additionally see all tenant-scoped templates.
   */
  async list(tenantId: number, isAdmin: boolean): Promise<ServiceTemplate[]> {
    const query = db<ServiceTemplateRow>('service_templates').where((builder) => {
      builder.whereNull('tenant_id');
      if (!isAdmin) {
        builder.orWhere('tenant_id', tenantId);
      } else {
        builder.orWhereNotNull('tenant_id');
      }
    });

    const rows = await query.orderBy('is_builtin', 'desc').orderBy('name', 'asc');
    return rows.map((row) => rowToTemplate(row));
  }

  /**
   * Fetches a single template by ID, including its assignments.
   * Tenant members may only access platform-wide or their own tenant's templates.
   */
  async getById(
    id: number,
    tenantId: number,
    isAdmin: boolean,
  ): Promise<ServiceTemplate | null> {
    const row = await db<ServiceTemplateRow>('service_templates').where({ id }).first();
    if (!row) return null;

    // Access control: non-admins can only see global or their tenant's templates
    if (!isAdmin && row.tenant_id !== null && row.tenant_id !== tenantId) {
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
        enabled: data.enabled ?? true,
        mode: data.mode ?? 'ban',
        tenant_id: tenantId,
        created_by: userId,
        created_at: now,
        updated_at: now,
      } as ServiceTemplateRow)
      .returning('*');

    if (!row) throw new Error('Failed to create service template');
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
    if (!existing) throw new Error('Service template not found');

    // Tenant access control: non-null tenant_id must match caller's tenant
    if (existing.tenant_id !== null && existing.tenant_id !== tenantId) {
      throw new Error('Service template not found');
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
        throw new Error('Cannot set custom regex on a built-in template');
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
    if (!existing) throw new Error('Service template not found');

    if (existing.is_builtin) {
      throw new Error('Cannot delete a built-in service template');
    }

    if (existing.tenant_id !== null && existing.tenant_id !== tenantId) {
      throw new Error('Service template not found');
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
    if (!template) throw new Error('Service template not found');

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

    if (!deleted) throw new Error('Service template assignment not found');
  }

  /**
   * Resolves the effective service configuration for a given agent,
   * walking the inheritance chain:
   *   agent assignment override > nearest group assignment override > template default
   *
   * Templates are included if they are assigned to the agent directly or to
   * any of its ancestor groups (via closure table).
   *
   * @param deviceId - The agent device ID
   * @param groupIds - Ordered array of ancestor group IDs, closest first
   */
  async resolveForAgent(
    deviceId: number,
    groupIds: number[],
  ): Promise<ResolvedServiceConfig[]> {
    // Gather all template IDs that are assigned to this agent or its groups
    // along with their assignments, indexed by templateId.

    // Structure: templateId → { agentAssignment | null, groupAssignment | null (closest wins) }
    const assignmentMap = new Map<
      number,
      {
        agentAssignment: ServiceTemplateAssignmentRow | null;
        groupAssignment: ServiceTemplateAssignmentRow | null;
      }
    >();

    // 1. Fetch agent-level assignments
    const agentAssignments = await db<ServiceTemplateAssignmentRow>(
      'service_template_assignments',
    )
      .where({ scope: 'agent', scope_id: deviceId });

    for (const asgn of agentAssignments) {
      assignmentMap.set(asgn.template_id, {
        agentAssignment: asgn,
        groupAssignment: null,
      });
    }

    // 2. Fetch group-level assignments, walking from closest ancestor to farthest
    //    Only the first (closest) group assignment wins for each template.
    if (groupIds.length > 0) {
      // Fetch all group assignments for all relevant groups in one query
      const allGroupAssignments = await db<ServiceTemplateAssignmentRow>(
        'service_template_assignments',
      )
        .where('scope', 'group')
        .whereIn('scope_id', groupIds);

      // Build a map of templateId → closest group assignment
      // groupIds is ordered closest → farthest, so we iterate in that order
      const groupAssignmentByTemplate = new Map<number, ServiceTemplateAssignmentRow>();

      for (const groupId of groupIds) {
        const forThisGroup = allGroupAssignments.filter((a) => a.scope_id === groupId);
        for (const asgn of forThisGroup) {
          if (!groupAssignmentByTemplate.has(asgn.template_id)) {
            groupAssignmentByTemplate.set(asgn.template_id, asgn);
          }
        }
      }

      // Merge into assignmentMap
      for (const [templateId, groupAsgn] of groupAssignmentByTemplate.entries()) {
        const existing = assignmentMap.get(templateId);
        if (existing) {
          existing.groupAssignment = groupAsgn;
        } else {
          assignmentMap.set(templateId, {
            agentAssignment: null,
            groupAssignment: groupAsgn,
          });
        }
      }
    }

    if (assignmentMap.size === 0) return [];

    // 3. Fetch all referenced templates
    const templateIds = [...assignmentMap.keys()];
    const templates = await db<ServiceTemplateRow>('service_templates')
      .whereIn('id', templateIds);

    const templateById = new Map<number, ServiceTemplateRow>();
    for (const tpl of templates) {
      templateById.set(tpl.id, tpl);
    }

    // 4. Build resolved configs
    const resolved: ResolvedServiceConfig[] = [];

    for (const [templateId, { agentAssignment, groupAssignment }] of assignmentMap.entries()) {
      const tpl = templateById.get(templateId);
      if (!tpl) continue; // Template was deleted; skip

      // Priority: agent override > nearest group override > template default
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

      const enabled =
        agentAssignment?.enabled_override ??
        groupAssignment?.enabled_override ??
        tpl.enabled;

      // sampleRequested is agent-level only (group assignments don't trigger samples for specific agents)
      const sampleRequested = agentAssignment?.sample_requested ?? false;

      resolved.push({
        templateId,
        name: tpl.name,
        serviceType: tpl.service_type as ResolvedServiceConfig['serviceType'],
        isBuiltin: tpl.is_builtin,
        logPath,
        customRegex: tpl.custom_regex,
        threshold,
        windowSeconds,
        enabled,
        mode: (tpl.mode ?? 'ban') as ServiceTemplateMode,
        sampleRequested,
      });
    }

    return resolved;
  }

  /**
   * Public API: resolves templates for a device by ID.
   * Loads the device's group ancestry from the DB, then delegates to resolveForAgent.
   */
  async getResolvedForDevice(deviceId: number): Promise<ResolvedServiceConfig[]> {
    // Walk group_closure to get ancestor group IDs (closest first)
    const groupRows = await db('group_closure as gc')
      .join('agent_devices as d', 'd.group_id', 'gc.descendant_id')
      .where('d.id', deviceId)
      .select('gc.ancestor_id')
      .orderBy('gc.depth', 'asc') as { ancestor_id: number }[];

    const groupIds = groupRows.map(r => r.ancestor_id);
    return this.resolveForAgent(deviceId, groupIds);
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
    if (!template) throw new Error('Service template not found');

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
