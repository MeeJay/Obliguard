import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';
import { obligateService } from '../services/obligate.service';
import { tenantService } from '../services/tenant.service';
import { appConfigService } from '../services/appConfig.service';
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /auth/callback?code=xxx&state=xxx
 * Called by Obligate after successful authentication.
 * Exchanges the code for user info, auto-provisions, creates session, redirects.
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code) {
      res.status(400).json({ success: false, error: 'Missing code' });
      return;
    }

    // Validate OAuth state parameter to prevent login CSRF (RFC 6749 §10.12)
    const expectedState = req.session.oauthState;
    delete req.session.oauthState;
    if (!expectedState || !state || state !== expectedState) {
      logger.warn({ receivedState: state, hasExpected: !!expectedState }, 'Obligate callback: state mismatch — possible CSRF');
      res.redirect('/login?error=sso_failed');
      return;
    }

    // Build the redirect_uri that was used in the authorize request
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/auth/callback`;

    // Exchange code with Obligate
    logger.info({ redirectUri }, 'Obligate callback: exchanging code');
    const assertion = await obligateService.exchangeCode(code, redirectUri);
    if (!assertion) {
      logger.warn('Obligate callback: exchange returned null — code invalid/expired or redirect_uri mismatch');
      res.redirect('/login?error=sso_failed');
      return;
    }
    logger.info({ obligateUserId: assertion.obligateUserId, username: assertion.username }, 'Obligate callback: exchange OK');

    // Find or create local user
    let localUserId: number;
    let needsProvision = false;

    if (assertion.linkedLocalUserId) {
      const existingUser = await db('users').where({ id: assertion.linkedLocalUserId }).first();
      if (existingUser) {
        localUserId = assertion.linkedLocalUserId;
        await db('users').where({ id: localUserId }).update({
          role: assertion.role === 'admin' ? 'admin' : 'user',
          email: assertion.email,
          display_name: assertion.displayName,
          updated_at: new Date(),
        });
      } else {
        logger.warn(`Obligate linkedLocalUserId ${assertion.linkedLocalUserId} no longer exists — will re-provision`);
        obligateService.reportProvision(assertion.obligateUserId, 0).catch(() => {});
        needsProvision = true;
        localUserId = 0;
      }
    } else {
      const existingLink = await db('sso_foreign_users')
        .where({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId })
        .first() as { local_user_id: number } | undefined;

      if (existingLink) {
        const existingUser = await db('users').where({ id: existingLink.local_user_id }).first();
        if (existingUser) {
          localUserId = existingLink.local_user_id;
          await db('users').where({ id: localUserId }).update({
            role: assertion.role === 'admin' ? 'admin' : 'user',
            email: assertion.email,
            display_name: assertion.displayName,
            updated_at: new Date(),
          });
        } else {
          logger.warn(`sso_foreign_users points to deleted user ${existingLink.local_user_id} — cleaning up and re-provisioning`);
          await db('sso_foreign_users').where({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId }).del();
          needsProvision = true;
          localUserId = 0;
        }
      } else {
        needsProvision = true;
        localUserId = 0;
      }
    }

    if (needsProvision) {
      const [newUser] = await db('users')
        .insert({
          username: `og_${assertion.username}`,
          display_name: assertion.displayName || assertion.username,
          email: assertion.email,
          role: assertion.role === 'admin' ? 'admin' : 'user',
          is_active: true,
          foreign_source: 'obligate',
          foreign_id: assertion.obligateUserId,
          enrollment_version: 999,
        })
        .returning('id') as Array<{ id: number }>;
      localUserId = newUser.id;

      await db('sso_foreign_users')
        .insert({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId, local_user_id: localUserId })
        .onConflict(['foreign_source', 'foreign_user_id'])
        .merge({ local_user_id: localUserId });

      for (const t of assertion.tenants) {
        const tenant = await db('tenants').where({ slug: t.slug }).first() as { id: number } | undefined;
        if (tenant) {
          await db('user_tenants')
            .insert({ user_id: localUserId, tenant_id: tenant.id, role: t.role === 'admin' ? 'admin' : 'member' })
            .onConflict(['user_id', 'tenant_id'])
            .merge({ role: t.role === 'admin' ? 'admin' : 'member' });
        }
      }

      obligateService.reportProvision(assertion.obligateUserId, localUserId).catch(() => {});
    }

    // Sync preferences from Obligate (theme, language, toast settings)
    if (assertion.preferences) {
      const prefUpdate: Record<string, unknown> = {};
      if (assertion.preferences.preferredLanguage) prefUpdate.preferred_language = assertion.preferences.preferredLanguage;
      if (assertion.preferences.profilePhotoUrl !== undefined) prefUpdate.avatar = assertion.preferences.profilePhotoUrl;
      if (Object.keys(prefUpdate).length > 0) {
        await db('users').where({ id: localUserId }).update(prefUpdate);
      }
      const uiPrefs: Record<string, unknown> = {};
      if (assertion.preferences.preferredTheme) uiPrefs.preferredTheme = assertion.preferences.preferredTheme;
      if (assertion.preferences.toastEnabled !== undefined) uiPrefs.toastEnabled = assertion.preferences.toastEnabled;
      if (assertion.preferences.toastPosition) uiPrefs.toastPosition = assertion.preferences.toastPosition;
      if (assertion.preferences.anonymousMode !== undefined) uiPrefs.anonymousMode = assertion.preferences.anonymousMode;
      if (Object.keys(uiPrefs).length > 0) {
        const existingRow = await db('users').where({ id: localUserId }).select('preferences').first() as { preferences: unknown } | undefined;
        const existing = (typeof existingRow?.preferences === 'string' ? JSON.parse(existingRow.preferences) : existingRow?.preferences) ?? {};
        await db('users').where({ id: localUserId }).update({
          preferences: JSON.stringify({ ...existing, ...uiPrefs }),
        });
      }
    }

    // Establish session
    req.session.userId = localUserId;
    const user = await db('users').where({ id: localUserId }).first() as { username: string; role: string } | undefined;
    if (user) {
      req.session.username = user.username;
      req.session.role = user.role;
    }

    // Set tenant
    const tenant = await tenantService.getFirstTenantForUser(localUserId);
    req.session.currentTenantId = tenant?.id ?? 1;

    logger.info(`Obligate SSO: user ${assertion.username} (obligate #${assertion.obligateUserId}) → local #${localUserId}`);

    // Save session, then redirect via HTML meta refresh to ensure Set-Cookie header
    // is fully processed by the browser before navigation occurs.
    req.session.save((err) => {
      if (err) { logger.error(err, 'Session save failed'); res.redirect('/login?error=sso_failed'); return; }
      logger.info({ sessionId: req.sessionID, userId: req.session.userId }, 'Session saved, redirecting to /');
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#8b949e;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.s{text-align:center}.d{width:28px;height:28px;border:2.5px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:r .6s linear infinite;margin:0 auto 14px}@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class="s"><div class="d"></div><div>Signing in...</div></div></body></html>`);
    });
  } catch (err) {
    logger.error(err, 'Obligate callback error');
    res.redirect('/login?error=sso_failed');
  }
});

/**
 * GET /auth/sso-redirect
 * Server-side redirect to Obligate authorize endpoint (browser redirect).
 * The server knows the API key — the client never sees it.
 */
router.get('/sso-redirect', async (req, res) => {
  try {
    const raw = await (await import('../services/appConfig.service')).appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) {
      res.redirect('/login');
      return;
    }
    // Verify Obligate is reachable before redirecting (prevents redirect loop when Gate is down)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const healthRes = await fetch(`${raw.url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!healthRes.ok) { res.redirect('/login?error=sso_failed'); return; }
    } catch {
      res.redirect('/login?error=sso_failed');
      return;
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const selfUrl = `${protocol}://${host}`;
    // Safety: never redirect to ourselves (misconfigured obligate_url pointing to this app)
    if (raw.url.replace(/\/$/, '') === selfUrl.replace(/\/$/, '')) {
      logger.error({ obligateUrl: raw.url, selfUrl }, 'sso-redirect: obligate_url points to this app — aborting to prevent loop');
      res.redirect('/login?error=sso_misconfigured');
      return;
    }
    const redirectUri = `${selfUrl}/auth/callback`;

    // Generate cryptographic state token to prevent login CSRF (RFC 6749 §10.12)
    const oauthState = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = oauthState;

    const obligateUrl = `${raw.url}/authorize?client_id=${encodeURIComponent(raw.apiKey)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(oauthState)}`;
    logger.info({ obligateUrl: raw.url, redirectUri }, 'sso-redirect: redirecting to Obligate');

    // Save session before redirecting to ensure state is persisted
    req.session.save((err) => {
      if (err) { logger.error(err, 'sso-redirect: session save failed'); res.redirect('/login?error=sso_failed'); return; }
      res.redirect(obligateUrl);
    });
  } catch {
    res.redirect('/login');
  }
});

/**
 * GET /api/auth/app-info
 * Called by Obligate (Bearer auth) to discover teams + tenants for mapping UI.
 */
router.get('/app-info', async (req, res) => {
  try {
    // Validate Bearer token = our Obligate API key (reverse auth: Obligate calls us)
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Missing Bearer token' });
      return;
    }
    const raw = await appConfigService.getObligateRaw();
    if (!raw.apiKey || authHeader.slice(7) !== raw.apiKey) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }

    // Fetch all teams across all tenants
    const teams = await db('user_teams')
      .join('tenants', 'user_teams.tenant_id', 'tenants.id')
      .select('user_teams.id', 'user_teams.name', 'tenants.slug as tenant_slug', 'tenants.name as tenant_name')
      .orderBy('tenants.name')
      .orderBy('user_teams.name') as Array<{ id: number; name: string; tenant_slug: string; tenant_name: string }>;

    // Fetch all tenants
    const tenants = await db('tenants')
      .select('id', 'name', 'slug')
      .orderBy('name') as Array<{ id: number; name: string; slug: string }>;

    res.json({
      success: true,
      data: {
        roles: ['admin', 'user'],
        teams: teams.map(t => ({ id: t.id, name: t.name, tenantSlug: t.tenant_slug, tenantName: t.tenant_name })),
        tenants: tenants.map(t => ({ slug: t.slug, name: t.name })),
      },
    });
  } catch (err) {
    logger.error(err, 'app-info error');
    res.status(500).json({ success: false, error: 'Failed to fetch app info' });
  }
});

/**
 * GET /api/auth/dashboard-stats
 * Called by Obligate (Bearer auth) to display stats on the Obligate dashboard.
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ success: false }); return; }
    const raw = await appConfigService.getObligateRaw();
    if (!raw.apiKey || authHeader.slice(7) !== raw.apiKey) { res.status(401).json({ success: false }); return; }

    const [agents, activeBans, threats] = await Promise.all([
      db('agent_devices').where({ status: 'approved' }).count('id as c').first(),
      db('ip_bans').where({ is_active: true }).count('id as c').first(),
      db('ip_events').count('id as c').first(),
    ]);
    res.json({ success: true, data: { stats: [
      { label: 'Agents', value: Number((agents as any)?.c ?? 0), color: '#58a6ff' },
      { label: 'Active Bans', value: Number((activeBans as any)?.c ?? 0), color: '#f85149' },
      { label: 'Events Logged', value: Number((threats as any)?.c ?? 0), color: '#d29922' },
    ] } });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/sso-config
 * Returns Obligate SSO config for the LoginPage (public, no auth required).
 */
router.get('/sso-config', async (_req, res) => {
  try {
    const config = await obligateService.getSsoConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false } });
  }
});

/**
 * GET /api/auth/sso-logout-url
 * Returns Obligate logout URL so the client can redirect after local logout.
 */
router.get('/sso-logout-url', async (req, res) => {
  try {
    const cfg = await appConfigService.getObligateRaw();
    if (!cfg.url) {
      res.json({ success: true, data: null });
      return;
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/login`;
    const logoutUrl = `${cfg.url}/logout?redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ success: true, data: logoutUrl });
  } catch {
    res.json({ success: true, data: null });
  }
});

/**
 * GET /api/auth/connected-apps
 * Returns list of connected apps from Obligate (for cross-app nav buttons).
 */
router.get('/connected-apps', requireAuth, async (req, res) => {
  try {
    const apps = await obligateService.getConnectedApps();
    res.json({ success: true, data: apps });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

/**
 * GET /api/auth/device-links?uuid=xxx
 * Returns cross-app links for a device UUID via Obligate.
 */
router.get('/device-links', requireAuth, async (req, res) => {
  try {
    const uuid = req.query.uuid as string;
    if (!uuid) { res.json({ success: true, data: [] }); return; }
    const links = await obligateService.getDeviceLinks(uuid);
    res.json({ success: true, data: links });
  } catch {
    res.json({ success: true, data: [] });
  }
});

/**
 * POST /api/auth/sso-user-sync
 * Called by Obligate (Bearer auth) when an SSO user is deactivated, reactivated, deleted, or role-changed.
 */
router.post('/sso-user-sync', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ success: false }); return; }
    const raw = await appConfigService.getObligateRaw();
    if (!raw.apiKey || authHeader.slice(7) !== raw.apiKey) { res.status(401).json({ success: false }); return; }

    const { remoteUserId, action, role } = req.body as {
      obligateUserId: number; obligateUsername: string; remoteUserId: number;
      action: 'deactivate' | 'reactivate' | 'delete' | 'update-role'; role?: string;
    };

    if (!remoteUserId || !action) { res.status(400).json({ success: false, error: 'Missing fields' }); return; }

    const user = await db('users').where({ id: remoteUserId }).first();
    if (!user) { res.json({ success: true }); return; }

    switch (action) {
      case 'deactivate':
        await db('users').where({ id: remoteUserId }).update({ is_active: false, updated_at: new Date() });
        logger.info(`SSO sync: deactivated user #${remoteUserId}`);
        break;
      case 'reactivate':
        await db('users').where({ id: remoteUserId }).update({ is_active: true, updated_at: new Date() });
        logger.info(`SSO sync: reactivated user #${remoteUserId}`);
        break;
      case 'delete':
        await db('sso_foreign_users').where({ local_user_id: remoteUserId }).del();
        await db('users').where({ id: remoteUserId }).del();
        logger.info(`SSO sync: deleted user #${remoteUserId}`);
        break;
      case 'update-role':
        if (role) {
          await db('users').where({ id: remoteUserId }).update({ role: role === 'admin' ? 'admin' : 'user', updated_at: new Date() });
          logger.info(`SSO sync: updated role of user #${remoteUserId} to ${role}`);
        }
        break;
    }

    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'sso-user-sync error');
    res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

export default router;
