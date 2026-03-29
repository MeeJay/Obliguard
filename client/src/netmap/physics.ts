/**
 * ForceSimulation — custom force-directed layout engine for the NetMap.
 *
 * Zero dependencies. Velocity Verlet integration. 7 configurable forces.
 * Designed to run 1-3 ticks per requestAnimationFrame at <2ms budget.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** If true, node ignores all forces and stays at (x,y). */
  pinned: boolean;
  mass: number;
  /** 'agent' nodes repel strongly; 'ip' nodes repel weakly and only at short range. */
  kind: 'agent' | 'ip';
  /** Exclusion radius for agents (ring system size). Ignored for IPs. */
  radius: number;
}

export interface SimLink {
  sourceId: string;
  targetId: string;
  /** Spring constant — higher = stronger pull. */
  strength: number;
  /** Natural rest length in px. */
  idealLength: number;
}

export interface SimConfig {
  /** Cooling factor start (default 1.0). */
  alpha: number;
  /** Per-tick alpha decay (default 0.005). */
  alphaDecay: number;
  /** Simulation stops when alpha drops below this (default 0.001). */
  alphaMin: number;
  /** Velocity damping per tick — 0 = no damping, 1 = full stop (default 0.40). */
  velocityDecay: number;
  /** Center gravity strength for agents (default 0.008). */
  centerGravity: number;
  /** Agent-agent Coulomb repulsion strength (default 800). */
  agentRepulsion: number;
  /** IP-IP short-range repulsion strength (default 2.0). */
  ipRepulsion: number;
  /** IP-IP repulsion range in px (default 18). */
  ipRepulsionRange: number;
  /** Canvas bounds for containment force. */
  width: number;
  height: number;
  /** Margin for containment force (default 40). */
  margin: number;
  /** Containment wall stiffness (default 0.5). */
  wallStiffness: number;
}

const DEFAULT_CONFIG: SimConfig = {
  alpha: 1.0,
  alphaDecay: 0.005,
  alphaMin: 0.001,
  velocityDecay: 0.40,
  centerGravity: 0.008,
  agentRepulsion: 800,
  ipRepulsion: 2.0,
  ipRepulsionRange: 18,
  width: 800,
  height: 600,
  margin: 40,
  wallStiffness: 0.5,
};

// ── Spatial Hash (for O(n) IP-IP repulsion) ──────────────────────────────────

class SpatialHash {
  private cellSize: number;
  private cells = new Map<string, SimNode[]>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  clear(): void {
    this.cells.clear();
  }

  insert(node: SimNode): void {
    const key = this.key(node.x, node.y);
    const cell = this.cells.get(key);
    if (cell) cell.push(node);
    else this.cells.set(key, [node]);
  }

  /** Returns all nodes in the same cell or 8 neighbors. */
  nearby(node: SimNode): SimNode[] {
    const cx = Math.floor(node.x / this.cellSize);
    const cy = Math.floor(node.y / this.cellSize);
    const result: SimNode[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(`${cx + dx},${cy + dy}`);
        if (cell) for (const n of cell) result.push(n);
      }
    }
    return result;
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }
}

// ── ForceSimulation ──────────────────────────────────────────────────────────

export class ForceSimulation {
  private nodes = new Map<string, SimNode>();
  private links: SimLink[] = [];
  private config: SimConfig;
  private spatialHash: SpatialHash;

  /** Current cooling factor. When < alphaMin, simulation is idle. */
  alpha: number;

  constructor(config?: Partial<SimConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.alpha = this.config.alpha;
    this.spatialHash = new SpatialHash(this.config.ipRepulsionRange * 2);
  }

  // ── Node management ──────────────────────────────────────────────────────

  addNode(node: SimNode): void {
    this.nodes.set(node.id, node);
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    this.links = this.links.filter(l => l.sourceId !== id && l.targetId !== id);
  }

  getNode(id: string): SimNode | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  // ── Link management ──────────────────────────────────────────────────────

  upsertLink(link: SimLink): void {
    const idx = this.links.findIndex(
      l => l.sourceId === link.sourceId && l.targetId === link.targetId,
    );
    if (idx >= 0) this.links[idx] = link;
    else this.links.push(link);
  }

  removeLink(sourceId: string, targetId: string): void {
    this.links = this.links.filter(
      l => !(l.sourceId === sourceId && l.targetId === targetId),
    );
  }

  // ── Simulation control ───────────────────────────────────────────────────

  /** Kick the simulation back to life. */
  reheat(alpha = 0.8): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  /** Returns true if the simulation is still active (above alphaMin). */
  get isActive(): boolean {
    return this.alpha >= this.config.alphaMin;
  }

  /** Update canvas bounds (e.g. on resize). */
  setBounds(width: number, height: number): void {
    this.config.width = width;
    this.config.height = height;
  }

  // ── Core tick ────────────────────────────────────────────────────────────

  /**
   * Run `iterations` simulation steps. Call this 1-3 times per frame.
   * Each tick applies all forces, integrates velocity, decays alpha.
   */
  tick(iterations = 1): void {
    for (let i = 0; i < iterations; i++) {
      if (this.alpha < this.config.alphaMin) return;
      this.applyForces();
      this.integrate();
      this.alpha = Math.max(this.alpha - this.config.alphaDecay, 0);
    }
  }

  // ── Force application ────────────────────────────────────────────────────

  private applyForces(): void {
    const agents: SimNode[] = [];
    const ips: SimNode[] = [];

    for (const node of this.nodes.values()) {
      if (node.pinned) continue;
      if (node.kind === 'agent') agents.push(node);
      else ips.push(node);
    }

    // Reset forces (abuse vx/vy as accumulators temporarily — we apply after)
    // We use separate fx/fy accumulators via local arrays for clarity.
    const fx = new Map<string, number>();
    const fy = new Map<string, number>();
    for (const n of this.nodes.values()) {
      fx.set(n.id, 0);
      fy.set(n.id, 0);
    }

    const addForce = (id: string, dfx: number, dfy: number) => {
      fx.set(id, (fx.get(id) ?? 0) + dfx);
      fy.set(id, (fy.get(id) ?? 0) + dfy);
    };

    const { width: W, height: H, margin: M } = this.config;
    const cx = W / 2, cy = H / 2;

    // ── Force 1: Spring attraction between linked nodes ───────────────────
    for (const link of this.links) {
      const s = this.nodes.get(link.sourceId);
      const t = this.nodes.get(link.targetId);
      if (!s || !t) continue;

      const dx = t.x - s.x, dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const displacement = d - link.idealLength;
      const force = link.strength * displacement * this.alpha;
      const nx = dx / d, ny = dy / d;

      if (!s.pinned) { addForce(s.id, nx * force, ny * force); }
      if (!t.pinned) { addForce(t.id, -nx * force, -ny * force); }
    }

    // ── Force 2: Agent-agent Coulomb repulsion ────────────────────────────
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i], b = agents[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const minD = a.radius + b.radius + 28;
        const minD2 = minD * minD;
        const effD2 = Math.max(d2, 100); // clamp to avoid infinite force
        const d = Math.sqrt(effD2);

        // Coulomb repulsion always active, stronger when overlapping
        let force = this.config.agentRepulsion * this.alpha / effD2;

        // Extra push when ring systems overlap
        if (d2 < minD2) {
          force += (minD - d) * 0.5 * this.alpha;
        }

        const nx = dx / d, ny = dy / d;
        addForce(a.id, -nx * force, -ny * force);
        addForce(b.id, nx * force, ny * force);
      }
    }

    // ── Force 3: Center gravity for agents ────────────────────────────────
    for (const ag of agents) {
      const dx = cx - ag.x, dy = cy - ag.y;
      addForce(ag.id, dx * this.config.centerGravity * this.alpha, dy * this.config.centerGravity * this.alpha);
    }

    // ── Force 4+5: IP springs are handled via the links array above ───────
    // (single-agent IP springs and multi-agent IP springs are both SimLinks)

    // ── Force 6: IP-IP short-range repulsion (spatial hash) ───────────────
    this.spatialHash.clear();
    for (const ip of ips) this.spatialHash.insert(ip);

    for (const ip of ips) {
      const nearby = this.spatialHash.nearby(ip);
      for (const other of nearby) {
        if (other.id === ip.id || other.id < ip.id) continue; // avoid double-counting
        const dx = other.x - ip.x, dy = other.y - ip.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
        if (d > this.config.ipRepulsionRange) continue;

        const force = this.config.ipRepulsion * (1 - d / this.config.ipRepulsionRange) * this.alpha;
        const nx = dx / d, ny = dy / d;
        if (!ip.pinned) { addForce(ip.id, -nx * force, -ny * force); }
        if (!other.pinned) { addForce(other.id, nx * force, ny * force); }
      }
    }

    // ── Force 7: Boundary containment ─────────────────────────────────────
    for (const n of this.nodes.values()) {
      if (n.pinned) continue;
      const s = this.config.wallStiffness * this.alpha;
      if (n.x < M) addForce(n.id, (M - n.x) * s, 0);
      if (n.x > W - M) addForce(n.id, (W - M - n.x) * s, 0);
      if (n.y < M) addForce(n.id, 0, (M - n.y) * s);
      if (n.y > H - M) addForce(n.id, 0, (H - M - n.y) * s);
    }

    // ── Apply accumulated forces to velocity ──────────────────────────────
    for (const n of this.nodes.values()) {
      if (n.pinned) continue;
      n.vx = (n.vx + (fx.get(n.id) ?? 0) / n.mass) * (1 - this.config.velocityDecay);
      n.vy = (n.vy + (fy.get(n.id) ?? 0) / n.mass) * (1 - this.config.velocityDecay);
    }
  }

  // ── Verlet integration ───────────────────────────────────────────────────

  private integrate(): void {
    for (const n of this.nodes.values()) {
      if (n.pinned) continue;
      n.x += n.vx;
      n.y += n.vy;
    }
  }
}
