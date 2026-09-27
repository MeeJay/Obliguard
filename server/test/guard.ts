/**
 * Safety guard of the verification harness (server/test).
 *
 * Preloaded with `--import` in every suite process by run.ts, and imported
 * first by harness.ts. A suite must only ever run against the disposable
 * database created by the runner: without this guard, knexfile's default URL
 * (or an owner shell's DATABASE_URL) could point a suite at a real database.
 *
 * It also neutralises dotenv: src/env.ts loads the repository .env, which must
 * never feed a verify process (the runner pins the environment it needs).
 */
import path from 'path';
import { createRequire } from 'module';

const REFUSAL = 'server/test suites must be started by `npm run verify -w server` (disposable database only)';
const DB_NAME_RE = /^verify_[0-9a-f]{6}_[a-z0-9_]+$/;

function hostPort(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}`;
}

function check(): void {
  if (process.env.OBLIGUARD_VERIFY !== '1') throw new Error(REFUSAL);
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error(REFUSAL);
  let dbName: string;
  try {
    dbName = new URL(dbUrl).pathname.slice(1);
  } catch {
    throw new Error(REFUSAL);
  }
  if (!DB_NAME_RE.test(dbName)) throw new Error(REFUSAL);
  const adminUrl = process.env.VERIFY_ADMIN_URL;
  if (adminUrl && hostPort(adminUrl) !== hostPort(dbUrl)) throw new Error(REFUSAL);
}

check();

// src/env.ts calls dotenv.config() on the repository .env. env.ts never
// overrides variables that are already set, but a key the runner scrubbed
// (AGENT_*, IP_EVENTS_*, ...) would come back from a future .env: make the
// call a no-op for the whole verify process.
try {
  const serverRequire = createRequire(path.join(__dirname, '..', 'package.json'));
  const dotenv = serverRequire('dotenv') as { config: (...args: unknown[]) => unknown };
  dotenv.config = () => ({ parsed: {} });
} catch {
  /* dotenv not resolvable: nothing to neutralise */
}

export const VERIFY_GUARD_OK = true;
