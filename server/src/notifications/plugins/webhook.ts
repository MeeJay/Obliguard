import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';

export const webhookPlugin: NotificationPlugin = {
  type: 'webhook',
  name: 'Webhook',
  description: 'Send JSON POST to a URL',
  configFields: [
    { key: 'url', label: 'Webhook URL', type: 'url', required: true, placeholder: 'https://...' },
    { key: 'secret', label: 'Secret Header (optional)', type: 'password', placeholder: 'Bearer token or secret' },
  ],

  // The JSON body is the whole payload: legacy fields (monitorName,
  // oldStatus, newStatus, message) plus the IPS fields (kind, title, ip,
  // service, failureCount, username, agentName, tenantName, url).
  async send(config, payload: IpsNotificationPayload) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.secret) headers['Authorization'] = String(config.secret);

    const res = await fetch(String(config.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
  },

  async sendTest(config) {
    const payload: IpsNotificationPayload = {
      monitorName: 'Obliguard',
      oldStatus: 'up',
      newStatus: 'up',
      kind: 'test',
      title: 'Test notification',
      message: 'This is a test notification from Obliguard',
      timestamp: new Date().toISOString(),
    };
    await this.send(config, payload);
  },
};
