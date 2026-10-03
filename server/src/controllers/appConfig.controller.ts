import type { Request, Response, NextFunction } from 'express';
import { appConfigService } from '../services/appConfig.service';
import { AppError } from '../middleware/errorHandler';
import { TENANT_HEADER, TENANT_CHANGED } from '../middleware/tenant';
import { isAgentUpdatePolicy } from '../utils/agentUpdate';
import { agentService } from '../services/agent.service';
import { logger } from '../utils/logger';
import { auditService, REDACTED } from '../services/audit.service';
import { settingsService, legacyTypesToFlags, writableDefinition, normalizeSettingValue } from '../services/settings.service';
import {
  banPolicyService, MIN_BAN_TTL_SECONDS, MAX_BAN_TTL_SECONDS, MAX_LADDER_STEPS, MAX_LADDER_PRIOR_BANS,
} from '../services/banPolicy.service';
import type { EffectiveBanPolicy } from '../services/banPolicy.service';
import type { AgentGlobalConfig, AgentUpdatePolicy } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';

const ALLOWED_KEYS = [
  'allow_2fa', 'force_2fa', 'otp_smtp_server_id',
  'obligate_enabled',
  'oblitools_push_enabled', 'oblitools_instance_name', 'oblitools_api_key',
] as const;

/** Keys whose value never reaches the audit trail (only the fact they changed). */
const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set(['oblitools_api_key']);

/** Ban policy response: the policy in force, its layer and the editor's bounds. */
function banPolicyBody(eff: EffectiveBanPolicy) {
  return {
    ...eff,
    limits: {
      minTtlSeconds: MIN_BAN_TTL_SECONDS,
      maxTtlSeconds: MAX_BAN_TTL_SECONDS,
      maxSteps: MAX_LADDER_STEPS,
      maxPriorBans: MAX_LADDER_PRIOR_BANS,
    },
  };
}

export const appConfigController = {
  async getAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAll();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  async set(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const key = req.params.key as typeof ALLOWED_KEYS[number];
      if (!ALLOWED_KEYS.includes(key)) throw new AppError(400, `Unknown config key: ${key}`);
      const { value } = req.body;
      if (value === undefined) throw new AppError(400, 'Missing value');
      await appConfigService.set(key, String(value));
      // Instance-level row (tenant NULL): Default god view only.
      await auditService.logReq(req, {
        action: 'app_config.updated', targetType: 'app_config', targetId: key, tenantId: null,
        details: { setting: key, value: SECRET_CONFIG_KEYS.has(key) ? (String(value) === '' ? null : REDACTED) : String(value) },
      });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /**
   * GET /admin/config/agent-global — compat view of the global level of the
   * IPS settings cascade (W13-1; GET /settings/global/resolved is the full
   * one). The legacy JSON is kept in sync by every global write.
   */
  async getAgentGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAgentGlobal();
      // heartbeatMonitoring stored by older versions is not returned.
      const { heartbeatMonitoring: _leftover, ...data } = cfg as AgentGlobalConfig & { heartbeatMonitoring?: unknown };
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** PATCH /admin/config/agent-global */
  async patchAgentGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // heartbeatMonitoring (Obliview leftover) is ignored if an old client sends it,
      // and a value stored by an older version is dropped on this write (an
      // undefined key is left out of the stored JSON and of the response).
      const { checkIntervalSeconds, maxMissedPushes, notificationTypes } = req.body;
      const patch: Record<string, unknown> = { heartbeatMonitoring: undefined };
      if ('checkIntervalSeconds' in req.body) patch.checkIntervalSeconds = checkIntervalSeconds;
      if ('maxMissedPushes' in req.body) patch.maxMissedPushes = maxMissedPushes;
      if ('notificationTypes' in req.body) patch.notificationTypes = notificationTypes;

      // Global agent update policy (C17-1): platform admin (route guard) operating
      // in the Default tenant only. The route has no requireTenant, so the tab's
      // operating-tenant header is checked against the session here.
      let before: AgentUpdatePolicy | null | undefined;
      const hasPolicy = 'updatePolicy' in req.body;
      if (hasPolicy) {
        const claimedRaw = req.get(TENANT_HEADER);
        const claimed = claimedRaw !== undefined ? Number(claimedRaw) : NaN;
        if (Number.isSafeInteger(claimed) && claimed > 0 && claimed !== req.session.currentTenantId) {
          throw new AppError(409, 'Workspace changed in another tab', TENANT_CHANGED);
        }
        if (!isMasterTenant(req.session.currentTenantId)) {
          throw new AppError(403, 'Switch to the Default tenant to change the global update policy');
        }
        const v = req.body.updatePolicy;
        if (v !== null && !isAgentUpdatePolicy(v)) throw new AppError(400, 'Invalid updatePolicy');
        patch.updatePolicy = v;
        before = (await appConfigService.getAgentGlobal()).updatePolicy;
      }

      // Settings cascade (W13-1): the global level is a settings row per key,
      // validated before anything is written (400); the legacy JSON below
      // stays the mirror (and the C17 updatePolicy store).
      const cascade: Array<{ key: string; value: unknown }> = [];
      if ('checkIntervalSeconds' in patch) cascade.push({ key: 'checkIntervalSeconds', value: patch.checkIntervalSeconds ?? null });
      if ('maxMissedPushes' in patch) cascade.push({ key: 'maxMissedPushes', value: patch.maxMissedPushes ?? null });
      if ('notificationTypes' in patch) cascade.push({ key: 'notificationTypes', value: legacyTypesToFlags(patch.notificationTypes ?? null) });
      for (const c of cascade) {
        if (c.value !== null) normalizeSettingValue(writableDefinition(c.key, 'global'), c.value);
      }

      const updated = await appConfigService.setAgentGlobal(patch);
      if (cascade.length > 0) {
        await settingsService.writeMany({ level: 'global', scopeId: null, tenantId: 1 }, cascade, { mirror: false });
      }
      await auditService.logReq(req, {
        action: 'app_config.agent_global_updated', targetType: 'app_config', targetId: 'agent_global', tenantId: null,
        details: {
          fields: Object.keys(patch).filter((k) => k !== 'heartbeatMonitoring'),
          ...('checkIntervalSeconds' in patch ? { checkIntervalSeconds: patch.checkIntervalSeconds } : {}),
          ...('maxMissedPushes' in patch ? { maxMissedPushes: patch.maxMissedPushes } : {}),
          ...(hasPolicy ? { updatePolicyFrom: before ?? null, updatePolicyTo: updated.updatePolicy ?? null } : {}),
        },
      });
      if (hasPolicy && (before ?? null) !== (updated.updatePolicy ?? null)) {
        if (updated.updatePolicy === 'off') await agentService.cancelAllOpenAttempts();
        logger.info({
          event: 'agent_update_global_policy', userId: req.session.userId, from: before ?? null, to: updated.updatePolicy ?? null,
        }, 'Global agent update policy changed');
      }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ── Auto-ban duration policy (W12-3) ───────────────────────────────────

  /**
   * GET /admin/config/ban-policy — the platform auto-ban duration policy.
   * Readable by every signed-in user (the Policies tab shows it read-only to
   * whoever cannot edit it); it holds no secret.
   */
  async getBanPolicy(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: banPolicyBody(await banPolicyService.getEffective()) });
    } catch (err) { next(err); }
  },

  /**
   * PUT /admin/config/ban-policy — body { autoBanTtlSeconds, ladder } (or
   * the same under `policy`), or { policy: null } (back to the permanent
   * default). Platform admin (route guard) operating the Default tenant:
   * auto-bans are global, so is their duration. Applies to bans created
   * afterwards only.
   */
  async setBanPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const claimedRaw = req.get(TENANT_HEADER);
      const claimed = claimedRaw !== undefined ? Number(claimedRaw) : NaN;
      if (Number.isSafeInteger(claimed) && claimed > 0 && claimed !== req.session.currentTenantId) {
        throw new AppError(409, 'Workspace changed in another tab', TENANT_CHANGED);
      }
      if (!isMasterTenant(req.session.currentTenantId)) {
        throw new AppError(403, 'Switch to the Default tenant to change the ban policy');
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      // { policy: {...} } is accepted too; { policy: null } resets.
      const input = 'policy' in body ? body.policy : body;
      const reset = input === null;
      const before = (await banPolicyService.getEffective()).policy;
      const updated = await banPolicyService.set(input);
      await auditService.logReq(req, {
        action: 'app_config.ban_policy_updated', targetType: 'app_config', targetId: 'ban_policy', tenantId: null,
        details: { from: before, to: updated.policy, reset },
      });
      logger.info({ event: 'ban_policy_changed', userId: req.session.userId, policy: updated.policy, source: updated.source }, 'Auto-ban duration policy changed');
      res.json({ success: true, data: banPolicyBody(updated) });
    } catch (err) { next(err); }
  },

  // ── Data retention (W12-1) ──────────────────────────────────────────────

  /** GET /admin/config/retention — stored / effective / fallback / bounds per window (admin only). */
  async getRetention(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: await appConfigService.getRetentionView() });
    } catch (err) { next(err); }
  },

  /**
   * PUT /admin/config/retention — patch { eventsDays?, reputationDays?,
   * banHistoryDays?, auditDays? } (null resets a key to its env/default
   * fallback). Instance setting: platform admin (route guard) operating the
   * Default tenant. The service answers 400 VALIDATION on a bad patch.
   */
  async setRetention(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const claimedRaw = req.get(TENANT_HEADER);
      const claimed = claimedRaw !== undefined ? Number(claimedRaw) : NaN;
      if (Number.isSafeInteger(claimed) && claimed > 0 && claimed !== req.session.currentTenantId) {
        throw new AppError(409, 'Workspace changed in another tab', TENANT_CHANGED);
      }
      if (!isMasterTenant(req.session.currentTenantId)) {
        throw new AppError(403, 'Data retention is an instance setting: switch to the Default tenant');
      }
      const before = await appConfigService.getRetention();
      const view = await appConfigService.setRetention(req.body);
      await auditService.logReq(req, {
        action: 'app_config.updated', targetType: 'app_config', targetId: 'retention', tenantId: null,
        details: { setting: 'retention', before, patch: req.body },
      });
      res.json({ success: true, data: view });
    } catch (err) { next(err); }
  },

  // ── Obligate SSO gateway ────────────────────────────────────────────────

  /** GET /admin/config/obligate — returns { url, apiKeySet, enabled } (admin only) */
  async getObligateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getObligateConfig();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  /** PUT /admin/config/obligate — sets url and/or apiKey and/or enabled (admin only) */
  async setObligateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const patch: { url?: string | null; apiKey?: string | null; enabled?: boolean } = {};
      if ('url'     in req.body) patch.url     = (req.body as { url?: string | null }).url ?? null;
      if ('apiKey'  in req.body) patch.apiKey  = (req.body as { apiKey?: string | null }).apiKey ?? null;
      if ('enabled' in req.body) patch.enabled = !!(req.body as { enabled?: boolean }).enabled;
      const updated = await appConfigService.patchObligateConfig(patch);
      // Never the API key value: only whether it was set or cleared.
      await auditService.logReq(req, {
        action: 'app_config.obligate_updated', targetType: 'app_config', targetId: 'obligate', tenantId: null,
        details: {
          fields: Object.keys(patch),
          ...('url' in patch ? { url: patch.url } : {}),
          ...('enabled' in patch ? { enabled: patch.enabled } : {}),
          ...('apiKey' in patch ? { apiAccess: patch.apiKey ? 'set' : 'cleared' } : {}),
        },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },
};
