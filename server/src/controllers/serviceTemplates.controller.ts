import type { Request, Response, NextFunction } from 'express';
import type { CreateServiceTemplateRequest } from '@obliview/shared';
import { serviceTemplateService } from '../services/serviceTemplate.service';
import { AppError } from '../middleware/errorHandler';

export interface UpsertServiceAssignmentRequest {
  logPathOverride?: string | null;
  thresholdOverride?: number | null;
  windowSecondsOverride?: number | null;
  enabledOverride?: boolean | null;
}

export async function listTemplates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const isAdmin = req.session?.role === 'admin';
    const templates = await serviceTemplateService.list(req.tenantId, isAdmin);
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

    res.json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
}

export async function createTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as CreateServiceTemplateRequest;

    if (!body.name?.trim()) {
      throw new AppError(400, 'name is required');
    }
    if (!body.serviceType?.trim()) {
      throw new AppError(400, 'serviceType is required');
    }

    const template = await serviceTemplateService.create(body, req.session?.userId ?? 0, req.tenantId);

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

    const template = await serviceTemplateService.update(id, req.body, req.tenantId);
    if (!template) {
      throw new AppError(404, 'Service template not found');
    }

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

    await serviceTemplateService.delete(id, req.tenantId);

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

    const body = req.body as UpsertServiceAssignmentRequest;

    const assignment = await serviceTemplateService.upsertAssignment(id, scope, scopeId, body);
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

    await serviceTemplateService.deleteAssignment(id, scope, scopeId);

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

    await serviceTemplateService.requestLogSample(templateId, deviceId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
