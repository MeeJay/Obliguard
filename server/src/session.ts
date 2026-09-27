import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from './config';
import { logger } from './utils/logger';

// Session store + middleware shared by the Express app (app.ts) and the
// Socket.io handshake (socket.ts), so sockets authenticate against the exact
// same server-side sessions as HTTP requests.

const PgSession = connectPgSimple(session);

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
    secure: config.forceHttps,
    httpOnly: true,
    maxAge: config.sessionMaxAge,
    sameSite: 'lax',
  },
});
