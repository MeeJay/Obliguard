import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';
import { assertPinnedHost, guardedFetch, TEAMS_HOSTS } from './outbound';

// Adaptive Card TextBlocks and facts render a Markdown subset. Payload text
// partly comes from agent logs (usernames, hostnames): escape the Markdown
// characters so a crafted value cannot format text or forge links.
function md(s: unknown, max = 2000): string {
  return String(s).replace(/([\\`*_~[\]<>#])/g, '\\$1').slice(0, max);
}

function httpUrl(u: string | undefined): string | undefined {
  return u && /^https?:\/\//i.test(u) ? u : undefined;
}

interface StatusInfo {
  emoji: string;
  label: string;
  containerStyle: 'good' | 'attention' | 'warning' | 'emphasis' | 'default';
}

function getStatusInfo(status: string): StatusInfo {
  switch (status) {
    case 'up':
      return { emoji: '🟢', label: 'Up', containerStyle: 'good' };
    case 'down':
      return { emoji: '🔴', label: 'Down', containerStyle: 'attention' };
    case 'ssl_expired':
      return { emoji: '🔴', label: 'SSL Expired', containerStyle: 'attention' };
    case 'ssl_warning':
      return { emoji: '⚠️', label: 'SSL Warning', containerStyle: 'warning' };
    case 'value_changed':
      return { emoji: '🔄', label: 'Value Changed', containerStyle: 'emphasis' };
    case 'alert':
      return { emoji: '🟠', label: 'Alert', containerStyle: 'warning' };
    case 'inactive':
      return { emoji: '⚫', label: 'Inactive', containerStyle: 'default' };
    default:
      return { emoji: '❓', label: status, containerStyle: 'default' };
  }
}

export function buildAdaptiveCard(payload: IpsNotificationPayload): Record<string, unknown> {
  const { emoji, containerStyle } = getStatusInfo(payload.newStatus);
  const link = httpUrl(payload.url ?? payload.monitorUrl);

  const title = payload.isGroupNotification
    ? `${emoji} Group Alert — ${md(payload.groupName ?? '')}`
    : `${emoji} ${md(payload.title ?? payload.monitorName, 300)}`;

  const subtitle = payload.kind
    ? md(payload.message ?? '')
    : payload.isGroupNotification
      ? `${payload.downMonitors?.length ?? 0} item(s) affected`
      : md(`${payload.oldStatus.toUpperCase()} → ${payload.newStatus.toUpperCase()}`);

  const facts: { title: string; value: string }[] = [];

  if (payload.kind) {
    if (payload.agentName) facts.push({ title: 'Agent', value: md(payload.agentName) });
    if (payload.tenantName) facts.push({ title: 'Workspace', value: md(payload.tenantName) });
    if (payload.ip) facts.push({ title: 'IP', value: md(payload.ip) });
    if (payload.service) facts.push({ title: 'Service', value: md(payload.service) });
    if (payload.failureCount !== undefined) facts.push({ title: 'Failures', value: String(payload.failureCount) });
    if (payload.username) facts.push({ title: 'Username', value: md(payload.username) });
  } else {
    if (!payload.isGroupNotification) {
      facts.push({
        title: 'Status',
        value: md(`${payload.oldStatus.toUpperCase()} → ${payload.newStatus.toUpperCase()}`),
      });
    }
    if (payload.message) {
      facts.push({ title: 'Details', value: md(payload.message) });
    }
  }

  if (link) {
    facts.push({ title: 'URL', value: md(link) });
  }

  if (payload.isGroupNotification && payload.downMonitors?.length) {
    facts.push({ title: 'Affected', value: md(payload.downMonitors.join(', ')) });
  }

  facts.push({
    title: 'Time',
    value: new Date(payload.timestamp).toLocaleString('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }),
  });

  if (payload.appName) {
    facts.push({ title: 'Source', value: md(payload.appName) });
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'Container',
              style: containerStyle,
              bleed: true,
              items: [
                {
                  type: 'ColumnSet',
                  columns: [
                    {
                      type: 'Column',
                      width: 'stretch',
                      items: [
                        {
                          type: 'TextBlock',
                          text: title,
                          weight: 'Bolder',
                          size: 'Medium',
                          wrap: true,
                        },
                        {
                          type: 'TextBlock',
                          text: subtitle,
                          spacing: 'None',
                          isSubtle: true,
                          wrap: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            ...(facts.length > 0
              ? [{ type: 'FactSet', facts }]
              : []),
          ],
          ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open', url: link }] } : {}),
          msteams: { width: 'Full' },
        },
      },
    ],
  };
}

export const teamsPlugin: NotificationPlugin = {
  type: 'teams',
  name: 'Microsoft Teams',
  description: 'Send to a Teams channel via Incoming Webhook (Adaptive Cards)',

  configFields: [
    {
      key: 'webhookUrl',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      placeholder: 'https://xxx.webhook.office.com/webhookb2/...',
    },
  ],

  async send(config, payload: IpsNotificationPayload) {
    const body = buildAdaptiveCard(payload);

    const target = assertPinnedHost(String(config.webhookUrl ?? ''), TEAMS_HOSTS, 'Teams');
    const res = await guardedFetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Teams returned ${res.status}${text ? `: ${text}` : ''}`);
    }
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
      appName: 'Obliguard',
    };
    await this.send(config, payload);
  },
};
