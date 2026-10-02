import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';
import { statusIcon } from '../statusIcons';

export const pushoverPlugin: NotificationPlugin = {
  type: 'pushover',
  name: 'Pushover',
  description: 'Send via Pushover push notifications',
  configFields: [
    { key: 'userKey', label: 'User Key', type: 'password', required: true },
    { key: 'appToken', label: 'Application Token', type: 'password', required: true },
    { key: 'priority', label: 'Priority (-2 to 2)', type: 'number', placeholder: '0' },
  ],

  // Plain text (html=0): no markup to escape. Pushover limits: title 250, message 1024.
  async send(config, payload: IpsNotificationPayload) {
    const icon = statusIcon(payload.newStatus);
    const prefix = payload.appName || 'Obliguard';
    const message = payload.kind
      ? (payload.message ?? payload.title ?? payload.monitorName)
      : `${payload.oldStatus} → ${payload.newStatus}${payload.message ? `\n${payload.message}` : ''}`;
    const link = payload.url ?? payload.monitorUrl;

    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: config.appToken,
        user: config.userKey,
        title: `[${prefix}] ${icon} ${payload.title ?? payload.monitorName}`.slice(0, 250),
        message: message.slice(0, 1024),
        priority: Number(config.priority) || 0,
        url: link && /^https?:\/\//i.test(link) ? link : undefined,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Pushover returned ${res.status}`);
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
