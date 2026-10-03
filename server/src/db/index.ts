import knex from 'knex';
import type { Knex } from 'knex';
import knexConfig from '../../knexfile';
import { logger } from '../utils/logger';

/**
 * Runtime database handle. On top of knexfile.ts (shared with the knex CLI and
 * the migrations), every connection of this pool gets:
 *  - a server-side statement_timeout (DATABASE_STATEMENT_TIMEOUT_MS, default
 *    30 s, 0 disables): a runaway query is cancelled (SQLSTATE 57014, answered
 *    503 by errorHandler) instead of pinning a pool slot and the request;
 *  - a bounded wait for a free connection (DATABASE_ACQUIRE_TIMEOUT_MS,
 *    default 20 s): a saturated pool fails the request instead of hanging it;
 *  - logging of connection failures and of connections dropped while idle.
 * Migrations run without the statement timeout (see the `migrate` override).
 */

export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 20_000;

/** Non-negative integer from the environment, `fallback` when unset or invalid. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(`${name}=${raw} is not a valid duration in ms, using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

export const statementTimeoutMs = envMs('DATABASE_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS);
const acquireTimeoutMs = envMs('DATABASE_ACQUIRE_TIMEOUT_MS', knexConfig.pool?.acquireTimeoutMillis ?? DEFAULT_ACQUIRE_TIMEOUT_MS) || DEFAULT_ACQUIRE_TIMEOUT_MS;

/** knexfile's connection (a URL string or a pg config object) plus extra pg options. */
function withPgOptions(connection: Knex.Config['connection'], extra: Record<string, unknown>): Knex.Config['connection'] {
  if (typeof connection === 'string') return { connectionString: connection, ...extra } as Knex.Config['connection'];
  if (connection && typeof connection === 'object') return { ...(connection as object), ...extra } as Knex.Config['connection'];
  return connection;
}

// A database outage makes the pool retry every 200 ms: one log line per window.
const POOL_LOG_THROTTLE_MS = 10_000;
let lastCreateFailLog = 0;

const runtimeConfig: Knex.Config = {
  ...knexConfig,
  // pg sends statement_timeout as a startup parameter: no extra round trip per
  // connection and no window where a fresh connection runs without it.
  connection: statementTimeoutMs > 0
    ? withPgOptions(knexConfig.connection, { statement_timeout: statementTimeoutMs })
    : knexConfig.connection,
  pool: {
    ...knexConfig.pool,
    acquireTimeoutMillis: acquireTimeoutMs,
    afterCreate(conn: { on(event: 'error', cb: (err: Error) => void): void }, done: (err: Error | null, conn: unknown) => void) {
      // knex marks the connection disposed on 'error'; log why it went away
      // (server restart, network cut, idle_session_timeout...).
      conn.on('error', (err) => logger.warn({ err }, 'Database connection error (connection discarded)'));
      done(null, conn);
    },
  },
};

export const db = knex(runtimeConfig);

const pool = (db.client as { pool?: { on(event: string, cb: (...args: unknown[]) => void): void } }).pool;
pool?.on('createFail', (_eventId, err) => {
  const now = Date.now();
  if (now - lastCreateFailLog < POOL_LOG_THROTTLE_MS) return;
  lastCreateFailLog = now;
  logger.error({ err }, 'Database connection failed');
});

// Migrations (index.ts runs db.migrate.latest() at boot) may legitimately run
// longer than the request statement timeout (index builds on ip_events...):
// they go through a dedicated no-timeout handle, opened on first use and
// closed with db.destroy().
let migrationDb: Knex | null = null;
if (statementTimeoutMs > 0) {
  Object.defineProperty(db, 'migrate', {
    configurable: true,
    get(): Knex.Migrator {
      migrationDb ??= knex({ ...knexConfig, pool: { ...knexConfig.pool, min: 0, max: 2 } });
      return migrationDb.migrate;
    },
  });
  const destroyRuntime = db.destroy.bind(db) as () => Promise<void>;
  // knex defines its methods non-writable but configurable.
  Object.defineProperty(db, 'destroy', {
    configurable: true,
    value: async (): Promise<void> => {
      const m = migrationDb;
      migrationDb = null;
      await Promise.all([destroyRuntime(), m?.destroy()]);
    },
  });
}

/**
 * Runs `fn` in a transaction with the statement timeout lifted (SET LOCAL:
 * the connection returns to the pool with its default). For known long jobs
 * (retention purges, bulk wipes), never for request-driven reads.
 */
export async function withoutStatementTimeout<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.raw('SET LOCAL statement_timeout = 0');
    return fn(trx);
  });
}
