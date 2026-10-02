import './env';
import http from 'http';
import { createApp } from './app';
import { createSocketServer } from './socket';
import { db } from './db';
import { config } from './config';
import { logger } from './utils/logger';
import { authService } from './services/auth.service';
import { setAgentServiceIO, agentService } from './services/agent.service';
import { setLiveAlertIO } from './services/liveAlert.service';
import { setUserSessionsIO } from './services/userSessions.service';
import { banEngine, banService, setBanServiceIO } from './services/ban.service';
import { attachAgentWebSocket } from './services/agentWsGate';
import { obligateService } from './services/obligate.service';

async function main() {
  // 1. Run pending migrations
  logger.info('Running database migrations...');
  await db.migrate.latest();
  logger.info('Migrations complete');

  // 2. Ensure default admin user exists
  await authService.ensureDefaultAdmin(
    config.defaultAdminUsername,
    config.defaultAdminPassword,
  );

  // 3. Create Express app
  const app = createApp();

  // 4. Create HTTP server
  const server = http.createServer(app);

  // 5. Attach Socket.io
  const io = createSocketServer(server);
  app.set('io', io);

  // Provide io to services for real-time push events
  setAgentServiceIO(io);
  setLiveAlertIO(io);
  setUserSessionsIO(io);
  setBanServiceIO(io);

  // ── Obliguard agent WebSocket command channel ────────────────────────────
  // The agent WS endpoint shares the REST port: attachAgentWebSocket takes over
  // the 'upgrade' routing (/api/agent/ws → pre-upgrade gate, everything else →
  // Socket.io). See services/agentWsGate.ts.
  const agentWss = attachAgentWebSocket(server);
  // ─────────────────────────────────────────────────────────────────────────

  // 6. Start BanEngine — evaluates IP thresholds and enforces bans every 30s
  banEngine.start();

  // 7. Start MikroTik pollers (log pull via API + address-list import)
  const { mikrotikLogPoller } = await import('./services/mikrotik/mikrotikLogPoller.service');
  mikrotikLogPoller.start();
  const { mikrotikImport } = await import('./services/mikrotik/mikrotikImport.service');
  mikrotikImport.start();
  // Hourly reconciliation of every router's address-list with its tenant's bans
  const { mikrotikBanSync } = await import('./services/mikrotik/mikrotikBanSync.service');
  mikrotikBanSync.startReconciler();

  // 8. Listen
  server.listen(config.port, () => {
    logger.info(`Obliguard server listening on port ${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);

    // Sync capability schemas with Obligate (non-blocking)
    obligateService.syncCapabilitySchemas().catch(() => {});
  });

  // 8. ip_events retention job — purge events older than configured days every 6 hours.
  // Env-overridable: Obliguard's connection/auth firehose fills ip_events fast, so a
  // shorter window (e.g. 30) keeps the table — and every query over it — lean.
  const IP_EVENTS_RETENTION_DAYS = Number(process.env.IP_EVENTS_RETENTION_DAYS) || 90;
  const retentionTimer = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - IP_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const deleted = await db('ip_events').where('timestamp', '<', cutoff).delete();
      if (deleted > 0) {
        logger.info(`Retention: purged ${deleted} ip_events older than ${IP_EVENTS_RETENTION_DAYS} days`);
      }
    } catch (err) {
      logger.error(err, 'ip_events retention job failed');
    }
  }, 6 * 60 * 60 * 1000);

  // 9. Agent cleanup job — auto-delete devices whose uninstall command was delivered
  const agentCleanupTimer = setInterval(async () => {
    try {
      await agentService.cleanupUninstalledDevices();
      await agentService.cleanupStuckUpdating();
    } catch (err) {
      logger.error(err, 'Agent cleanup job failed');
    }
  }, 5 * 60 * 1000);

  // 10. ip_bans expiry job — every 5 minutes, through banService.deactivateBans
  // (lifted_at stamped, announced as ban:lifted, removed from MikroTik routers)
  const banExpiryTimer = setInterval(async () => {
    try {
      const expired = await banService.expireBans();
      if (expired > 0) {
        logger.info(`BanExpiry: deactivated ${expired} expired bans`);
      }
    } catch (err) {
      logger.error(err, 'Ban expiry job failed');
    }
  }, 5 * 60 * 1000);

  // 11. Remote blocklist sync — every 10 minutes
  const { remoteBlocklistService } = await import('./services/remoteBlocklist.service');
  const remoteBlocklistTimer = setInterval(async () => {
    try {
      await remoteBlocklistService.syncAll();
    } catch (err) {
      logger.error(err, 'Remote blocklist sync failed');
    }
    // Separate try: pushNewBans throws on upstream failure and must not be
    // reported as a sync failure.
    try {
      await remoteBlocklistService.pushNewBans();
    } catch (err) {
      logger.error(err, 'obli.tools push failed');
    }
  }, 10 * 60 * 1000);

  // 12. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // ignore a second signal mid-shutdown
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);

    // Last resort: never let a stuck close()/destroy() block the exit forever.
    const hardExit = setTimeout(() => {
      logger.warn('shutdown: forced exit after 10s timeout');
      process.exit(0);
    }, 10_000);
    hardExit.unref();

    clearInterval(retentionTimer);
    clearInterval(agentCleanupTimer);
    clearInterval(banExpiryTimer);
    clearInterval(remoteBlocklistTimer);
    banEngine.stop();
    mikrotikBanSync.stopReconciler();

    // Stop accepting new work BEFORE tearing down the DB pool.
    try { agentWss.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }

    // Destroy the pool last. Any in-flight query (e.g. an agent heartbeat) gets
    // aborted here — that's EXPECTED on shutdown; swallow the resulting "aborted"
    // rejection so it can't escape and crash the process before we exit cleanly
    // (previously this produced an uncaught Error: aborted and a hard crash).
    try {
      await db.destroy();
    } catch (err) {
      logger.warn({ err }, 'shutdown: db.destroy() aborted in-flight queries (expected)');
    }

    clearTimeout(hardExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Safety nets: a stray promise rejection or sync throw must NOT silently kill
  // the whole server (and take every agent's WS channel down with it).
  // - unhandledRejection: log and keep serving (usually a single recoverable op).
  // - uncaughtException: log and exit so the orchestrator (Docker restart policy)
  //   restarts us cleanly rather than running on with corrupt state.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection (server kept running)');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal(err, 'Uncaught exception — exiting for a clean restart');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start Obliguard server');
  process.exit(1);
});
