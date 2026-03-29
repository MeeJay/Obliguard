import type { IpNode, WlEntry } from './types';
import { SVC_COLORS, DANGEROUS_SVCS, BADGE_H, BADGE_FONT, RING_INNER_R, RING_GAP, PER_RING } from './constants';

// ── Pure helpers ───────────────────────────────────────────────────────────────

export function flagEmoji(code: string): string {
  if (!code || code.length !== 2) return '\u{1F310}';
  return Array.from(code.toUpperCase())
    .map(c => String.fromCodePoint(c.codePointAt(0)! + 127397))
    .join('');
}

export function svcColor(s: string): string {
  const lc = (s ?? '').toLowerCase();
  for (const [k, v] of Object.entries(SVC_COLORS)) if (lc.includes(k)) return v;
  return '#f43f5e';
}

export function isDangerousSvc(s: string): boolean {
  return DANGEROUS_SVCS.has((s ?? '').toLowerCase().split('/')[0]);
}

export function statusColor(st: string): string {
  if (st === 'banned')      return '#ef4444';
  if (st === 'suspicious')  return '#f97316';
  if (st === 'whitelisted') return '#22c55e';
  return '#475569';
}

/** Seeded pseudo-random 0–1 from an IP string + salt integer. */
export function ipRand(ip: string, salt: number): number {
  const seed = (ip.split('.').reduce((a, b) => a + Number(b), 0) * 31 + salt) >>> 0;
  return ((seed * 16807) % 2147483647) / 2147483647;
}

/** Exclusion radius for an agent given how many single-agent IPs it has. */
export function agentExclusionR(ipCount: number): number {
  const rings = Math.max(1, Math.ceil(ipCount / PER_RING));
  return RING_INNER_R + (rings - 1) * RING_GAP + 18;
}

/** Only show a badge for notable IPs. */
export function shouldLabel(ip: IpNode): boolean {
  return ip.status === 'banned' || ip.status === 'whitelisted' || ip.failures > 2 || ip.eventCount >= 8 || ip.agentIds.length > 1;
}

// ── CIDR helpers ──────────────────────────────────────────────────────────────

/** Convert IPv4 dotted-decimal to unsigned 32-bit int. Returns -1 on failure. */
export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return -1;
  let n = 0;
  for (const p of parts) {
    const b = parseInt(p, 10);
    if (isNaN(b) || b < 0 || b > 255) return -1;
    n = (n << 8) | b;
  }
  return n >>> 0;
}

/** Returns the first whitelist entry whose CIDR contains the given IPv4 address, or null. */
export function matchWhitelist(ip: string, entries: WlEntry[]): WlEntry | null {
  const ipInt = ipToInt(ip);
  if (ipInt < 0) return null;
  for (const e of entries) {
    if ((ipInt & e.mask) === (e.networkInt & e.mask)) return e;
  }
  return null;
}

// ── Orbital defaults for new IpNodes ──────────────────────────────────────────

/** Generate orbital motion fields for a new IpNode. */
export function makeOrbitalFields(ip: string, canvasW: number, canvasH: number): {
  orbitAngle: number; orbitSpeed: number; orbitSlot: number;
  arriveT: number; spawnX: number; spawnY: number; trail: { x: number; y: number }[];
} {
  const r1 = ipRand(ip, 42);
  const r2 = ipRand(ip, 77);
  const edge = ipRand(ip, 99);
  let sx: number, sy: number;
  if (edge < 0.25) { sx = r1 * canvasW; sy = -30; }
  else if (edge < 0.5) { sx = canvasW + 30; sy = r1 * canvasH * 0.6; }
  else if (edge < 0.75) { sx = -30; sy = r1 * canvasH * 0.6; }
  else { sx = canvasW * 0.2 + r1 * canvasW * 0.6; sy = -30; }

  return {
    orbitAngle: r1 * Math.PI * 2,
    // Variable speed: 0.0004–0.0014 rad/frame, random direction
    orbitSpeed: (0.0004 + r2 * 0.0010) * (r1 < 0.5 ? 1 : -1),
    orbitSlot: 0,
    arriveT: 0,
    spawnX: sx,
    spawnY: sy,
    trail: [],
  };
}

// ── Convex hull (Graham scan) ─────────────────────────────────────────────────

export function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Inflate a polygon by `amount` px (simple offset along normals). */
export function inflateHull(hull: { x: number; y: number }[], amount: number): { x: number; y: number }[] {
  if (hull.length < 3) return hull.map(p => ({ x: p.x, y: p.y }));
  const n = hull.length;
  return hull.map((p, i) => {
    const prev = hull[(i - 1 + n) % n];
    const next = hull[(i + 1) % n];
    // Average of inward normals of adjacent edges
    const dx1 = p.x - prev.x, dy1 = p.y - prev.y;
    const dx2 = next.x - p.x, dy2 = next.y - p.y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
    // Outward normals (perpendicular, pointing away from centroid)
    const nx = (dy1 / len1 + dy2 / len2) / 2;
    const ny = (-dx1 / len1 + -dx2 / len2) / 2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    return { x: p.x + (nx / nlen) * amount, y: p.y + (ny / nlen) * amount };
  });
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

export function badgeText(countryCode: string, ipStr: string): string {
  const cc = countryCode && countryCode.length === 2 && countryCode !== '??' ? countryCode : '??';
  return `${cc} \u00B7 ${ipStr}`;
}

export function drawBadgeAt(
  ctx: CanvasRenderingContext2D,
  text: string, bx: number, by: number, bw: number,
  color: string, alpha: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = BADGE_FONT;

  // Background with subtle gradient
  ctx.fillStyle = 'rgba(5,3,1,0.88)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, bw, BADGE_H, 4);
  else ctx.rect(bx, by, bw, BADGE_H);
  ctx.fill();

  // Color accent border
  ctx.strokeStyle = color + '55';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Left accent bar
  ctx.fillStyle = color + '90';
  ctx.fillRect(bx + 1.5, by + 3, 1.5, BADGE_H - 6);

  // Text with slight shadow for contrast
  ctx.shadowBlur = 3; ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.fillStyle = '#dbe4ef';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 7, by + BADGE_H / 2);
  ctx.restore();
}
