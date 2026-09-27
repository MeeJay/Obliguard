import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Request, Response } from 'express';
import type { SessionData } from 'express-session';
import { config } from './config';
import { logger } from './utils/logger';
import { authService } from './services/auth.service';
import { canUseTenant } from './middleware/tenant';
import { sessionMiddleware } from './session';
import { db } from './db';

/**
 * Coerce a session-stored id to a positive integer, or null.
 * Room names are built from this value, so anything that is not a plain
 * integer (e.g. "5:admin") must be rejected to prevent room-name injection.
 */
function toPositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Operator-configured public origins (CLIENT_ORIGIN / APP_URL), normalized. */
const CONFIGURED_ORIGINS = new Set(
  [config.clientOrigin, process.env.APP_URL ?? '']
    .map((u) => { try { return new URL(u).origin; } catch { return null; } })
    .filter((o): o is string => o !== null),
);

/** Hostname (port stripped) of a Host / X-Forwarded-Host header value, or null. */
function headerHostname(value: string | string[] | undefined): string | null {
  const raw = (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim();
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Cross-Site WebSocket Hijacking guard for the engine.io handshake.
 * Sockets authenticate with the ambient session cookie, and neither the
 * `cors` option nor SameSite stops a WebSocket upgrade from another origin
 * (e.g. a sibling subdomain), so the handshake Origin must be the app itself:
 * a configured origin, or the same hostname the request was sent to (Host
 * only — cookies are not port-scoped anyway). X-Forwarded-Host is NOT
 * trusted: a page can set it on a polling XHR (the reflected CORS preflight
 * allows any header) and the proxy passes it through. Browsers always send
 * Origin on WebSocket and cross-origin requests; a missing Origin is a
 * same-origin polling request or a non-browser client, which carries no
 * ambient cookie of the victim.
 */
function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  if (CONFIGURED_ORIGINS.has(parsed.origin)) return true;
  const hostname = parsed.hostname;
  if (!hostname) return false;
  return hostname === headerHostname(req.headers.host);
}

/**
 * Run the Express session middleware on the handshake request so the
 * cookie-based session is loaded exactly as it is for HTTP routes.
 * The response object is a stub: nothing is ever written or saved here.
 */
function loadCookieSession(req: IncomingMessage): Promise<Partial<SessionData> | undefined> {
  return new Promise((resolve, reject) => {
    const expressReq = req as Request;
    sessionMiddleware(expressReq, {} as Response, (err?: unknown) => {
      if (err) reject(err);
      else resolve(expressReq.session);
    });
  });
}

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      // Reflect the request origin so any deployment URL works without
      // reconfiguring CLIENT_ORIGIN. Cross-origin handshakes are refused by
      // allowRequest below, and identity comes from the session cookie only.
      origin: true,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    // Runs on every engine.io handshake (polling and direct WebSocket); later
    // requests reuse the handshake's sid, and socket.request — the source of
    // the session cookie below — is always this checked handshake request.
    allowRequest: (req, callback) => {
      if (isAllowedOrigin(req)) return callback(null, true);
      logger.warn({ origin: req.headers.origin, host: req.headers.host }, 'Socket.io handshake rejected: cross-origin request');
      callback('Origin not allowed', false);
    },
  });

  // Socket.io authentication middleware.
  // Identity is derived ONLY from the server-side session (cookie) — never
  // from client-supplied handshake fields (userId / tenantId are ignored).
  // Like requireAuth, only a completed login counts: a session still waiting
  // for 2FA only holds pendingMfaUserId, never userId, and is rejected.
  io.use(async (socket, next) => {
    try {
      const sess = await loadCookieSession(socket.request);
      const userId = toPositiveInt(sess?.userId);
      if (!sess || userId === null) {
        return next(new Error('Authentication required'));
      }

      const user = await authService.getUserById(userId);
      if (!user || !user.isActive) {
        return next(new Error('Invalid user'));
      }

      // Tenant rooms follow the session's current tenant (set by login /
      // tenant switch). Same access rule as requireTenant (canUseTenant, DB
      // role): platform admins need the tenant to exist, others a membership.
      let tenantId = toPositiveInt(sess.currentTenantId);
      if (tenantId !== null && !(await canUseTenant(user.id, user.role, tenantId))) {
        logger.warn(`Socket: user ${user.id} cannot use session tenant ${tenantId} — tenant rooms not joined`);
        tenantId = null;
      }
      // Until realtime emits are tenant-scoped, broadcasts (ip:flow, heartbeats,
      // status) reach every socket: a non-admin with no tenant holds none.
      if (tenantId === null && user.role !== 'admin') return next(new Error('No tenant access'));

      socket.data.user = user;
      socket.data.tenantId = tenantId;
      next();
    } catch (err) {
      logger.error(err, 'Socket authentication failed');
      next(new Error('Authentication failed'));
    }
  });

  // NOTE: no client → server events are handled. If any are added, take the
  // caller's identity / tenant from socket.data only, never from the payload.
  io.on('connection', (socket) => {
    const user = socket.data.user;
    const tenantId: number | null = socket.data.tenantId;
    logger.info(`Socket connected: ${user.username} (id: ${user.id}, tenant: ${tenantId ?? 'none'})`);

    // Join user-specific room
    socket.join(`user:${user.id}`);

    // Join tenant-scoped rooms (only when the session tenant was validated)
    if (tenantId !== null) {
      socket.join(`tenant:${tenantId}`);
      if (user.role === 'admin') {
        socket.join(`tenant:${tenantId}:admin`);
      }
    }
    if (user.role === 'admin') {
      // Legacy platform-admin room (role read from the DB, not the client) —
      // existing emits still target it during the migration to tenant rooms.
      socket.join('role:admin');
    }

    // Join notification rooms for ALL tenants this user can access.
    // This ensures cross-tenant live alerts are delivered in real-time,
    // even when the user is currently viewing a different tenant.
    db('user_tenants')
      .where('user_id', user.id)
      .pluck('tenant_id')
      .then((tenantIds: unknown[]) => {
        for (const raw of tenantIds) {
          const tid = toPositiveInt(raw);
          if (tid !== null) socket.join(`tenant:${tid}:notifications`);
        }
      })
      .catch((err: unknown) => logger.error(err, 'Failed to join notification rooms'));

    // All authenticated users join the general room
    socket.join('general');

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${user.username}`);
    });
  });

  return io;
}
