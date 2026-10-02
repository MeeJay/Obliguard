import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';
import { statusIcon, STATUS_COLORS_HEX } from '../statusIcons';

// Payload text comes partly from agent logs (usernames, hostnames): escape
// Discord markdown and break @everyone/@here so a crafted value cannot
// format, link or ping. allowed_mentions below is the second guard.
function md(s: unknown, max = 1024): string {
  return String(s)
    .replace(/([\\`*_~|>#<[\]()-])/g, '\\$1')
    .replace(/@/g, '@​')
    .slice(0, max);
}

function httpUrl(u: string | undefined): string | undefined {
  return u && /^https?:\/\//i.test(u) ? u : undefined;
}

export const discordPlugin: NotificationPlugin = {
  type: 'discord',
  name: 'Discord',
  description: 'Send to a Discord channel via webhook',
  configFields: [
    { key: 'webhookUrl', label: 'Discord Webhook URL', type: 'url', required: true, placeholder: 'https://discord.com/api/webhooks/...' },
    { key: 'username', label: 'Bot Username (optional)', type: 'text', placeholder: 'Obliguard' },
  ],

  async send(config, payload: IpsNotificationPayload) {
    const link = httpUrl(payload.url ?? payload.monitorUrl);
    const fields: Array<{ name: string; value: string; inline: boolean }> = [];
    if (payload.kind) {
      if (payload.ip) fields.push({ name: 'IP', value: md(payload.ip), inline: true });
      if (payload.service) fields.push({ name: 'Service', value: md(payload.service), inline: true });
      if (payload.failureCount !== undefined) fields.push({ name: 'Failures', value: String(payload.failureCount), inline: true });
      if (payload.username) fields.push({ name: 'Username', value: md(payload.username), inline: true });
      if (payload.tenantName) fields.push({ name: 'Workspace', value: md(payload.tenantName), inline: true });
    } else {
      fields.push({ name: 'Status', value: md(payload.newStatus.toUpperCase()), inline: true });
      if (link) fields.push({ name: 'URL', value: link, inline: true });
    }

    const embed = {
      title: `${statusIcon(payload.newStatus)} ${md(payload.title ?? payload.monitorName, 240)}`,
      ...(link ? { url: link } : {}),
      description: payload.message
        ? md(payload.message, 4000)
        : `Status changed: **${md(payload.oldStatus)}** → **${md(payload.newStatus)}**`,
      color: STATUS_COLORS_HEX[payload.newStatus] ?? 0x95a5a6,
      fields,
      timestamp: payload.timestamp,
    };

    const body: Record<string, unknown> = { embeds: [embed], allowed_mentions: { parse: [] } };
    if (config.username) body.username = config.username;

    const res = await fetch(String(config.webhookUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Discord returned ${res.status}: ${await res.text()}`);
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
