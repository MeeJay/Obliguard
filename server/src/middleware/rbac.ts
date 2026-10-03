import type { Request, Response, NextFunction } from 'express';
import type { UserRole, CapabilityKey } from '@obliview/shared';
import { holdsCapability } from '@obliview/shared';
import { AppError } from './errorHandler';
import { permissionService } from '../services/permission.service';

/**
 * Require a capability on a route: a tenant capability ('bans.create') or a
 * legacy alias ('bans', 'monitor_rw', ...: held when every tenant capability
 * it stands for is held). Platform admins always pass; anyone else is
 * resolved through their role in the operating tenant (user_tenants.role =
 * permission-set slug; 'admin' = all, unknown slug = none). Mirrors Obliance
 * requireTenantCapability. Mount it after requireTenant (it reads the
 * validated req.tenantId).
 */
export function requireCapability(capability: CapabilityKey) {
  return requireAnyCapability([capability]);
}

/**
 * Like requireCapability, but passes when the user holds ANY of the listed
 * capabilities (Obliance requireAnyTenantCapability).
 */
export function requireAnyCapability(capabilities: readonly CapabilityKey[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.session?.userId) {
        next(new AppError(401, 'Authentication required'));
        return;
      }
      if (req.session.role === 'admin') { next(); return; }

      const tenantId = req.tenantId ?? req.session.currentTenantId;
      const held = await permissionService.getTenantCapabilities(req.session.userId, false, tenantId);
      const ok = capabilities.some((c) => holdsCapability(held, c));
      if (!ok) {
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
 * Require write permission on a group (id from req.params.id).
 * Admins always pass. Non-admins need the tenant capability groups.manage
 * (a viewer's team RW grants nothing) AND RW via their teams of the
 * operating tenant; the controller then binds the group itself to req.tenantId.
 */
export function requireGroupWrite() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      const groupId = parseInt(req.params.id, 10);
      if (isNaN(groupId)) return next(new AppError(400, 'Invalid group ID'));
      if (!(await permissionService.hasCapability(req.session.userId!, false, req.tenantId ?? req.session.currentTenantId, 'groups.manage'))) {
        return next(new AppError(403, 'Insufficient permissions'));
      }
      // Tenant admins bypass team scope (W7-1); the controller still binds the
      // group to the operating tenant (loadGroup 'write').
      if (await permissionService.bypassesTeamScope(req.session.userId!, false, req.tenantId ?? req.session.currentTenantId)) return next();
      const canWrite = await permissionService.canWriteGroup(req.session.userId!, groupId, false, req.tenantId);
      if (!canWrite) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require canCreate permission (for creating new groups), via a team of the
 * operating tenant, plus the tenant capability groups.manage.
 */
export function requireCanCreate() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      if (!(await permissionService.hasCapability(req.session.userId!, false, req.tenantId ?? req.session.currentTenantId, 'groups.manage'))) {
        return next(new AppError(403, 'Insufficient permissions'));
      }
      if (await permissionService.bypassesTeamScope(req.session.userId!, false, req.tenantId ?? req.session.currentTenantId)) return next();
      const canCreate = await permissionService.canCreate(req.session.userId!, false, req.tenantId);
      if (!canCreate) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  };
}
