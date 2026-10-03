/**
 * Browser file saving (ported from Obliance client/src/utils/download.ts,
 * without the Android-shell branch: Obliguard has no native bridge for
 * downloads).
 *
 * Never build `URL.createObjectURL` + `<a download>` in a page: revoking the
 * URL synchronously breaks some browsers (slow "Save as…" dialogs). Use
 * these helpers.
 *
 * None of them reject: they resolve `true` on success, `false` on failure
 * (already logged), so callers can toast on `false` if they care.
 */

import apiClient from '@/api/client';
import { isAnonymous } from '@/utils/anonymize';

const DEFAULT_MIME = 'application/octet-stream';
/** Blob URLs stay alive long enough for slow "Save as…" dialogs. */
const REVOKE_DELAY_MS = 60_000;

function clickAnchor(href: string, filename?: string): void {
  const a = document.createElement('a');
  a.href = href;
  if (filename !== undefined) a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Save a Blob as `filename` (anchor download with deferred revocation).
 * `mime` overrides `blob.type`.
 */
export async function saveBlob(blob: Blob, filename: string, mime?: string): Promise<boolean> {
  const type = mime || blob.type || DEFAULT_MIME;
  try {
    const typed = blob.type !== type ? new Blob([blob], { type }) : blob;
    const url = URL.createObjectURL(typed);
    clickAnchor(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    return true;
  } catch (err) {
    console.error('[download] saveBlob failed', err);
    return false;
  }
}

/** Save a string as a file (CSV, JSON, scripts, …). Default MIME: text/plain;charset=utf-8. */
export function saveText(text: string, filename: string, mime = 'text/plain;charset=utf-8'): Promise<boolean> {
  return saveBlob(new Blob([text], { type: mime }), filename, mime);
}

/** Save a value as pretty-printed JSON. */
export function saveJson(value: unknown, filename: string, space = 2): Promise<boolean> {
  return saveText(JSON.stringify(value, null, space), filename, 'application/json');
}

/**
 * Download an authenticated SAME-ORIGIN server route (Content-Disposition:
 * attachment) through `<a href download>` (no page navigation, no popup).
 */
export async function downloadUrl(url: string, filename?: string): Promise<boolean> {
  let absolute = url;
  try {
    absolute = new URL(url, window.location.href).href;
  } catch {
    /* keep as given */
  }
  try {
    clickAnchor(absolute, filename ?? '');
    return true;
  } catch (err) {
    console.error('[download] downloadUrl failed', err);
    return false;
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────────

export type CsvCell = string | number | boolean | Date | null | undefined;

/**
 * One CSV field (RFC 4180): quoted when it holds a separator, a quote or a
 * line break. Text starting with = + - @ (or a tab / carriage return) is
 * prefixed with a quote so a spreadsheet never evaluates it as a formula —
 * usernames and raw log lines in IPS exports are attacker-controlled.
 * Numbers are emitted as is (a negative number is not a formula).
 */
export function csvField(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document (CRLF rows, header first). */
export function toCsv(headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  return [headers, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/**
 * Save rows as a CSV file. A UTF-8 BOM is prepended so Excel opens accented
 * text (usernames, hostnames) correctly.
 */
export function saveCsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<CsvCell>>,
  filename: string,
): Promise<boolean> {
  return saveText(`\uFEFF${toCsv(headers, rows)}`, filename, 'text/csv;charset=utf-8');
}

// ── CSV export (server-side, UI-PAGES-IPS-20) ────────────────────────────────

/** Row cap of the server CSV exports (server/src/utils/csv.ts CSV_EXPORT_MAX). */
export const CSV_EXPORT_MAX = 50_000;

/**
 * Downloads `GET <path>` (text/csv of the current filters, tenant + team
 * scoped by the server) through the API client, so the session / ObliTools
 * token and the tenant header go along, and saves it with saveBlob.
 * Anonymous mode is forwarded (?anon=1). `truncated`: the server hit
 * CSV_EXPORT_MAX (X-Truncated). Unlike the helpers above, a failed request
 * rejects: callers toast csvExportError(err, ...).
 */
export async function downloadCsvExport(
  path: string,
  params: Record<string, string | number>,
  fallbackName: string,
): Promise<{ ok: boolean; truncated: boolean }> {
  const query = isAnonymous() ? { ...params, anon: 1 } : params;
  const res = await apiClient.get<Blob>(path, { params: query, responseType: 'blob' });
  const disposition = String(res.headers['content-disposition'] ?? '');
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const ok = await saveBlob(res.data, filename, 'text/csv;charset=utf-8');
  return { ok, truncated: String(res.headers['x-truncated'] ?? '') === 'true' };
}

/** The server's error text of a failed blob request, else `fallback`. */
export async function csvExportError(err: unknown, fallback: string): Promise<string> {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data instanceof Blob) {
    try {
      const msg = (JSON.parse(await data.text()) as { error?: unknown }).error;
      if (typeof msg === 'string' && msg.trim() !== '') return msg;
    } catch {
      /* not a JSON error body */
    }
  }
  return fallback;
}
