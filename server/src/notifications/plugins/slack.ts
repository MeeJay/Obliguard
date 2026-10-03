import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';
import { assertPinnedHost, guardedFetch, SLACK_HOSTS } from './outbound';

// Slack mrkdwn control characters: &, < and > build links and mentions
// (<!channel>, <url|text>). Payload text partly comes from agent logs, so
// they are always entity-escaped.
function mrkdwn(s: unknown, max = 2900): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, max);
}

export const slackPlugin: NotificationPlugin = {
  type: 'slack',
  name: 'Slack',
  description: 'Send to a Slack channel via webhook',
  configFields: [
    { key: 'webhookUrl', label: 'Slack Webhook URL', type: 'url', required: true, placeholder: 'https://hooks.slack.com/services/...' },
    { key: 'channel', label: 'Channel (optional)', type: 'text', placeholder: '#security' },
  ],

  async send(config, payload: IpsNotificationPayload) {
    const slackIcons: Record<string,string> = { up: ':white_check_mark:', alert: ':large_orange_circle:', ssl_warning: ':warning:', inactive: ':black_circle:', value_changed: ':arrows_counterclockwise:' };
    const icon = slackIcons[payload.newStatus] ?? ':red_circle:';
    const colorMap: Record<string,string> = { up: '#2ecc71', alert: '#e67e22', ssl_warning: '#f39c12', ssl_expired: '#e74c3c', inactive: '#95a5a6', value_changed: '#3498db' };
    const color = colorMap[payload.newStatus] ?? '#e74c3c';
    const link = payload.url ?? payload.monitorUrl;
    const safeLink = link && /^https?:\/\//i.test(link) ? link : undefined;

    const text = payload.kind
      ? [
          `${icon} *${mrkdwn(payload.title ?? payload.monitorName, 300)}*`,
          payload.message ? mrkdwn(payload.message) : '',
          payload.username ? `Username: \`${mrkdwn(payload.username, 200).replace(/`/g, "'")}\`` : '',
          safeLink ? `<${safeLink}|Open in ${mrkdwn(payload.appName || 'Obliguard', 50)}>` : '',
        ].filter(Boolean).join('\n')
      : `${icon} *${mrkdwn(payload.monitorName, 300)}*\nStatus: *${mrkdwn(payload.oldStatus)}* → *${mrkdwn(payload.newStatus)}*${payload.message ? `\n${mrkdwn(payload.message)}` : ''}`;

    const body: Record<string, unknown> = {
      attachments: [{
        color,
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text,
          },
        }],
      }],
    };
    if (config.channel) body.channel = config.channel;

    const target = assertPinnedHost(String(config.webhookUrl ?? ''), SLACK_HOSTS, 'Slack');
    const res = await guardedFetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Slack returned ${res.status}`);
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
