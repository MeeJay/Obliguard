import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';
import { statusIcon } from '../statusIcons';

export const freemobilePlugin: NotificationPlugin = {
  type: 'freemobile',
  name: 'Free Mobile SMS',
  description: 'Send SMS via Free Mobile API (France)',
  configFields: [
    { key: 'userId', label: 'User ID', type: 'text', required: true, placeholder: '12345678' },
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
  ],

  async send(config, payload: IpsNotificationPayload) {
    const icon = statusIcon(payload.newStatus);
    const prefix = payload.appName || 'Obliguard';
    const msg = payload.kind
      ? `[${prefix}] ${icon} ${payload.message ?? payload.title ?? payload.monitorName}`
      : `[${prefix}] ${icon} ${payload.monitorName}: ${payload.oldStatus} → ${payload.newStatus}${payload.message ? ` - ${payload.message}` : ''}`;

    const params = new URLSearchParams({
      user: String(config.userId),
      pass: String(config.apiKey),
      msg,
    });

    const res = await fetch(`https://smsapi.free-mobile.fr/sendmsg?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Free Mobile returned ${res.status}`);
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
