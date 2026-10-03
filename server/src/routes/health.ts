import { readFileSync } from 'fs';
import { join } from 'path';
import type { Request, Response, RequestHandler } from 'express';
import { db } from '../db';
import { logger } from '../utils/logger';

/**
 * GET /health — public liveness + readiness probe (Docker healthcheck, load
 * balancers, the login page which shows `version`). 200 when the database
 * answers SELECT 1, 503 otherwise; the body is the same JSON in both cases.
 *
 * Mounted by app.ts: app.get('/health', healthHandler).
 */

/** Longest a probe waits for the database (pool acquisition included). */
export const HEALTH_DB_TIMEOUT_MS = 3_000;
/**
 * The route is public and not rate limited (rateLimiter skips /health):
 * concurrent and back-to-back probes share one database round trip.
 */
export const HEALTH_CACHE_MS = 2_000;

export interface HealthHandlerOptions {
  version?: string;
  /** Resolves when the database is reachable, rejects otherwise. */
  ping?: () => Promise<unknown>;
  timeoutMs?: number;
  cacheMs?: number;
}

function readServerVersion(): string {
  // process.cwd() is the server directory in dev (npx tsx) and Docker (WORKDIR /app/server).
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? 'dev';
  } catch {
    return 'dev';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`database did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function createHealthHandler(opts: HealthHandlerOptions = {}): RequestHandler {
  const version = opts.version ?? readServerVersion();
  const ping = opts.ping ?? (() => db.raw('SELECT 1'));
  const timeoutMs = opts.timeoutMs ?? HEALTH_DB_TIMEOUT_MS;
  const cacheMs = opts.cacheMs ?? HEALTH_CACHE_MS;

  let inFlight: Promise<boolean> | null = null;
  let last: { ok: boolean; at: number } | null = null;
  let lastLoggedOk = true;

  const check = (): Promise<boolean> => {
    if (last && Date.now() - last.at < cacheMs) return Promise.resolve(last.ok);
    inFlight ??= withTimeout(Promise.resolve().then(ping), timeoutMs)
      .then(() => true, (err: unknown) => {
        // Log transitions only: a down database is probed every few seconds.
        if (lastLoggedOk) logger.error({ err }, 'Health check: database unreachable');
        return false;
      })
      .then((ok) => {
        if (ok && !lastLoggedOk) logger.info('Health check: database reachable again');
        lastLoggedOk = ok;
        last = { ok, at: Date.now() };
        inFlight = null;
        return ok;
      });
    return inFlight;
  };

  return (_req: Request, res: Response) => {
    void check().then((ok) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'error',
        version,
        database: ok ? 'ok' : 'unreachable',
        timestamp: new Date().toISOString(),
      });
    });
  };
}

export const healthHandler = createHealthHandler();
