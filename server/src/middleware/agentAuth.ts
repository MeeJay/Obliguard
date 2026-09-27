import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { logger } from '../utils/logger';
import { isAgentApiKeyFormat } from '../utils/agentIdentity';
import { agentService } from '../services/agent.service';

/**
 * Validates the X-API-Key header for agent push requests.
 * Attaches the api key id to req for downstream use.
 *
 * The format is checked before any query (a non-uuid value used to make the
 * PG uuid cast throw inside this async middleware and hang the request), and
 * next() runs outside the try so a downstream throw is never turned into a 401.
 */
export async function agentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];

  if (!isAgentApiKeyFormat(apiKey)) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  let keyRow: { id: number; tenant_id: number } | undefined;
  try {
    keyRow = await db('agent_api_keys').where({ key: apiKey }).first('id', 'tenant_id');
  } catch (err) {
    logger.warn({ err }, 'agentAuth: key lookup failed');
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  if (!keyRow) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  // Throttled, fire and forget
  agentService.touchApiKeyUsage(keyRow.id);

  (req as Request & { agentApiKeyId: number; agentTenantId: number }).agentApiKeyId = keyRow.id;
  (req as Request & { agentApiKeyId: number; agentTenantId: number }).agentTenantId = keyRow.tenant_id;
  next();
}
