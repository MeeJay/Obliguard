import type { Request, Response, NextFunction } from 'express';
import { rateLimitPolicyService } from '../services/rateLimitPolicy.service';
import type { RateLimitPolicyListItem, UpdateRateLimitPolicyRequest } from '../services/rateLimitPolicy.service';
import { appConfigService } from '../services/appConfig.service';
import { AppError } from '../middleware/errorHandler';
import { parseTenantIds } from '../middleware/tenant';
import { logger } from '../utils/logger';
import { auditService } from '../services/audit.service';
import { db } from '../db';

/** Audit fields of a policy (agent-scoped policies link to the agent). */
function policyAuditFields(p: { type: string; scope: string; scopeId: number | null; enabled: boolean; port: number | null; maxValue: number; banMultiplier: number | null }) {
  return {
    deviceId: p.scope === 'agent' ? p.scopeId : null,
    details: { type: p.type, scope: p.scope, scopeId: p.scopeId, enabled: p.enabled, port: p.port, maxValue: p.maxValue, banMultiplier: p.banMultiplier },
  };
}
import { isMasterTenant } from '@obliview/shared';
import type { CreateRateLimitPolicyRequest, RateLimitScope } from '@obliview/shared';

export async function listRateLimitPolicies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const scopeParam = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    let scopeId: number | null = null;
    if (typeof req.query.scopeId === 'string' && req.query.scopeId !== '') {
      scopeId = Number(req.query.scopeId);
      if (!Number.isSafeInteger(scopeId) || scopeId <= 0) throw new AppError(400, 'Invalid scopeId');
    }
    const isAdmin = req.session?.role === 'admin';
    // God view tenant chips (Default only; ignored elsewhere by readTenantsFor).
    const tenantIds = parseTenantIds(req.query.tenants);

    // Group/agent rows follow the operating tenant (W1-2; Default = god view).
    let policies: RateLimitPolicyListItem[];
    if (!scopeParam || scopeParam === 'all') {
      policies = await rateLimitPolicyService.listAll(req.tenantId, tenantIds);
    } else {
      policies = await rateLimitPolicyService.listByScope(scopeParam as RateLimitScope, scopeId, req.tenantId, isAdmin, tenantIds);
    }

    res.json({ success: true, data: policies });
  } catch (err) {
    next(err);
  }
}

export async function createRateLimitPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as CreateRateLimitPolicyRequest;
    if (!body.type) throw new AppError(400, 'type is required');
    if (body.maxValue == null) throw new AppError(400, 'maxValue is required');

    // Global only from Default; group/agent targets must be the operating
    // tenant's own (checked in the service, W1-2).
    const policy = await rateLimitPolicyService.create(body, req.session?.userId ?? 0, req.tenantId);
    await auditService.logReq(req, {
      action: 'rate_limit.created', targetType: 'rate_limit_policy', targetId: policy.id, ...policyAuditFields(policy),
    });
    res.status(201).json({ success: true, data: policy });
  } catch (err) {
    next(err);
  }
}

export async function updateRateLimitPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) throw new AppError(400, 'Invalid rate limit policy ID');
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Invalid body');

    // Same validation and tenant rules as create; only the owner edits (service).
    const policy = await rateLimitPolicyService.update(id, body as UpdateRateLimitPolicyRequest, req.tenantId);
    const fields = policyAuditFields(policy);
    await auditService.logReq(req, {
      action: 'rate_limit.updated', targetType: 'rate_limit_policy', targetId: id,
      deviceId: fields.deviceId, details: { ...fields.details, fields: Object.keys(body as object) },
    });
    res.json({ success: true, data: policy });
  } catch (err) {
    next(err);
  }
}

/** Global enforcement switch (readable by every member: limits are inert while it is off). */
export async function getRateLimitEnforcement(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: { enforcement: await appConfigService.getRateLimitEnforcement() } });
  } catch (err) {
    next(err);
  }
}

/** Platform admin (route guard) operating the Default tenant: the switch is instance-wide. */
export async function setRateLimitEnforcement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!isMasterTenant(req.tenantId)) {
      throw new AppError(403, 'Rate limit enforcement can only be changed from the Default tenant');
    }
    const value = (req.body ?? {}).enforcement;
    if (value !== 'on' && value !== 'off') throw new AppError(400, "enforcement must be 'on' or 'off'");

    const enforcement = await appConfigService.setRateLimitEnforcement(value);
    logger.info({ userId: req.session?.userId, enforcement }, 'Rate limit enforcement changed');
    // Instance-wide switch: instance-level row.
    await auditService.logReq(req, {
      action: 'rate_limit.enforcement_changed', targetType: 'app_config', targetId: 'rateLimitEnforcement', tenantId: null,
      details: { enforcement },
    });
    res.json({ success: true, data: { enforcement } });
  } catch (err) {
    next(err);
  }
}

export async function deleteRateLimitPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) throw new AppError(400, 'Invalid rate limit policy ID');

    const before = await db('rate_limit_policies').where({ id }).first('type', 'scope', 'scope_id', 'port', 'max_value') as
      { type: string; scope: string; scope_id: number | null; port: number | null; max_value: number } | undefined;
    // Follows the operating tenant; the platform role grants nothing extra.
    await rateLimitPolicyService.delete(id, req.tenantId);
    await auditService.logReq(req, {
      action: 'rate_limit.deleted', targetType: 'rate_limit_policy', targetId: id,
      deviceId: before?.scope === 'agent' ? before.scope_id : null,
      details: before ? { type: before.type, scope: before.scope, scopeId: before.scope_id, port: before.port, maxValue: before.max_value } : {},
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
