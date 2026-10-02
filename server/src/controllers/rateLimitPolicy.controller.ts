import type { Request, Response, NextFunction } from 'express';
import { rateLimitPolicyService } from '../services/rateLimitPolicy.service';
import { AppError } from '../middleware/errorHandler';
import type { CreateRateLimitPolicyRequest, RateLimitPolicy, RateLimitScope } from '@obliview/shared';

export async function listRateLimitPolicies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const scopeParam = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    let scopeId: number | null = null;
    if (typeof req.query.scopeId === 'string' && req.query.scopeId !== '') {
      scopeId = Number(req.query.scopeId);
      if (!Number.isSafeInteger(scopeId) || scopeId <= 0) throw new AppError(400, 'Invalid scopeId');
    }
    const isAdmin = req.session?.role === 'admin';

    // Group/agent rows follow the operating tenant (W1-2; Default = god view).
    let policies: RateLimitPolicy[];
    if (!scopeParam || scopeParam === 'all') {
      policies = await rateLimitPolicyService.listAll(req.tenantId);
    } else {
      policies = await rateLimitPolicyService.listByScope(scopeParam as RateLimitScope, scopeId, req.tenantId, isAdmin);
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
    res.status(201).json({ success: true, data: policy });
  } catch (err) {
    next(err);
  }
}

export async function deleteRateLimitPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) throw new AppError(400, 'Invalid rate limit policy ID');

    // Follows the operating tenant; the platform role grants nothing extra.
    await rateLimitPolicyService.delete(id, req.tenantId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
