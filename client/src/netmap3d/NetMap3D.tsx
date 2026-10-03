import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { createScene, resizeScene, disposeScene, type SceneContext } from './scene';
import { createStarField, updateStarField } from './skybox';
import { createAgent3D, updateAgent3D, disposeAgent3D, type Agent3D, type Agent3DLabels } from './agentMesh';
import { IpMeshPool, statusToColor3D, type IpInstance } from './ipMesh';
import { createOrbitRings, disposeOrbitRings, getOrbitPosition3D } from './orbitRing';
import { setupInteractions, flyTo, type Pick3D } from './interactions';
import { SCALE, PEER_COLORS, PALETTE_3D } from './constants3d';
import { IPS_PER_ORBIT_RING } from '../netmap/constants';
import { anonIp } from '../utils/anonymize';
import type { AgentNode, IpNode, AgentPeerLink } from '../netmap/types';

/** Translated strings of the 3D view (labels, tooltip, overflow note). */
export interface NetMap3DLabels extends Agent3DLabels {
  online: string;
  /** IP status → label. */
  status: (status: string) => string;
  /** "N IPs not rendered" note. */
  hiddenIps: (count: number) => string;
}

interface Props {
  agentsRef: React.MutableRefObject<AgentNode[]>;
  ipsRef: React.MutableRefObject<Map<string, IpNode>>;
  agentLinksRef: React.MutableRefObject<Map<string, AgentPeerLink>>;
  visibleAgentIds: Set<number> | null;
  threatOnly: boolean;
  searchHit: string | null;
  labels: NetMap3DLabels;
  onSelectAgent: (agent: AgentNode | null) => void;
  onSelectIp: (ip: IpNode | null) => void;
}

interface HoverTip {
  x: number; y: number;
  title: string;
  detail: string;
  color: string;
}

/** How long a search hit flashes (ms). */
const SEARCH_FLASH_MS = 4000;

const isThreat = (ip: IpNode) => ip.status === 'banned' || ip.status === 'suspicious';

export default function NetMap3D(props: Props) {
  const { agentsRef, ipsRef, agentLinksRef, searchHit, labels } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<SceneContext | null>(null);
  // Latest props for the animation loop and the interaction handlers, which
  // are bound once at mount (no stale filter / callback closures).
  const propsRef = useRef(props);
  propsRef.current = props;
  /** IPs in InstancedMesh order: instance i of the last frame = renderedIps[i]. */
  const renderedIpsRef = useRef<IpNode[]>([]);
  /** 3D position of each rendered IP in the last frame (search fly-to). */
  const ipPosRef = useRef<Map<string, THREE.Vector3>>(new Map());
  const flashRef = useRef<{ ip: string; until: number } | null>(null);
  const [hover, setHover] = useState<HoverTip | null>(null);
  const [hiddenIps, setHiddenIps] = useState(0);

  // ── Mount: scene, loop, interactions ─────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ctx = createScene(el);
    ctxRef.current = ctx;
    const agent3d = new Map<number, Agent3D>();
    const orbitGroups = new Map<number, THREE.Group>();
    const peerLines = new Map<string, THREE.Line>();
    let lastHidden = 0;

    // Stars
    const stars = createStarField();
    ctx.scene.add(stars);

    // IP pool
    const ipPool = new IpMeshPool();
    ctx.scene.add(ipPool.group);

    // ── Filters (read from the latest props every frame) ─────────────────
    const visibleAgents = (): AgentNode[] => {
      const vis = propsRef.current.visibleAgentIds;
      return vis ? agentsRef.current.filter(a => vis.has(a.id)) : agentsRef.current;
    };
    const filteredIps = (agentIds: Set<number>): IpNode[] => {
      const threatOnly = propsRef.current.threatOnly;
      const out: IpNode[] = [];
      for (const ip of ipsRef.current.values()) {
        if (!ip.agentIds.some(id => agentIds.has(id))) continue;
        if (threatOnly && !isThreat(ip)) continue;
        out.push(ip);
      }
      return out;
    };

    // ── Sync agents (+ threat tint from their orbiting threat IPs) ───────
    const syncAgents = (agents: AgentNode[], time: number) => {
      const threats = new Map<number, number>();
      for (const ip of ipsRef.current.values()) {
        if (!isThreat(ip)) continue;
        for (const id of ip.agentIds) threats.set(id, (threats.get(id) ?? 0) + 1);
      }
      const ids = new Set(agents.map(a => a.id));
      for (const [id, a3d] of agent3d) {
        if (!ids.has(id)) {
          ctx.scene.remove(a3d.group);
          disposeAgent3D(a3d);
          agent3d.delete(id);
        }
      }
      const lbl = propsRef.current.labels;
      for (const agent of agents) {
        let a3d = agent3d.get(agent.id);
        if (!a3d) {
          a3d = createAgent3D(agent, lbl);
          ctx.scene.add(a3d.group);
          agent3d.set(agent.id, a3d);
        }
        updateAgent3D(a3d, agent, time, threats.get(agent.id) ?? 0, lbl);
      }
    };

    // ── Sync orbit rings (visible agents only) ───────────────────────────
    const syncOrbitRings = (agents: AgentNode[], ipsPerAgent: Map<number, number>) => {
      const ids = new Set(agents.map(a => a.id));
      for (const [id, group] of orbitGroups) {
        if (!ids.has(id)) { ctx.scene.remove(group); disposeOrbitRings(group); orbitGroups.delete(id); }
      }
      for (const agent of agents) {
        const count = ipsPerAgent.get(agent.id) ?? 0;
        const ringCount = Math.max(0, Math.ceil(count / IPS_PER_ORBIT_RING));
        const oldGroup = orbitGroups.get(agent.id);
        if (oldGroup && oldGroup.children.length !== ringCount) {
          ctx.scene.remove(oldGroup);
          disposeOrbitRings(oldGroup);
          orbitGroups.delete(agent.id);
        }
        if (ringCount > 0 && !orbitGroups.has(agent.id)) {
          const group = createOrbitRings(ringCount);
          ctx.scene.add(group);
          orbitGroups.set(agent.id, group);
        }
        orbitGroups.get(agent.id)?.position.set(agent.x * SCALE, 0, agent.y * SCALE);
      }
    };

    // ── Sync IPs ──────────────────────────────────────────────────────────
    const syncIps = (agents: AgentNode[], ipsPerAgent: Map<number, number>) => {
      const agentMap = new Map(agents.map(a => [a.id, a]));
      const ips = filteredIps(new Set(agentMap.keys()));
      const rendered: IpNode[] = [];
      const positions: IpInstance[] = [];
      const posMap = new Map<string, THREE.Vector3>();
      const flash = flashRef.current;
      const now = Date.now();

      for (const ip of ips) {
        const agent = ip.agentIds.map(id => agentMap.get(id)).find(Boolean);
        if (!agent) continue;

        const agentPos = new THREE.Vector3(agent.x * SCALE, 0, agent.y * SCALE);
        const totalIps = ipsPerAgent.get(agent.id) ?? 1;
        const pos3d = getOrbitPosition3D(agentPos, ip.orbitSlot, totalIps, ip.orbitAngle, ip.orbitCurrentR);

        // Arrival animation — fly from far away toward orbit
        if (ip.arriveT < 1) {
          // Spawn point: far above in 3D space, offset from agent
          const spawnDir = new THREE.Vector3(
            (ip.spawnX - agent.x) * SCALE,
            80, // high above
            (ip.spawnY - agent.y) * SCALE,
          ).normalize().multiplyScalar(120);
          const spawn = agentPos.clone().add(spawnDir);
          // Smooth ease-in
          const t = ip.arriveT;
          const ease = t * t * (3 - 2 * t); // smoothstep
          pos3d.lerpVectors(spawn, pos3d, ease);
        }

        // Search hit: blink white while the flash lasts
        const flashing = flash !== null && flash.ip === ip.ip && now < flash.until && Math.floor(now / 250) % 2 === 0;
        rendered.push(ip);
        posMap.set(ip.ip, pos3d);
        positions.push({
          x: pos3d.x, y: pos3d.y, z: pos3d.z,
          radius: flashing ? ip.dotR * 2 : ip.dotR,
          color: flashing ? PALETTE_3D.white : statusToColor3D(ip.status),
        });
      }

      ipPool.update(positions);
      renderedIpsRef.current = rendered.slice(0, ipPool.mesh.count);
      ipPosRef.current = posMap;
      if (ipPool.hidden !== lastHidden) {
        lastHidden = ipPool.hidden;
        setHiddenIps(lastHidden);
      }
    };

    // ── Sync peer links (both ends visible) ──────────────────────────────
    const syncPeerLinks = (agents: AgentNode[]) => {
      const agentMap = new Map(agents.map(a => [a.id, a]));
      const links = agentLinksRef.current;

      for (const [key, line] of peerLines) {
        const link = links.get(key);
        if (!link || !agentMap.has(link.sourceId) || !agentMap.has(link.targetId)) {
          ctx.scene.remove(line);
          line.geometry.dispose();
          (line.material as THREE.Material).dispose();
          peerLines.delete(key);
        }
      }

      for (const [key, link] of links) {
        const src = agentMap.get(link.sourceId);
        const tgt = agentMap.get(link.targetId);
        if (!src || !tgt) continue;

        const srcPos = new THREE.Vector3(src.x * SCALE, 0, src.y * SCALE);
        const tgtPos = new THREE.Vector3(tgt.x * SCALE, 0, tgt.y * SCALE);
        const midY = srcPos.distanceTo(tgtPos) * 0.15; // arc height proportional to distance
        const curve = new THREE.CatmullRomCurve3([
          srcPos,
          new THREE.Vector3((srcPos.x + tgtPos.x) / 2, midY, (srcPos.z + tgtPos.z) / 2),
          tgtPos,
        ]);
        const points = curve.getPoints(50);

        const line = peerLines.get(key);
        if (!line) {
          const geo = new THREE.BufferGeometry().setFromPoints(points);
          const mat = new THREE.LineBasicMaterial({
            color: PEER_COLORS[link.type],
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
          });
          const created = new THREE.Line(geo, mat);
          ctx.scene.add(created);
          peerLines.set(key, created);
        } else {
          const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
          for (let i = 0; i < Math.min(points.length, positions.count); i++) {
            positions.setXYZ(i, points[i].x, points[i].y, points[i].z);
          }
          positions.needsUpdate = true;
        }
      }
    };

    // ── Interactions ─────────────────────────────────────────────────────
    const tipFor = (hit: Pick3D): Omit<HoverTip, 'x' | 'y'> | null => {
      const lbl = propsRef.current.labels;
      if (hit.type === 'agent') {
        const ag = agentsRef.current.find(a => a.id === hit.id);
        if (!ag) return null;
        const state = ag.wsConnected ? lbl.online : lbl.offline;
        return {
          title: ag.label,
          detail: ag.evaluateOnly
            ? `${state} · ${lbl.deviceType(ag.deviceType)} · ${lbl.evaluateOnly}`
            : `${state} · ${lbl.deviceType(ag.deviceType)}`,
          color: ag.deviceColor,
        };
      }
      const ip = renderedIpsRef.current[hit.index];
      if (!ip) return null;
      return {
        title: `${ip.flag} ${anonIp(ip.ip)}`,
        detail: ip.failures > 0 ? `${lbl.status(ip.status)} · ${ip.failures}×` : lbl.status(ip.status),
        color: ip.color,
      };
    };

    const cleanupInteractions = setupInteractions(
      ctx, el,
      (hit, x, y) => {
        const tip = hit ? tipFor(hit) : null;
        setHover(tip ? { ...tip, x, y } : null);
      },
      (hit) => {
        if (hit.type === 'agent') {
          const ag = agentsRef.current.find(a => a.id === hit.id);
          propsRef.current.onSelectAgent(ag ?? null);
        } else {
          const ip = renderedIpsRef.current[hit.index];
          if (ip) propsRef.current.onSelectIp(ip);
        }
      },
      (pos) => {
        flyTo(ctx.controls, ctx.camera, pos);
      },
    );

    // Resize observer
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) resizeScene(ctx, width, height);
    });
    ro.observe(el);

    // ── Animation loop ───────────────────────────────────────────────────
    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const time = ctx.clock.getElapsedTime();

      ctx.controls.update();
      updateStarField(stars, time);

      const agents = visibleAgents();
      // Orbit slots count the single-agent IPs of each agent (as in 2D)
      const ipsPerAgent = new Map<number, number>();
      for (const ip of ipsRef.current.values()) {
        if (ip.agentIds.length === 1) {
          const aid = ip.agentIds[0];
          ipsPerAgent.set(aid, (ipsPerAgent.get(aid) ?? 0) + 1);
        }
      }

      syncAgents(agents, time);
      syncOrbitRings(agents, ipsPerAgent);
      syncIps(agents, ipsPerAgent);
      syncPeerLinks(agents);

      // Render
      ctx.composer.render();
      ctx.labelRenderer.render(ctx.scene, ctx.camera);
    };
    raf = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(raf);
      cleanupInteractions();
      ro.disconnect();
      for (const a3d of agent3d.values()) { ctx.scene.remove(a3d.group); disposeAgent3D(a3d); }
      for (const group of orbitGroups.values()) { ctx.scene.remove(group); disposeOrbitRings(group); }
      for (const line of peerLines.values()) {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      ipPool.dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      disposeScene(ctx);
      ctxRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Search: fly to the hit and flash it ──────────────────────────────────
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!searchHit || !ctx) return;
    flashRef.current = { ip: searchHit, until: Date.now() + SEARCH_FLASH_MS };
    let target = ipPosRef.current.get(searchHit)?.clone();
    if (!target) {
      // Not rendered this frame (e.g. filtered out): aim at its agent.
      const node = ipsRef.current.get(searchHit);
      const ag = node && agentsRef.current.find(a => node.agentIds.includes(a.id));
      if (ag) target = new THREE.Vector3(ag.x * SCALE, 0, ag.y * SCALE);
    }
    if (target) flyTo(ctx.controls, ctx.camera, target);
  }, [searchHit, ipsRef, agentsRef]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative"
      style={{ background: PALETTE_3D.spaceCss }}
    >
      {hover && (
        <div
          className="absolute z-20 pointer-events-none rounded px-2.5 py-1.5 max-w-[260px]"
          style={{
            left: hover.x + 14,
            top: hover.y - 8,
            backgroundColor: PALETTE_3D.tooltip.bg,
            border: `1px solid ${PALETTE_3D.tooltip.border}`,
            boxShadow: `0 4px 24px ${PALETTE_3D.tooltip.shadow}`,
          }}
        >
          <div className="font-mono text-[13px] font-bold truncate" style={{ color: hover.color }}>{hover.title}</div>
          <div className="font-mono text-[10px] text-slate-400 uppercase tracking-wider">{hover.detail}</div>
        </div>
      )}
      {hiddenIps > 0 && (
        <div className="absolute bottom-3 right-3 z-20 pointer-events-none font-mono text-[10px] text-amber-400/80">
          {labels.hiddenIps(hiddenIps)}
        </div>
      )}
    </div>
  );
}
