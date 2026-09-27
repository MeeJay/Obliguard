/**
 * Query-string paging helpers (A16 API). Only plain decimal strings are
 * accepted; arrays, objects and garbage fall back to the defaults, and every
 * value is capped so a request can never ask for an unbounded page.
 */

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
