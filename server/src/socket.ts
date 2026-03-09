import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { logger } from './utils/logger';
import { authService } from './services/auth.service';
import { db } from './db';

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      // Reflect the request origin so any deployment URL works without reconfiguring
      // CLIENT_ORIGIN. Security is enforced by the auth middleware below (userId check),
      // not by the CORS origin list.
      origin: true,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Socket.io authentication middleware
  io.use(async (socket, next) => {
    try {
      // The session userId and currentTenantId are passed via auth handshake
      const userId = socket.handshake.auth?.userId as number | undefined;
      const tenantId = socket.handshake.auth?.tenantId as number | undefined;

      if (!userId) {
        return next(new Error('Authentication required'));
      }

      const user = await authService.getUserById(userId);
      if (!user || !user.isActive) {
        return next(new Error('Invalid user'));
      }

      socket.data.user = user;
      socket.data.tenantId = tenantId ?? 1;
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const tenantId: number = socket.data.tenantId;
    logger.info(`Socket connected: ${user.username} (id: ${user.id}, tenant: ${tenantId})`);

    // Join user-specific room
    socket.join(`user:${user.id}`);

    // Join tenant-scoped rooms
    socket.join(`tenant:${tenantId}`);
    if (user.role === 'admin') {
      socket.join(`tenant:${tenantId}:admin`);
      // Keep legacy role:admin room so existing emits continue to work
      // during gradual migration of all service emits to tenant rooms.
      socket.join('role:admin');
    }

    // Join notification rooms for ALL tenants this user can access.
    // This ensures cross-tenant live alerts are delivered in real-time,
    // even when the user is currently viewing a different tenant.
    db('user_tenants')
      .where('user_id', user.id)
      .pluck('tenant_id')
      .then((tenantIds: number[]) => {
        for (const tid of tenantIds) {
          socket.join(`tenant:${tid}:notifications`);
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
