import type { Request, Response, NextFunction } from 'express';
import type { UserRole, Capability } from '@obliview/shared';
import { AppError } from './errorHandler';
import { permissionService } from '../services/permission.service';

/**
 * Require a feature capability (e.g. 'monitor_rw', 'bans') on WRITE routes.
 * Admins always pass; non-admins hold every capability only as members of the
 * current tenant; the legacy per-team capability column is ignored. Mount it
 * after requireTenant (it reads the validated req.tenantId).
 */
export function requireCapability(capability: Capability) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.session?.userId) {
        next(new AppError(401, 'Authentication required'));
        return;
      }
      if (req.session.role === 'admin') { next(); return; }

      const caps = await permissionService.getUserCapabilities(
        req.session.userId,
        false,
        req.tenantId ?? req.session.currentTenantId,
      );
      if (!caps.includes(capability)) {
        next(new AppError(403, 'Insufficient permissions'));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      next(new AppError(401, 'Authentication required'));
      return;
    }

    if (!roles.includes(req.session.role as UserRole)) {
      next(new AppError(403, 'Insufficient permissions'));
      return;
    }

    next();
  };
}

/**
 * Require write permission on a monitor (id from req.params.id).
 * Admins always pass. Non-admins need RW via their teams.
 */
export function requireMonitorWrite() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      const monitorId = parseInt(req.params.id, 10);
      if (isNaN(monitorId)) return next(new AppError(400, 'Invalid monitor ID'));
      const canWrite = await permissionService.canWriteMonitor(req.session.userId!, monitorId, false);
      if (!canWrite) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require write permission on a group (id from req.params.id).
 */
export function requireGroupWrite() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      const groupId = parseInt(req.params.id, 10);
      if (isNaN(groupId)) return next(new AppError(400, 'Invalid group ID'));
      const canWrite = await permissionService.canWriteGroup(req.session.userId!, groupId, false);
      if (!canWrite) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require canCreate permission (for creating new monitors/groups).
 */
export function requireCanCreate() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      const canCreate = await permissionService.canCreate(req.session.userId!, false);
      if (!canCreate) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  };
}
