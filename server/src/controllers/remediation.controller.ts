import type { Request, Response } from 'express';
import { remediationService } from '../services/remediation.service';
import type {
  CreateRemediationActionRequest,
  UpdateRemediationActionRequest,
  AddRemediationBindingRequest,
  OverrideModeR,
  RemediationTrigger,
} from '@obliview/shared';

// ── Actions ────────────────────────────────────────────────────────────────────

export async function listActions(req: Request, res: Response) {
  const actions = await remediationService.listActions();
  res.json({ data: actions });
}

export async function createAction(req: Request, res: Response) {
  const body = req.body as CreateRemediationActionRequest;
  if (!body.name || !body.type || !body.config) {
    res.status(400).json({ error: 'name, type and config are required' });
    return;
  }
  const action = await remediationService.createAction(body);
  res.status(201).json({ data: action });
}

export async function updateAction(req: Request, res: Response) {
  const id = Number(req.params.id);
  const body = req.body as UpdateRemediationActionRequest;
  const action = await remediationService.updateAction(id, body);
  if (!action) { res.status(404).json({ error: 'Action not found' }); return; }
  res.json({ data: action });
}

export async function deleteAction(req: Request, res: Response) {
  const id = Number(req.params.id);
  await remediationService.deleteAction(id);
  res.status(204).send();
}

// ── Bindings ──────────────────────────────────────────────────────────────────

/** GET /remediation/bindings?scope=monitor&scopeId=42 */
export async function getBindings(req: Request, res: Response) {
  const { scope, scopeId } = req.query as { scope?: string; scopeId?: string };
  if (!scope) {
    res.status(400).json({ error: 'scope query param required' });
    return;
  }
  const id = scopeId !== undefined ? Number(scopeId) : null;
  const bindings = await remediationService.getBindings(scope, id);
  res.json({ data: bindings });
}

/** GET /remediation/resolved?scope=monitor&scopeId=42&groupId=5 */
export async function getResolved(req: Request, res: Response) {
  const { scope, scopeId, groupId } = req.query as {
    scope?: string; scopeId?: string; groupId?: string;
  };
  if (!scope || !scopeId) {
    res.status(400).json({ error: 'scope and scopeId required' });
    return;
  }
  const resolved = await remediationService.resolveBindingsWithSources(
    scope as 'group' | 'monitor',
    Number(scopeId),
    groupId ? Number(groupId) : null,
  );
  res.json({ data: resolved });
}

/** POST /remediation/bindings */
export async function addBinding(req: Request, res: Response) {
  const body = req.body as AddRemediationBindingRequest;
  if (!body.actionId || !body.scope) {
    res.status(400).json({ error: 'actionId and scope are required' });
    return;
  }
  const binding = await remediationService.addBinding(body);
  res.status(201).json({ data: binding });
}

/** PATCH /remediation/bindings/:id */
export async function updateBinding(req: Request, res: Response) {
  const id = Number(req.params.id);
  const { overrideMode, triggerOn, cooldownSeconds } = req.body as {
    overrideMode?: OverrideModeR;
    triggerOn?: RemediationTrigger;
    cooldownSeconds?: number;
  };
  const binding = await remediationService.updateBinding(id, { overrideMode, triggerOn, cooldownSeconds });
  if (!binding) { res.status(404).json({ error: 'Binding not found' }); return; }
  res.json({ data: binding });
}

/** DELETE /remediation/bindings/:id */
export async function deleteBinding(req: Request, res: Response) {
  const id = Number(req.params.id);
  await remediationService.deleteBinding(id);
  res.status(204).send();
}

// ── Run history ───────────────────────────────────────────────────────────────

/** GET /remediation/runs?monitorId=42 */
export async function getRuns(req: Request, res: Response) {
  const { monitorId, actionId } = req.query as { monitorId?: string; actionId?: string };
  if (monitorId) {
    const runs = await remediationService.getRunsForMonitor(Number(monitorId));
    res.json({ data: runs });
    return;
  }
  if (actionId) {
    const runs = await remediationService.getRunsForAction(Number(actionId));
    res.json({ data: runs });
    return;
  }
  res.status(400).json({ error: 'monitorId or actionId required' });
}
