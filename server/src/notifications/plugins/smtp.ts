import type { NotificationPlugin } from '../types';
import type { IpsNotificationPayload } from '../../services/notification.service';
import nodemailer from 'nodemailer';
import { statusIcon } from '../statusIcons';

// SECURITY: HTML-escape every payload string before it lands in the e-mail
// body. Agent names, usernames and services come from agents and their logs,
// so an attacker controls them (a username of `<img src=x onerror=…>` would
// otherwise render in any mail client that displays HTML).
export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// URLs end up in `href`: http/https only, anything else (javascript:, data:,
// …) becomes an inert '#'.
export function safeHref(url: string): string {
  const u = String(url).trim();
  if (/^https?:\/\//i.test(u)) return escapeHtml(u);
  return '#';
}

/** Subject line: no CR/LF (header injection) and bounded length. */
function oneLine(s: string, max = 200): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, max);
}

/** Subject, plain-text and HTML bodies of a notification e-mail. */
export function buildSmtpMessage(payload: IpsNotificationPayload): { subject: string; text: string; html: string } {
  const icon = statusIcon(payload.newStatus);
  const prefix = payload.appName ? `[${payload.appName}] ` : '';
  const link = payload.url ?? payload.monitorUrl;

  if (payload.kind) {
    const facts: Array<[string, string | number | undefined]> = [
      ['Agent', payload.agentName],
      ['Workspace', payload.tenantName],
      ['IP', payload.ip],
      ['Service', payload.service],
      ['Failures', payload.failureCount],
      ['Username', payload.username],
    ];
    const present = facts.filter(([, v]) => v !== undefined && v !== null && v !== '') as Array<[string, string | number]>;
    const title = payload.title ?? payload.monitorName;
    return {
      subject: oneLine(`${icon} ${prefix}${title}`),
      text: [
        payload.message ?? title,
        '',
        ...present.map(([k, v]) => `${k}: ${v}`),
        link ? `URL: ${link}` : '',
        `Time: ${payload.timestamp}`,
      ].filter((l, i) => l !== '' || i === 1).join('\n'),
      html: [
        `<h2>${escapeHtml(icon)} ${escapeHtml(title)}</h2>`,
        payload.message ? `<p>${escapeHtml(payload.message)}</p>` : '',
        present.length > 0
          ? `<table>${present.map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>`
          : '',
        link ? `<p><a href="${safeHref(link)}">${escapeHtml(link)}</a></p>` : '',
        `<p><small>${escapeHtml(payload.timestamp)}</small></p>`,
      ].filter(Boolean).join('\n'),
    };
  }

  return {
    subject: oneLine(`${icon} ${prefix}${payload.monitorName} is ${payload.newStatus.toUpperCase()}`),
    text: [
      `Name: ${payload.monitorName}`,
      `Status: ${payload.oldStatus} → ${payload.newStatus}`,
      payload.message ? `Message: ${payload.message}` : '',
      link ? `URL: ${link}` : '',
      `Time: ${payload.timestamp}`,
    ].filter(Boolean).join('\n'),
    html: [
      `<h2>${escapeHtml(icon)} ${escapeHtml(payload.monitorName)}</h2>`,
      `<p><strong>Status:</strong> ${escapeHtml(payload.oldStatus)} → <strong>${escapeHtml(payload.newStatus.toUpperCase())}</strong></p>`,
      payload.message ? `<p>${escapeHtml(payload.message)}</p>` : '',
      link ? `<p><a href="${safeHref(link)}">${escapeHtml(link)}</a></p>` : '',
      `<p><small>${escapeHtml(payload.timestamp)}</small></p>`,
    ].filter(Boolean).join('\n'),
  };
}

export const smtpPlugin: NotificationPlugin = {
  type: 'smtp',
  name: 'Email (SMTP)',
  description: 'Send email notifications via a global SMTP server',
  configFields: [
    { key: 'smtpServerId', label: 'SMTP Server', type: 'smtp_server_select', required: true },
    { key: 'fromOverride', label: 'From Address Override', type: 'text', required: false, placeholder: 'Leave blank to use server default' },
    { key: 'to', label: 'To Address(es)', type: 'text', required: true, placeholder: 'admin@example.com' },
  ],

  // config here is the RESOLVED config (host/port/etc injected by resolveChannelConfig)
  async send(config, payload: IpsNotificationPayload) {
    const transport = nodemailer.createTransport({
      host: String(config.host),
      port: Number(config.port),
      secure: Boolean(config.secure),
      auth: {
        user: String(config.username),
        pass: String(config.password),
      },
    });

    const { subject, text, html } = buildSmtpMessage(payload);
    await transport.sendMail({
      from: String(config.from),
      to: String(config.to),
      subject,
      text,
      html,
    });
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
