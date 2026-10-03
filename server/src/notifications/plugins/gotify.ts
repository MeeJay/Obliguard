import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';
import { statusIcon } from '../statusIcons';
import { assertNotificationTarget, guardedFetch } from './outbound';

export const gotifyPlugin: NotificationPlugin = {
  type: 'gotify',
  name: 'Gotify',
  description: 'Send via Gotify push notification server',
  configFields: [
    { key: 'serverUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'https://gotify.example.com' },
    { key: 'appToken', label: 'Application Token', type: 'password', required: true },
    { key: 'priority', label: 'Priority (0-10)', type: 'number', placeholder: '5' },
  ],

  // Gotify renders plain text (no markdown extras are sent).
  async send(config, payload: IpsNotificationPayload) {
    const icon = statusIcon(payload.newStatus);
    const prefix = payload.appName || 'Obliguard';
    const url = `${String(config.serverUrl).replace(/\/$/, '')}/message`;
    const message = payload.kind
      ? (payload.message ?? payload.title ?? payload.monitorName)
      : `${payload.oldStatus} → ${payload.newStatus}${payload.message ? `\n${payload.message}` : ''}`;

    // Self-hosted on the LAN more often than not: private targets are allowed
    // unless NOTIFICATION_ALLOW_PRIVATE_TARGETS=false.
    const target = await assertNotificationTarget(`${url}?token=${encodeURIComponent(String(config.appToken))}`, { privateByDefault: true });
    const res = await guardedFetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `[${prefix}] ${icon} ${payload.title ?? payload.monitorName}`,
        message,
        priority: Number(config.priority) || 5,
      }),
    });
    if (!res.ok) throw new Error(`Gotify returned ${res.status}`);
  },

  async sendTest(config) {
    const payload: IpsNotificationPayload = {
      monitorName: 'Obliguard',
      oldStatus: 'up',
      newStatus: 'up',
      kind: 'test',
      title: 'Test notification',
      message: 'Test from Obliguard',
      timestamp: new Date().toISOString(),
    };
    await this.send(config, payload);
  },
};
