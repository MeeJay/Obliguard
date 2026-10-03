import type { Request, Response, NextFunction } from 'express';
import type { CreateServiceTemplateRequest } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { serviceTemplateService } from '../services/serviceTemplate.service';
import { AppError } from '../middleware/errorHandler';
import { parseTenantIds } from '../middleware/tenant';
import { assertScopeInTenant, filterOwnedScopeItems } from '../services/tenantScope.service';
import { resolveRequestAgent } from '../services/agentScope.service';
import type { AgentNeed } from '../services/agentScope.service';
import { auditService } from '../services/audit.service';
import { db } from '../db';

/** Name + owner of a template for the audit trail (null when gone). */
async function templateAuditInfo(id: number): Promise<{ name: string | null; ownerScope: string | null; ownerScopeId: number | null }> {
  const row = await db('service_templates').where({ id }).first('name', 'owner_scope', 'owner_scope_id') as
    { name: string; owner_scope: string | null; owner_scope_id: number | null } | undefined;
  return { name: row?.name ?? null, ownerScope: row?.owner_scope ?? null, ownerScopeId: row?.owner_scope_id ?? null };
}

export interface UpsertServiceAssignmentRequest {
  logPathOverride?: string | null;
  thresholdOverride?: number | null;
  windowSecondsOverride?: number | null;
  enabledOverride?: boolean | null;
}

/**
 * Assignments and local templates target a group or an agent: the target must
 * belong to the operating tenant (W1-2; Default may read but not write another
 * tenant's scope), and the template must be visible to that tenant.
 */
async function assertAssignable(req: Request, templateId: number, scope: 'group' | 'agent', scopeId: number): Promise<void> {
  const tenantId = req.tenantId;
  await assertScopeInTenant(scope, scopeId, tenantId, 'write');
  await assertAgentTeamAccess(req, scope, scopeId, 'write');
  if (!(await serviceTemplateService.getById(templateId, tenantId, false))) {
    throw new AppError(404, 'Service template not found');
  }
}

/**
 * An agent target also follows the caller's team grants (RBAC-8): an agent the
 * user is not granted answers 404, a read-only one 403 on a write.
 */
async function assertAgentTeamAccess(req: Request, scope: 'group' | 'agent', scopeId: unknown, need: AgentNeed): Promise<void> {
  if (scope !== 'agent') return;
  const r = await resolveRequestAgent(req, scopeId, need);
  if (!r.ok) throw new AppError(r.status, r.error);
}

/**
 * Template writes (templates.write, route). A platform template (tenant_id
 * NULL, built-ins included) is shared by every tenant: only a platform admin
 * or the Default tenant may change or delete it. A tenant template is bound to
 * its tenant (404 elsewhere, here and in the service).
 */
async function assertTemplateWritable(id: number, req: Request): Promise<void> {
  const template = await serviceTemplateService.getById(id, req.tenantId, false);
  if (!template) throw new AppError(404, 'Service template not found');
  if (template.tenantId === null && req.session?.role !== 'admin' && !isMasterTenant(req.tenantId)) {
    throw new AppError(403, 'Platform templates can only be changed from the Default tenant');
  }
}

export async function listTemplates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const isAdmin = req.session?.role === 'admin';
    // God view tenant chips (Default only; ignored elsewhere by readTenantsFor).
    const templates = await serviceTemplateService.list(req.tenantId, isAdmin, parseTenantIds(req.query.tenants));
    res.json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
}

export async function getTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError(400, 'Invalid template ID');
    }

    const isAdmin = req.session?.role === 'admin';
    const template = await serviceTemplateService.getById(id, req.tenantId, isAdmin);
    if (!template) {
      throw new AppError(404, 'Service template not found');
    }
    // Platform templates are shared: only list assignments on the operating
    // tenant's own groups/agents (W1-2; Default keeps the god view).
    if (template.assignments) {
      template.assignments = await filterOwnedScopeItems(template.assignments, req.tenantId);
    }

    res.json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
}

export async function createTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as CreateServiceTemplateRequest;

    if (!body.name?.trim()) {
      throw new AppError(400, 'name is required');
    }
    if (!body.serviceType?.trim()) {
      throw new AppError(400, 'serviceType is required');
    }

    // A local template is owned by a group/agent of the operating tenant.
    if (body.ownerScope != null || body.ownerScopeId != null) {
      if (body.ownerScope !== 'group' && body.ownerScope !== 'agent') {
        throw new AppError(400, 'ownerScope must be "group" or "agent"');
      }
      await assertScopeInTenant(body.ownerScope, body.ownerScopeId, req.tenantId, 'write');
      await assertAgentTeamAccess(req, body.ownerScope, body.ownerScopeId, 'write');
    }

    const template = await serviceTemplateService.create(body, req.session?.userId ?? 0, req.tenantId);
    await auditService.logReq(req, {
      action: 'service_template.created', targetType: 'service_template', targetId: template.id,
      deviceId: body.ownerScope === 'agent' ? body.ownerScopeId ?? null : null,
      details: { name: template.name, serviceType: body.serviceType, ownerScope: body.ownerScope ?? null, ownerScopeId: body.ownerScopeId ?? null },
    });

    res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
}

export async function updateTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError(400, 'Invalid template ID');
    }

    await assertTemplateWritable(id, req);
    const template = await serviceTemplateService.update(id, req.body, req.tenantId);
    if (!template) {
      throw new AppError(404, 'Service template not found');
    }
    const info = await templateAuditInfo(id);
    await auditService.logReq(req, {
      action: 'service_template.updated', targetType: 'service_template', targetId: id,
      deviceId: info.ownerScope === 'agent' ? info.ownerScopeId : null,
      details: { name: template.name, fields: Object.keys((req.body ?? {}) as object) },
    });

    res.json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
}

export async function deleteTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError(400, 'Invalid template ID');
    }

    await assertTemplateWritable(id, req);
    const info = await templateAuditInfo(id);
    await serviceTemplateService.delete(id, req.tenantId);
    await auditService.logReq(req, {
      action: 'service_template.deleted', targetType: 'service_template', targetId: id,
      deviceId: info.ownerScope === 'agent' ? info.ownerScopeId : null,
      details: { name: info.name, ownerScope: info.ownerScope, ownerScopeId: info.ownerScopeId },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function upsertAssignment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError(400, 'Invalid template ID');
    }

    const { scope, scopeId: scopeIdParam } = req.params;
    if (scope !== 'group' && scope !== 'agent') {
      throw new AppError(400, 'scope must be "group" or "agent"');
    }

    const scopeId = parseInt(scopeIdParam, 10);
    if (isNaN(scopeId)) {
      throw new AppError(400, 'Invalid scopeId');
    }

    await assertAssignable(req, id, scope, scopeId);

    const body = (req.body ?? {}) as UpsertServiceAssignmentRequest;

    const assignment = await serviceTemplateService.upsertAssignment(id, scope, scopeId, body);
    await auditService.logReq(req, {
      action: 'service_template.assignment_set', targetType: 'service_template', targetId: id,
      deviceId: scope === 'agent' ? scopeId : null,
      details: {
        name: (await templateAuditInfo(id)).name, scope, scopeId,
        logPathOverride: body.logPathOverride, thresholdOverride: body.thresholdOverride,
        windowSecondsOverride: body.windowSecondsOverride, enabledOverride: body.enabledOverride,
      },
    });
    res.json({ success: true, data: assignment });
  } catch (err) {
    next(err);
  }
}

export async function deleteAssignment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError(400, 'Invalid template ID');
    }

    const { scope, scopeId: scopeIdParam } = req.params;
    if (scope !== 'group' && scope !== 'agent') {
      throw new AppError(400, 'scope must be "group" or "agent"');
    }

    const scopeId = parseInt(scopeIdParam, 10);
    if (isNaN(scopeId)) {
      throw new AppError(400, 'Invalid scopeId');
    }

    await assertAssignable(req, id, scope, scopeId);

    await serviceTemplateService.deleteAssignment(id, scope, scopeId);
    await auditService.logReq(req, {
      action: 'service_template.assignment_removed', targetType: 'service_template', targetId: id,
      deviceId: scope === 'agent' ? scopeId : null,
      details: { name: (await templateAuditInfo(id)).name, scope, scopeId },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function requestSample(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const templateId = parseInt(req.params.id, 10);
    if (isNaN(templateId)) {
      throw new AppError(400, 'Invalid template ID');
    }

    const deviceId = parseInt(req.params.deviceId, 10);
    if (isNaN(deviceId)) {
      throw new AppError(400, 'Invalid device ID');
    }

    await assertAssignable(req, templateId, 'agent', deviceId);

    await serviceTemplateService.requestLogSample(templateId, deviceId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /service-templates/resolved/group/:groupId
 * Returns all global templates with their effective enabled status for a specific group,
 * considering group-level assignments from this group and its ancestors.
 */
export async function getResolvedForGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    if (isNaN(groupId)) {
      throw new AppError(400, 'Invalid groupId');
    }
    await assertScopeInTenant('group', groupId, req.tenantId, 'read');
    const configs = await serviceTemplateService.getResolvedForGroup(groupId);
    res.json({ success: true, data: configs });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /service-templates/local/:scope/:scopeId
 * Lists local templates that belong to a specific agent or group.
 */
export async function listLocalTemplates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { scope, scopeId: scopeIdParam } = req.params;
    if (scope !== 'agent' && scope !== 'group') {
      throw new AppError(400, 'scope must be "agent" or "group"');
    }
    const scopeId = parseInt(scopeIdParam, 10);
    if (isNaN(scopeId)) {
      throw new AppError(400, 'Invalid scopeId');
    }
    await assertScopeInTenant(scope, scopeId, req.tenantId, 'read');
    await assertAgentTeamAccess(req, scope, scopeId, 'read');
    const templates = await serviceTemplateService.listLocal(scope, scopeId);
    res.json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
}
