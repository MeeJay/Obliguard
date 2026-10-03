import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { isAgentApiKeyFormat } from '../utils/agentIdentity';
import { agentService } from '../services/agent.service';
import { agentKeyService } from '../services/agentKey.service';

/**
 * Validates the X-API-Key header for agent push requests.
 * Attaches the api key id to req for downstream use.
 *
 * The format is checked before any query (a non-uuid value used to make the
 * PG uuid cast throw inside this async middleware and hang the request), and
 * next() runs outside the try so a downstream throw is never turned into a 401.
 *
 * A disabled key (agent_api_keys.is_active = false, W10-2) gets the same 401
 * as an unknown one, so a scanner cannot tell a revoked key from a wrong one.
 * There is no key cache: every request reads is_active (agentKeyService
 * findActiveByValue, shared with the WS gate), so disabling is immediate.
 */
export async function agentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];

  if (!isAgentApiKeyFormat(apiKey)) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  let keyRow: { id: number; tenantId: number } | null;
  try {
    keyRow = await agentKeyService.findActiveByValue(apiKey);
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
  (req as Request & { agentApiKeyId: number; agentTenantId: number }).agentTenantId = keyRow.tenantId;
  next();
}
