import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { existsSync } from 'fs';
import { config } from './config';
import { errorHandler, apiNotFoundHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';
import { routes } from './routes';
import { healthHandler } from './routes/health';
import { sessionMiddleware } from './session';
import { sessionUserGuard } from './middleware/sessionUserGuard';

// sha256 of the inline theme bootstrap script of client/index.html (FOUC
// prevention), in its LF and CRLF checkouts. Keep in sync with the
// Content-Security-Policy of client/nginx.conf; a stale hash only costs a theme
// flash on load (React applies the theme again).
export const SPA_INLINE_SCRIPT_HASHES = [
  "'sha256-UAt1TA4dj9WHPn3IsId7EFCCnvVMwrMWXeWzs57RsdA='",
  "'sha256-7qSUcOl1E9dChPq3la8F8WRTFx+ho2HCMmsB8OevM7w='",
];

export function createApp() {
  const app = express();

  // Trust the first reverse proxy hop (the client container's nginx) so req.ip
  // is the address that nginx saw — the right-most X-Forwarded-For entry,
  // which a client cannot forge. It stays the rate-limit key. Every other use
  // of the client address goes through utils/clientIp (TRUSTED_PROXIES /
  // TRUSTED_PROXY_HOPS).
  app.set('trust proxy', 1);

  // Security headers. The policy matches the one client/nginx.conf sets on the
  // SPA (Docker), for installs where this process serves client/dist itself.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", ...SPA_INLINE_SCRIPT_HASHES],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'", "wss:", "ws:"],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          workerSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    }),
  );
  app.use(
    cors({
      origin: config.clientOrigin,
      credentials: true,
    }),
  );

  // Parsing — cookieParser must come before session (session reads the cookie).
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Sessions — stored in PostgreSQL via connect-pg-simple (see session.ts;
  // the same store/middleware also authenticates Socket.io handshakes).
  // MUST be set up before apiLimiter so that req.session.userId is available
  // in the limiter's skip() function (authenticated users are excluded from
  // rate limiting to avoid shared-IP false positives behind a reverse proxy).
  app.use(sessionMiddleware);
  // Re-check the account behind the session (disabled / deleted / demoted).
  app.use(sessionUserGuard);

  // Rate limiting — runs after session so authenticated users can be skipped.
  // Only unauthenticated endpoints (login page, public health, etc.) are limited.
  app.use(apiLimiter);

  // Obligate SSO callback — mounted at /auth (outside /api) so Obligate can redirect here directly
  const obligateCallback = require('./routes/obligateCallback.routes').default;
  app.use('/auth', obligateCallback);

  // API routes
  app.use('/api', routes);
  // Unknown /api/* answers 404 JSON (never the SPA index.html below).
  app.use('/api', apiNotFoundHandler);

  // Health check (public — also used by login page to display server version).
  // 503 when the database does not answer SELECT 1 within 3 s.
  app.get('/health', healthHandler);

  // Obli.tools unified desktop app downloads — serves pre-built binaries from obli.tools/dist/.
  // Whitelist prevents directory traversal; graceful 404 if a file isn't built yet.
  const DESKTOP_FILES: Record<string, string> = {
    'ObliTools.exe':          'ObliTools.exe',          // Windows binary (portable)
    'ObliToolsSetup.msi':     'ObliToolsSetup.msi',     // Windows installer (Start Menu shortcut)
    'ObliTools-arm64.zip':    'ObliTools-arm64.zip',    // macOS Apple Silicon — .app zipped
    'ObliTools-amd64.zip':    'ObliTools-amd64.zip',    // macOS Intel — .app zipped
    'ObliTools-arm64.dmg':    'ObliTools-arm64.dmg',    // macOS Apple Silicon — drag-to-Applications DMG
    'ObliTools-amd64.dmg':    'ObliTools-amd64.dmg',    // macOS Intel — drag-to-Applications DMG
  };
  // process.cwd() = server/ directory (both in dev with npx tsx and in production).
  // Go one level up to reach the project root, then into obli.tools/dist.
  const desktopDistDir = path.resolve(process.cwd(), '..', 'obli.tools', 'dist');

  app.get('/downloads/:filename', (req, res) => {
    const mapped = DESKTOP_FILES[req.params.filename];
    if (!mapped) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const filePath = path.join(desktopDistDir, mapped);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not yet available' });
      return;
    }
    res.download(filePath, mapped);
  });

  // Serve static client build in production
  if (!config.isDev) {
    const clientDist = path.join(__dirname, '../../client/dist');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // Error handling
  app.use(errorHandler);

  return app;
}
