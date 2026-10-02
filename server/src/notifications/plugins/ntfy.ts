import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';
import { statusIcon } from '../statusIcons';

const TAGS: Record<string, string> = {
  up: 'white_check_mark',
  alert: 'large_orange_circle',
  ssl_warning: 'warning',
  inactive: 'black_circle',
  value_changed: 'arrows_counterclockwise',
};

export const ntfyPlugin: NotificationPlugin = {
  type: 'ntfy',
  name: 'ntfy',
  description: 'Send via ntfy.sh or self-hosted ntfy',
  configFields: [
    { key: 'serverUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'https://ntfy.sh' },
    { key: 'topic', label: 'Topic', type: 'text', required: true, placeholder: 'my-security-alerts' },
    { key: 'token', label: 'Access Token (optional)', type: 'password' },
    { key: 'priority', label: 'Priority (1-5)', type: 'number', placeholder: '3' },
  ],

  // Published as JSON to the server root rather than with X-Title headers:
  // header values must be Latin-1 (the status emoji made fetch throw) and must
  // never carry agent-controlled text.
  async send(config, payload: IpsNotificationPayload) {
    const icon = statusIcon(payload.newStatus);
    const prefix = payload.appName || 'Obliguard';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`;

    const priority = Math.min(5, Math.max(1, Number(config.priority) || 3));
    const message = payload.kind
      ? (payload.message ?? payload.title ?? payload.monitorName)
      : `${payload.oldStatus} → ${payload.newStatus}${payload.message ? `\n${payload.message}` : ''}`;
    const link = payload.url ?? payload.monitorUrl;

    const body: Record<string, unknown> = {
      topic: String(config.topic),
      title: `[${prefix}] ${icon} ${payload.title ?? payload.monitorName}`,
      message,
      priority,
      tags: [TAGS[payload.newStatus] ?? 'rotating_light'],
    };
    if (link && /^https?:\/\//i.test(link)) body.click = link;

    const res = await fetch(`${String(config.serverUrl).replace(/\/+$/, '')}/`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
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
