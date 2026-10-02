import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';
import { statusIcon } from '../statusIcons';

// parse_mode HTML: payload text (agent names, usernames from logs) must be
// escaped, or a crafted value injects markup or breaks the message.
function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const telegramPlugin: NotificationPlugin = {
  type: 'telegram',
  name: 'Telegram',
  description: 'Send to a Telegram chat via bot',
  configFields: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: '123456:ABC-DEF...' },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true, placeholder: '-1001234567890' },
  ],

  async send(config, payload: IpsNotificationPayload) {
    const icon = statusIcon(payload.newStatus);
    const link = payload.url ?? payload.monitorUrl;
    const text = (payload.kind
      ? [
          `${icon} <b>${esc(payload.title ?? payload.monitorName)}</b>`,
          payload.message ? esc(payload.message) : '',
          payload.username ? `Username: <code>${esc(payload.username)}</code>` : '',
          link ? `\n🔗 ${esc(link)}` : '',
        ]
      : [
          `${icon} <b>${esc(payload.monitorName)}</b>`,
          `Status: <b>${esc(payload.oldStatus.toUpperCase())}</b> → <b>${esc(payload.newStatus.toUpperCase())}</b>`,
          payload.message ? `\n${esc(payload.message)}` : '',
          link ? `\n🔗 ${esc(link)}` : '',
        ]
    ).filter(Boolean).join('\n');

    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Telegram returned ${res.status}: ${await res.text()}`);
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
