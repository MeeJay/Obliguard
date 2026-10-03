/**
 * CSV exports (UI-PAGES-IPS-20): the IP reputation, bans, whitelist and event
 * lists exported for reporting or a SIEM, with the same filters and the same
 * tenant / team scope as the list endpoints they mirror.
 *
 * Rules:
 *   - at most CSV_EXPORT_MAX data rows; a capped export answers
 *     `X-Truncated: true` (callers fetch CSV_EXPORT_MAX + 1 rows to know);
 *   - formula-injection safe: usernames, labels, reasons and raw log lines are
 *     attacker-controlled, so text starting with = + - @ (or a tab / carriage
 *     return) is prefixed with a quote and never evaluated by a spreadsheet;
 *   - `?anon=1` masks addresses, usernames, hostnames and raw logs the way the
 *     client's anonymous mode does (client/src/utils/anonymize.ts);
 *   - UTF-8 with a byte-order mark, CRLF rows (RFC 4180), so Excel opens
 *     accented names correctly (same output as client utils/download saveCsv).
 */
import type { Response } from 'express';

/** Largest number of data rows a single export returns. */
export const CSV_EXPORT_MAX = 50_000;

/** Response header set to 'true' when the export hit CSV_EXPORT_MAX. */
export const CSV_TRUNCATED_HEADER = 'X-Truncated';

export type CsvCell = string | number | boolean | Date | null | undefined;

/**
 * One CSV field: quoted when it holds a separator, a quote or a line break;
 * text starting with = + - @ \t \r gets a leading quote (formula injection).
 * Numbers are emitted as is (a negative number is not a formula).
 */
export function csvField(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let s = value instanceof Date ? (Number.isNaN(value.getTime()) ? '' : value.toISOString()) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A CSV document: header first, CRLF rows, trailing CRLF. */
export function toCsv(headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** A timestamp column value (Date, ISO string or null) as ISO 8601. */
export function csvDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/** `?anon=1` (or true): the caller's anonymous mode is on. */
export function wantsAnon(query: Record<string, unknown>): boolean {
  return query.anon === '1' || query.anon === 'true';
}

// ── Anonymisation (mirrors client/src/utils/anonymize.ts) ────────────────────

/** "192.168.1.42" → "192.•••.•.••", IPv6 → first group + "••••" groups; a CIDR suffix is kept. */
export function anonIp(value: string | null | undefined): string {
  if (!value) return '';
  let ip = value;
  let cidr = '';
  const slash = value.indexOf('/');
  if (slash !== -1) {
    cidr = value.slice(slash);
    ip = value.slice(0, slash);
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts[0] + ':' + parts.slice(1).map(() => '••••').join(':') + cidr;
  }
  const parts = ip.split('.');
  return parts[0] + '.' + parts.slice(1).map((p) => '•'.repeat(p.length)).join('.') + cidr;
}

/** "admin" → "a••••". */
export function anonUsername(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 1) return '•';
  return value[0] + '•'.repeat(Math.min(value.length - 1, 6));
}

/** "srv-prod-01" → "srv-•••••••". */
export function anonHostname(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 3) return '•••';
  return value.slice(0, 3) + '•'.repeat(Math.min(value.length - 3, 8));
}

/** A raw log line never leaves in anonymous mode. */
export function anonLog(value: string | null | undefined): string {
  return value ? '••• [anonymized log] •••' : '';
}

/** The maskers to apply to one export (identity when anonymous mode is off). */
export interface CsvMaskers {
  ip: (v: string | null | undefined) => string;
  username: (v: string | null | undefined) => string;
  hostname: (v: string | null | undefined) => string;
  log: (v: string | null | undefined) => string;
}

const plain = (v: string | null | undefined): string => v ?? '';

export function csvMaskers(anon: boolean): CsvMaskers {
  return anon
    ? { ip: anonIp, username: anonUsername, hostname: anonHostname, log: anonLog }
    : { ip: plain, username: plain, hostname: plain, log: plain };
}

// ── Response ─────────────────────────────────────────────────────────────────

/** `obliguard-<base>-YYYY-MM-DD-HH-MM-SS.csv` (UTC). */
export function csvFilename(base: string): string {
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return `obliguard-${base}-${ts}.csv`;
}

/**
 * Send `rows` (already cut to CSV_EXPORT_MAX) as a CSV attachment.
 * `truncated`: more rows matched the filter than were exported.
 */
export function sendCsv(
  res: Response,
  opts: { filename: string; headers: ReadonlyArray<string>; rows: ReadonlyArray<ReadonlyArray<CsvCell>>; truncated: boolean },
): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${opts.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(CSV_TRUNCATED_HEADER, opts.truncated ? 'true' : 'false');
  res.setHeader('X-Export-Rows', String(opts.rows.length));
  // Readable by a cross-origin client too (CORS hides non-safelisted headers).
  res.setHeader('Access-Control-Expose-Headers', `Content-Disposition, ${CSV_TRUNCATED_HEADER}, X-Export-Rows`);
  res.send(`﻿${toCsv(opts.headers, opts.rows)}`);
}
