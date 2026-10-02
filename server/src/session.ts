import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config, assertProductionSecrets } from './config';
import { logger } from './utils/logger';

// Session store + middleware shared by the Express app (app.ts) and the
// Socket.io handshake (socket.ts), so sockets authenticate against the exact
// same server-side sessions as HTTP requests.

const PgSession = connectPgSimple(session);

// SECURITY: refuse to start in production with a missing, short or published
// SESSION_SECRET — sessions signed with a value from the repository are
// trivially forgeable. Runs at import time, i.e. before migrations and before
// the HTTP server listens (index.ts imports app.ts, which imports this module).
// Dev and test keep the friendly default. Mirrors Obliance app.ts.
try {
  assertProductionSecrets(config.nodeEnv, config.sessionSecretFromEnv);
} catch (err) {
  logger.fatal((err as Error).message);
  process.exit(1);
}

// Sessions — stored in PostgreSQL via connect-pg-simple.
// Log errors so we can diagnose DB connection drops that would otherwise
// silently cause "Invalid username or password" on the login page.
export const sessionStore = new PgSession({
  conString: config.databaseUrl,
  tableName: 'session',
  createTableIfMissing: false,
});
sessionStore.on('error', (err: Error) => {
  logger.error(err, 'Session store error — sessions may fail until DB connection recovers');
});

export const sessionMiddleware = session({
  store: sessionStore,
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Production always requires HTTPS for the session cookie (an install
    // behind a TLS-terminating proxy must not depend on FORCE_HTTPS to keep
    // the cookie off clear-text links); dev still allows plain HTTP.
    // Express sees the proxied scheme through 'trust proxy' (app.ts) and
    // X-Forwarded-Proto (client/nginx.conf).
    secure: config.nodeEnv === 'production' ? true : config.forceHttps,
    httpOnly: true,
    maxAge: config.sessionMaxAge,
    sameSite: 'lax',
  },
});
