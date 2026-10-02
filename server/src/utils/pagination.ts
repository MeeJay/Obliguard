/**
 * Query-string paging helpers (A16 API). Only plain decimal strings are
 * accepted; arrays, objects and garbage fall back to the defaults, and every
 * value is capped so a request can never ask for an unbounded page.
 */
import { parseIpOrCidr } from './ipValidation';

function toInt(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^-?[0-9]{1,9}$/.test(s)) return null;
  return Number(s);
}

export function parsePaging(
  query: Record<string, unknown>,
  opts: { defaultSize: number; max?: number; pageParam?: string; sizeParam?: string },
): { page: number; pageSize: number; offset: number } {
  const max = opts.max ?? 1000;
  const pageRaw = toInt(query[opts.pageParam ?? 'page']);
  const sizeRaw = toInt(query[opts.sizeParam ?? 'pageSize']);
  const page = Math.min(pageRaw != null && pageRaw >= 1 ? pageRaw : 1, 100_000);
  const pageSize = Math.min(sizeRaw != null && sizeRaw >= 1 ? sizeRaw : opts.defaultSize, max);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function parseLimitOffset(
  query: Record<string, unknown>,
  opts: { defaultLimit: number; max?: number },
): { limit: number; offset: number } {
  const max = opts.max ?? 1000;
  const limitRaw = toInt(query.limit);
  const offsetRaw = toInt(query.offset);
  const limit = Math.min(limitRaw != null && limitRaw >= 1 ? limitRaw : opts.defaultLimit, max);
  const offset = Math.min(offsetRaw != null && offsetRaw >= 0 ? offsetRaw : 0, 1_000_000);
  return { limit, offset };
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export type SortOrder = 'asc' | 'desc';

/**
 * sortBy / sortOrder from the query string, checked against a per-endpoint
 * whitelist of keys (the caller maps each key to its SQL expression, never
 * the raw value). An unknown key or order silently falls back to the default.
 */
export function parseSort<K extends string>(
  query: Record<string, unknown>,
  allowed: readonly K[],
  defaults: { sortBy: K; sortOrder: SortOrder },
): { sortBy: K; sortOrder: SortOrder; explicit: boolean } {
  const rawBy = query.sortBy;
  const rawOrder = query.sortOrder;
  const known = typeof rawBy === 'string' && (allowed as readonly string[]).includes(rawBy);
  const sortBy = known ? (rawBy as K) : defaults.sortBy;
  const sortOrder: SortOrder = rawOrder === 'asc' || rawOrder === 'desc' ? rawOrder : defaults.sortOrder;
  return { sortBy, sortOrder, explicit: known };
}

// ── Filters ──────────────────────────────────────────────────────────────────

/** A single string query value (arrays / objects / empty → undefined). */
export function queryString(v: unknown, maxLen = 256): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.slice(0, maxLen);
}

/**
 * A date query value: undefined when absent, a Date when valid, null when
 * present but unparseable (the caller answers 400).
 */
export function queryDate(v: unknown): Date | null | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 64) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `%value%` for ILIKE, with the LIKE metacharacters (and the escape char) escaped. */
export function likeContains(v: string): string {
  return `%${v.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

/**
 * How an IP search box is applied to an inet column:
 *   - a single address  → exact inet equality (index friendly);
 *   - a CIDR network    → inet containment (<<=);
 *   - anything else     → substring match on host(ip).
 * The value is canonical (parseIpOrCidr), so it always casts to inet.
 */
export type IpSearch =
  | { kind: 'exact'; value: string }
  | { kind: 'cidr'; value: string }
  | { kind: 'text'; pattern: string };

export function parseIpSearch(raw: string): IpSearch {
  const p = parseIpOrCidr(raw);
  if (p) {
    const full = p.family === 4 ? 32 : 128;
    return p.prefix === full
      ? { kind: 'exact', value: p.address }
      : { kind: 'cidr', value: `${p.address}/${p.prefix}` };
  }
  return { kind: 'text', pattern: likeContains(raw.slice(0, 64)) };
}

/** SQL + bindings applying parseIpSearch to an inet column expression (trusted, never user input). */
export function ipSearchSql(column: string, s: IpSearch): { sql: string; bindings: string[] } {
  switch (s.kind) {
    case 'exact': return { sql: `${column} = ?::inet`, bindings: [s.value] };
    case 'cidr':  return { sql: `${column} <<= ?::inet`, bindings: [s.value] };
    default:      return { sql: `host(${column}) ILIKE ?`, bindings: [s.pattern] };
  }
}
