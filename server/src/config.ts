/**
 * Session secrets that ship in this repository (old compose defaults, the
 * .env.example placeholder, the dev fallback below). Anyone who reads the
 * source can forge sessions signed with them: production refuses to start.
 */
export const KNOWN_DEFAULT_SESSION_SECRETS: readonly string[] = [
  'dev-secret-change-me',
  'change-this-in-production',
  'change-this-to-a-random-secret',
  'change-this-secret',
];

export const MIN_PRODUCTION_SESSION_SECRET_LENGTH = 32;

/**
 * Why `secret` is not acceptable in `nodeEnv`, or null when it is. Only
 * production is checked: dev and test keep the friendly default.
 */
export function productionSecretProblem(nodeEnv: string, secret: string | undefined): string | null {
  if (nodeEnv !== 'production') return null;
  if (!secret) return 'SESSION_SECRET is not set';
  if (KNOWN_DEFAULT_SESSION_SECRETS.includes(secret)) return 'SESSION_SECRET is a published default value';
  if (secret.length < MIN_PRODUCTION_SESSION_SECRET_LENGTH) {
    return `SESSION_SECRET is shorter than ${MIN_PRODUCTION_SESSION_SECRET_LENGTH} characters`;
  }
  return null;
}

/** Throws when the session secret is not acceptable for `nodeEnv`. */
export function assertProductionSecrets(nodeEnv: string, secret: string | undefined): void {
  const problem = productionSecretProblem(nodeEnv, secret);
  if (problem) {
    throw new Error(`${problem}. Set it to a random value of at least ${MIN_PRODUCTION_SESSION_SECRET_LENGTH} characters (openssl rand -hex 32). Refusing to start.`);
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgres://obliview:changeme@localhost:5432/obliview',

  // Session
  // Production refuses a missing, short or published value (session.ts).
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  // Raw value as set by the operator (undefined when absent), for the
  // production guard: the fallback above must never pass it.
  sessionSecretFromEnv: process.env.SESSION_SECRET || undefined,
  // Optional dedicated key for stored credentials (utils/crypto.ts). When
  // unset, credentials are encrypted with a key derived from SESSION_SECRET.
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || undefined,
  // Former SESSION_SECRET, kept only so credentials encrypted under it can
  // still be read after a rotation (re-encrypted on their next write).
  previousSessionSecret: process.env.PREVIOUS_SESSION_SECRET || undefined,
  sessionMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days

  // CORS
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  // HTTPS — set to "true" if behind an HTTPS reverse proxy
  forceHttps: process.env.FORCE_HTTPS === 'true',

  // App name (used as prefix in SMS/push notifications)
  appName: process.env.APP_NAME || 'Obliguard',

  // Default admin
  defaultAdminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',

  // 2FA bypass — set DISABLE_2FA_FORCE=true to skip forced 2FA requirement
  disable2faForce: process.env.DISABLE_2FA_FORCE === 'true',

  // App URL — used in password reset emails
  appUrl: process.env.APP_URL || 'http://localhost:5173',

};
