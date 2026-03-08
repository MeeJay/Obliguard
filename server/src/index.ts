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
import { banEngine } from './services/ban.service';

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

  // 6. Start BanEngine — evaluates IP thresholds and enforces bans every 30s
  banEngine.start();

  // 7. Listen
  server.listen(config.port, () => {
    logger.info(`Obliguard server listening on port ${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
  });

  // 8. ip_events retention job — purge events older than configured days every 6 hours
  const IP_EVENTS_RETENTION_DAYS = 90;
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

  // 10. ip_bans expiry job — mark expired bans as inactive every 5 minutes
  const banExpiryTimer = setInterval(async () => {
    try {
      const expired = await db('ip_bans')
        .where('is_active', true)
        .whereNotNull('expires_at')
        .where('expires_at', '<', new Date())
        .update({ is_active: false });
      if (expired > 0) {
        logger.info(`BanExpiry: deactivated ${expired} expired bans`);
      }
    } catch (err) {
      logger.error(err, 'Ban expiry job failed');
    }
  }, 5 * 60 * 1000);

  // 11. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    clearInterval(retentionTimer);
    clearInterval(agentCleanupTimer);
    clearInterval(banExpiryTimer);
    banEngine.stop();
    server.close();
    await db.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start Obliguard server');
  process.exit(1);
});
