import type { Request, Response, NextFunction } from 'express';
import { rateLimitPolicyService } from '../services/rateLimitPolicy.service';
import { AppError } from '../middleware/errorHandler';
import type { CreateRateLimitPolicyRequest, RateLimitPolicy, RateLimitScope } from '@obliview/shared';

export async function listRateLimitPolicies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const scopeParam = req.query.scope as string | undefined;
    const scopeId = req.query.scopeId !== undefined && req.query.scopeId !== ''
      ? parseInt(req.query.scopeId as string, 10)
      : null;
    const isAdmin = req.session?.role === 'admin';

    let policies: RateLimitPolicy[];
    if (!scopeParam || scopeParam === 'all') {
      policies = await rateLimitPolicyService.listAll(req.tenantId, isAdmin);
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
    const body = req.body as CreateRateLimitPolicyRequest;
    if (!body.type) throw new AppError(400, 'type is required');
    if (body.maxValue == null) throw new AppError(400, 'maxValue is required');

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

    const isAdmin = req.session?.role === 'admin';
    await rateLimitPolicyService.delete(id, req.tenantId, isAdmin);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
