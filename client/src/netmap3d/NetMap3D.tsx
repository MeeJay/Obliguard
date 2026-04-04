import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { createScene, resizeScene, disposeScene, type SceneContext } from './scene';
import { createStarField, updateStarField } from './skybox';
import { createAgent3D, updateAgent3D, type Agent3D } from './agentMesh';
import { IpMeshPool, statusToColor3D } from './ipMesh';
import { createOrbitRings, getOrbitPosition3D } from './orbitRing';
import { setupInteractions, flyTo } from './interactions';
import { SCALE } from './constants3d';
import type { AgentNode, IpNode, AgentPeerLink } from '../netmap/types';

interface Props {
  agentsRef: React.MutableRefObject<AgentNode[]>;
  ipsRef: React.MutableRefObject<Map<string, IpNode>>;
  agentLinksRef: React.MutableRefObject<Map<string, AgentPeerLink>>;
  visibleAgentIds: Set<number> | null;
  threatOnly: boolean;
  searchHit: string | null;
  onSelectAgent: (agent: AgentNode | null) => void;
  onSelectIp: (ip: IpNode | null) => void;
}

export default function NetMap3D({
  agentsRef, ipsRef, agentLinksRef,
  visibleAgentIds, threatOnly, searchHit: _searchHit,
  onSelectAgent, onSelectIp,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<SceneContext | null>(null);
  const agent3dRef = useRef<Map<number, Agent3D>>(new Map());
  const ipPoolRef = useRef<IpMeshPool | null>(null);
  const starsRef = useRef<THREE.Points | null>(null);
  const orbitGroupsRef = useRef<Map<number, THREE.Group>>(new Map());
  const peerLinesRef = useRef<Map<string, THREE.Line>>(new Map());
  const rafRef = useRef(0);

  // ── Mount: create scene ──────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ctx = createScene(el);
    ctxRef.current = ctx;

    // Stars
    const stars = createStarField();
    ctx.scene.add(stars);
    starsRef.current = stars;

    // IP pool
    const ipPool = new IpMeshPool(1000);
    ipPool.mesh.userData.isIpPool = true;
    ctx.scene.add(ipPool.mesh);
    ipPoolRef.current = ipPool;

    // Interactions
    const cleanupInteractions = setupInteractions(
      ctx, el,
      () => {}, // hover agent (TODO: tooltip)
      () => {}, // hover ip
      (type, id) => {
        if (type === 'agent') {
          const ag = agentsRef.current.find(a => a.id === id);
          onSelectAgent(ag ?? null);
        } else if (type === 'ip') {
          // id is instanceId — need to map back to IpNode
          const ipArr = getFilteredIps();
          const ip = ipArr[id as number];
          if (ip) onSelectIp(ip);
        }
      },
      (pos) => {
        flyTo(ctx.controls as any, ctx.camera, pos);
      },
    );

    // Resize observer
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) resizeScene(ctx, width, height);
    });
    ro.observe(el);

    // Start animation loop
    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      const time = ctx.clock.getElapsedTime();

      ctx.controls.update();

      // Update stars
      if (starsRef.current) updateStarField(starsRef.current, time);

      // Sync agents
      syncAgents(ctx, time);

      // Sync orbit rings
      syncOrbitRings(ctx);

      // Sync IPs
      syncIps();

      // Sync peer links
      syncPeerLinks(ctx);

      // Render
      ctx.composer.render();
      ctx.labelRenderer.render(ctx.scene, ctx.camera);
    };
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      cleanupInteractions();
      ro.disconnect();
      disposeScene(ctx);
      ctxRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Helper: get filtered IPs ──────────────────────────────────────────
  const getFilteredIps = useCallback((): IpNode[] => {
    let arr = [...ipsRef.current.values()];
    if (visibleAgentIds) {
      arr = arr.filter(ip => ip.agentIds.some(id => visibleAgentIds.has(id)));
    }
    if (threatOnly) {
      arr = arr.filter(ip => ip.status === 'banned' || ip.status === 'suspicious');
    }
    return arr;
  }, [ipsRef, visibleAgentIds, threatOnly]);

  // ── Sync agents ────────────────────────────────────────────────────────
  const syncAgents = useCallback((ctx: SceneContext, time: number) => {
    const agents = visibleAgentIds
      ? agentsRef.current.filter(a => visibleAgentIds.has(a.id))
      : agentsRef.current;
    const map = agent3dRef.current;

    // Remove agents no longer present
    for (const [id, a3d] of map) {
      if (!agents.find(a => a.id === id)) {
        ctx.scene.remove(a3d.group);
        map.delete(id);
      }
    }

    // Create or update agents
    for (const agent of agents) {
      let a3d = map.get(agent.id);
      if (!a3d) {
        a3d = createAgent3D(agent);
        ctx.scene.add(a3d.group);
        map.set(agent.id, a3d);
      }
      updateAgent3D(a3d, agent, time);
    }
  }, [agentsRef, visibleAgentIds]);

  // ── Sync orbit rings ──────────────────────────────────────────────────
  const syncOrbitRings = useCallback((ctx: SceneContext) => {
    const agents = agentsRef.current;
    const ipMap = ipsRef.current;
    const existing = orbitGroupsRef.current;

    // Count IPs per agent
    const ipsPerAgent = new Map<number, number>();
    for (const ip of ipMap.values()) {
      if (ip.agentIds.length === 1) {
        const aid = ip.agentIds[0];
        ipsPerAgent.set(aid, (ipsPerAgent.get(aid) ?? 0) + 1);
      }
    }

    for (const agent of agents) {
      const count = ipsPerAgent.get(agent.id) ?? 0;
      const ringCount = Math.max(0, Math.ceil(count / 20));
      const key = agent.id;

      // Remove old rings if count changed
      const oldGroup = existing.get(key);
      if (oldGroup && oldGroup.children.length !== ringCount) {
        ctx.scene.remove(oldGroup);
        existing.delete(key);
      }

      if (ringCount > 0 && !existing.has(key)) {
        const group = createOrbitRings(ringCount);
        group.position.set(agent.x * SCALE, 0, agent.y * SCALE);
        ctx.scene.add(group);
        existing.set(key, group);
      }

      // Update position
      const group = existing.get(key);
      if (group) {
        group.position.set(agent.x * SCALE, 0, agent.y * SCALE);
      }
    }
  }, [agentsRef, ipsRef]);

  // ── Sync IPs ──────────────────────────────────────────────────────────
  const syncIps = useCallback(() => {
    const pool = ipPoolRef.current;
    if (!pool) return;

    const agents = agentsRef.current;
    const agentMap = new Map(agents.map(a => [a.id, a]));
    const filtered = getFilteredIps();

    // Count IPs per agent for orbit calculation
    const ipsPerAgent = new Map<number, number>();
    for (const ip of ipsRef.current.values()) {
      if (ip.agentIds.length === 1) {
        const aid = ip.agentIds[0];
        ipsPerAgent.set(aid, (ipsPerAgent.get(aid) ?? 0) + 1);
      }
    }

    const positions: { x: number; y: number; z: number; radius: number; color: number }[] = [];

    for (const ip of filtered) {
      if (ip.agentIds.length === 0) continue;
      const agent = agentMap.get(ip.agentIds[0]);
      if (!agent) continue;

      const agentPos = new THREE.Vector3(agent.x * SCALE, 0, agent.y * SCALE);
      const totalIps = ipsPerAgent.get(agent.id) ?? 1;

      const pos3d = getOrbitPosition3D(agentPos, ip.orbitSlot, totalIps, ip.orbitAngle, ip.orbitCurrentR);

      // Arrival animation
      if (ip.arriveT < 1) {
        const spawn = new THREE.Vector3(ip.spawnX * SCALE, 50, ip.spawnY * SCALE);
        pos3d.lerp(spawn, 1 - ip.arriveT);
      }

      positions.push({
        x: pos3d.x,
        y: pos3d.y,
        z: pos3d.z,
        radius: ip.dotR,
        color: statusToColor3D(ip.status),
      });
    }

    pool.update(positions);
  }, [agentsRef, ipsRef, getFilteredIps]);

  // ── Sync peer links ───────────────────────────────────────────────────
  const syncPeerLinks = useCallback((ctx: SceneContext) => {
    const existing = peerLinesRef.current;
    const agentMap = new Map(agentsRef.current.map(a => [a.id, a]));

    // Remove stale links
    for (const [key, line] of existing) {
      if (!agentLinksRef.current.has(key)) {
        ctx.scene.remove(line);
        existing.delete(key);
      }
    }

    // Add/update links
    for (const [key, link] of agentLinksRef.current) {
      const src = agentMap.get(link.sourceId);
      const tgt = agentMap.get(link.targetId);
      if (!src || !tgt) continue;

      if (!existing.has(key)) {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(src.x * SCALE, 0, src.y * SCALE),
          new THREE.Vector3((src.x + tgt.x) / 2 * SCALE, 8, (src.y + tgt.y) / 2 * SCALE), // arc up
          new THREE.Vector3(tgt.x * SCALE, 0, tgt.y * SCALE),
        ]);
        const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(50));
        const color = link.type === 'wan' ? 0xf97316 : 0x3b82f6;
        const mat = new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
        });
        const line = new THREE.Line(geo, mat);
        ctx.scene.add(line);
        existing.set(key, line);
      } else {
        // Update positions
        const line = existing.get(key)!;
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(src.x * SCALE, 0, src.y * SCALE),
          new THREE.Vector3((src.x + tgt.x) / 2 * SCALE, 8, (src.y + tgt.y) / 2 * SCALE),
          new THREE.Vector3(tgt.x * SCALE, 0, tgt.y * SCALE),
        ]);
        const points = curve.getPoints(50);
        const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < Math.min(points.length, positions.count); i++) {
          positions.setXYZ(i, points[i].x, points[i].y, points[i].z);
        }
        positions.needsUpdate = true;
      }
    }
  }, [agentsRef, agentLinksRef]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative"
      style={{ background: '#020408' }}
    />
  );
}
