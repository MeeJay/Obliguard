import type { AgentNode, IpNode } from './types';
import { RING_INNER_R, RING_GAP, PER_RING, ARC_START, ARC_SPAN } from './constants';
import { ipRand, agentExclusionR } from './helpers';

// ── Layout functions ──────────────────────────────────────────────────────────

/**
 * Place a single new IP (live socket event) in the 240° arc around its agent.
 * Uses the innermost ring radius for simplicity — batch layout handles ordering.
 */
export function placeIp(ip: IpNode, agentMap: Map<number, AgentNode>): void {
  const ags = ip.agentIds.map(id => agentMap.get(id)).filter(Boolean) as AgentNode[];
  if (!ags.length) return;

  if (ags.length > 1) {
    const cx = ags.reduce((s, a) => s + a.x, 0) / ags.length;
    const cy = ags.reduce((s, a) => s + a.y, 0) / ags.length;
    const angle = ipRand(ip.ip, 1) * Math.PI * 2;
    ip.x = cx + Math.cos(angle) * (12 + ipRand(ip.ip, 5) * 22);
    ip.y = cy + Math.sin(angle) * (12 + ipRand(ip.ip, 5) * 22);
    return;
  }

  const ag    = ags[0];
  const angle = ARC_START + ipRand(ip.ip, 1) * ARC_SPAN;
  const dist  = RING_INNER_R + ipRand(ip.ip, 3) * RING_GAP * 1.5;
  ip.x = ag.x + Math.cos(angle) * dist;
  ip.y = ag.y + Math.sin(angle) * dist;
}

/**
 * Batch layout: distribute all IPs around agents.
 *
 * 1. Sort each agent's IPs by activity DESC so the most active are innermost.
 * 2. Run an agent repulsion pass so ring systems don't overlap.
 * 3. Place IPs in concentric 240° arcs with small deterministic jitter.
 * 4. Multi-agent IPs: weighted centroid, pushed outside every agent's rings.
 */
export function distributeIpsAroundAgents(
  agents: AgentNode[],
  ips: IpNode[],
  canvasW: number,
  canvasH: number,
): void {
  const agentMap = new Map(agents.map(a => [a.id, a]));
  const margin   = 60;

  // Group single-agent IPs by agent, sorted most active → innermost
  const byAgent = new Map<number, IpNode[]>();
  for (const ip of ips) {
    if (ip.agentIds.length !== 1) continue;
    const aid = ip.agentIds[0];
    if (!byAgent.has(aid)) byAgent.set(aid, []);
    byAgent.get(aid)!.push(ip);
  }
  for (const group of byAgent.values()) {
    group.sort((a, b) =>
      b.eventCount - a.eventCount || b.failures - a.failures,
    );
  }

  // Compute exclusion radius per agent
  const exclR = new Map<number, number>();
  for (const ag of agents) {
    exclR.set(ag.id, agentExclusionR((byAgent.get(ag.id) ?? []).length));
  }

  // ── Agent repulsion pass ────────────────────────────────────────────────
  for (let iter = 0; iter < 120; iter++) {
    const alpha = 1 - iter / 120;
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i], b = agents[j];
        const minD = (exclR.get(a.id) ?? 60) + (exclR.get(b.id) ?? 60) + 28;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d  = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < minD) {
          const push = (minD - d) / 2 * alpha * 0.6;
          const nx = dx / d, ny = dy / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
        }
      }
      agents[i].x = Math.max(margin, Math.min(canvasW - margin, agents[i].x));
      agents[i].y = Math.max(margin, Math.min(canvasH - margin, agents[i].y));
    }
  }

  // ── Place single-agent IPs in arcs ─────────────────────────────────────
  for (const ag of agents) {
    const group = byAgent.get(ag.id) ?? [];
    group.forEach((ip, idx) => {
      const ring        = Math.floor(idx / PER_RING);
      const posInRing   = idx % PER_RING;
      const countInRing = Math.min(PER_RING, group.length - ring * PER_RING);
      const angleStep   = countInRing <= 1 ? 0 : ARC_SPAN / (countInRing - 1);
      const baseAngle   = ARC_START + posInRing * angleStep;
      const jA = (ipRand(ip.ip, 97) - 0.5) * Math.min(angleStep * 0.30, 0.10);
      const jR = (ipRand(ip.ip, 83) - 0.5) * 2;
      const r  = RING_INNER_R + ring * RING_GAP + jR;
      ip.x = ag.x + Math.cos(baseAngle + jA) * r;
      ip.y = ag.y + Math.sin(baseAngle + jA) * r;
    });
  }

  // ── Multi-agent IPs: weighted centroid, pushed outside all rings ────────
  for (const ip of ips) {
    if (ip.agentIds.length < 2) continue;
    const ags = ip.agentIds.map(id => agentMap.get(id)).filter(Boolean) as AgentNode[];
    const totalW = ags.reduce((s, ag) => s + (ip.agentWeights[ag.id] ?? 1), 0) || ags.length;
    let cx = 0, cy = 0;
    for (const ag of ags) {
      const w = (ip.agentWeights[ag.id] ?? 1) / totalW;
      cx += ag.x * w; cy += ag.y * w;
    }
    const angle  = ipRand(ip.ip, 1) * Math.PI * 2;
    const scatter = 25 + ipRand(ip.ip, 5) * 40;
    ip.x = cx + Math.cos(angle) * scatter;
    ip.y = cy + Math.sin(angle) * scatter;

    // Push outside every agent's ring system with generous margin
    for (const ag of ags) {
      const dx = ip.x - ag.x, dy = ip.y - ag.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const er = exclR.get(ag.id) ?? 60;
      if (d < er + 12) {
        const push = er + 12 - d + 10;
        ip.x += (dx / d) * push;
        ip.y += (dy / d) * push;
      }
    }
  }
}

/**
 * Re-place IPs around agents WITHOUT moving agents — called on dynamic additions.
 * Same arc/ring logic as distributeIpsAroundAgents but skips the agent repulsion pass.
 */
export function relayoutIps(agents: AgentNode[], ips: IpNode[]): void {
  const agentMap = new Map(agents.map(a => [a.id, a]));
  const byAgent  = new Map<number, IpNode[]>();
  for (const ip of ips) {
    if (ip.agentIds.length !== 1) continue;
    const aid = ip.agentIds[0];
    if (!byAgent.has(aid)) byAgent.set(aid, []);
    byAgent.get(aid)!.push(ip);
  }
  for (const group of byAgent.values()) {
    group.sort((a, b) => b.eventCount - a.eventCount || b.failures - a.failures);
  }
  const exclR = new Map<number, number>();
  for (const ag of agents) exclR.set(ag.id, agentExclusionR((byAgent.get(ag.id) ?? []).length));

  for (const ag of agents) {
    const group = byAgent.get(ag.id) ?? [];
    group.forEach((ip, idx) => {
      const ring        = Math.floor(idx / PER_RING);
      const posInRing   = idx % PER_RING;
      const countInRing = Math.min(PER_RING, group.length - ring * PER_RING);
      const angleStep   = countInRing <= 1 ? 0 : ARC_SPAN / (countInRing - 1);
      const baseAngle   = ARC_START + posInRing * angleStep;
      const jA = (ipRand(ip.ip, 97) - 0.5) * Math.min(angleStep * 0.30, 0.10);
      const jR = (ipRand(ip.ip, 83) - 0.5) * 2;
      const r  = RING_INNER_R + ring * RING_GAP + jR;
      ip.x = ag.x + Math.cos(baseAngle + jA) * r;
      ip.y = ag.y + Math.sin(baseAngle + jA) * r;
    });
  }
  // Multi-agent IPs
  for (const ip of ips) {
    if (ip.agentIds.length < 2) continue;
    const ags    = ip.agentIds.map(id => agentMap.get(id)).filter(Boolean) as AgentNode[];
    const totalW = ags.reduce((s, ag) => s + (ip.agentWeights[ag.id] ?? 1), 0) || ags.length;
    let cx = 0, cy = 0;
    for (const ag of ags) { const w = (ip.agentWeights[ag.id] ?? 1) / totalW; cx += ag.x * w; cy += ag.y * w; }
    const angle = ipRand(ip.ip, 1) * Math.PI * 2;
    const scatter = 25 + ipRand(ip.ip, 5) * 40;
    ip.x = cx + Math.cos(angle) * scatter;
    ip.y = cy + Math.sin(angle) * scatter;
    for (const ag of ags) {
      const dx = ip.x - ag.x, dy = ip.y - ag.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const er = exclR.get(ag.id) ?? 60;
      if (d < er + 12) { const push = er + 12 - d + 10; ip.x += (dx / d) * push; ip.y += (dy / d) * push; }
    }
  }
}

/** Spring relaxation — agents start near centre before ring-repulsion runs. */
export function layoutAgents(agents: AgentNode[], w: number, h: number): void {
  const n = agents.length;
  if (n === 0) return;
  if (n === 1) { agents[0].x = w / 2; agents[0].y = h / 2; return; }
  const initR = Math.min(w, h) * 0.18;
  agents.forEach((ag, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const seed  = ag.id > 0 ? ag.id : i + 1;
    ag.x = w / 2 + Math.cos(angle) * initR + ((seed * 1327) % 30) - 15;
    ag.y = h / 2 + Math.sin(angle) * initR + ((seed * 2417) % 30) - 15;
  });
  for (let iter = 0; iter < 80; iter++) {
    const alpha = 1 - iter / 80;
    for (let i = 0; i < n; i++) {
      agents[i].x += (w / 2 - agents[i].x) * 0.015 * alpha;
      agents[i].y += (h / 2 - agents[i].y) * 0.015 * alpha;
    }
  }
}
