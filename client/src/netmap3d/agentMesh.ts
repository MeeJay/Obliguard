import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  DEVICE_COLORS, AGENT_RADIUS, SCALE, PALETTE_3D, THREAT_TINT_FULL, THREAT_TINT_MAX,
} from './constants3d';
import type { AgentNode } from '../netmap/types';

/** Translated strings of the agent labels (the page passes them in). */
export interface Agent3DLabels {
  offline: string;
  evaluateOnly: string;
  evaluateOnlyTooltip: string;
  /** Device type (firewall / server / …) → label. */
  deviceType: (type: string) => string;
}

export interface Agent3D {
  id: number;
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  label: CSS2DObject;
  phase: number;
  /** Device colour (emissive base before the threat tint). */
  baseColor: THREE.Color;
  /** Label lines, kept to update them in place (textContent only). */
  nameEl: HTMLDivElement;
  stateEl: HTMLDivElement;
  evalEl: HTMLDivElement;
  /** Last rendered label state, to touch the DOM only on a change. */
  shown: { name: string; state: string; online: boolean; evaluateOnly: boolean };
}

const sphereGeo = new THREE.SphereGeometry(1, 32, 32);
const threatColor = new THREE.Color(PALETTE_3D.threat);
const scratchColor = new THREE.Color();

function agentRadius(agent: AgentNode): number {
  return AGENT_RADIUS * (0.6 + Math.min(agent.eventCount / 300, 0.6));
}

/** One label line; the text is always set through textContent (no markup). */
function labelLine(css: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = css;
  return el;
}

export function createAgent3D(agent: AgentNode, labels: Agent3DLabels): Agent3D {
  const baseColor = new THREE.Color(DEVICE_COLORS[agent.deviceType] ?? DEVICE_COLORS.default);
  const group = new THREE.Group();
  group.userData.agentId = agent.id;

  // Single bright core — bloom does the glow work
  const coreMat = new THREE.MeshStandardMaterial({
    color: PALETTE_3D.black,
    emissive: baseColor.clone(),
    emissiveIntensity: agent.wsConnected ? 2.0 : 0.3,
    roughness: 0.1,
    metalness: 0.0,
  });
  const coreMesh = new THREE.Mesh(sphereGeo, coreMat);
  const r = agentRadius(agent);
  coreMesh.scale.setScalar(r);
  group.add(coreMesh);

  // Position from 2D coords → 3D
  group.position.set(agent.x * SCALE, 0, agent.y * SCALE);

  // Label — small, clean, NASA-style. Built node by node: the agent name is
  // tenant-controlled data, so it is only ever set as text (textContent).
  const labelDiv = document.createElement('div');
  labelDiv.className = 'netmap3d-label';
  labelDiv.style.cssText = "font-family:'Inter','Segoe UI',sans-serif; text-align:center; pointer-events:none; white-space:nowrap;";
  const nameEl = labelLine(`font-size:10px; font-weight:600; color:${PALETTE_3D.label.name}; text-shadow:0 0 4px ${PALETTE_3D.label.shadow}; letter-spacing:0.8px;`);
  const stateEl = labelLine('font-size:7px; text-transform:uppercase; letter-spacing:1.5px;');
  const evalEl = labelLine(`font-size:7px; text-transform:uppercase; letter-spacing:1.5px; color:${PALETTE_3D.evaluateCss};`);
  labelDiv.append(nameEl, stateEl, evalEl);
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, -(r + 1.8), 0);
  group.add(label);

  const a3d: Agent3D = {
    id: agent.id, group, coreMesh, label, phase: agent.phase, baseColor,
    nameEl, stateEl, evalEl,
    shown: { name: '', state: '', online: !agent.wsConnected, evaluateOnly: !agent.evaluateOnly },
  };
  syncLabel(a3d, agent, labels);
  return a3d;
}

/** Update the label lines when the agent's name / state / mode changed. */
function syncLabel(a3d: Agent3D, agent: AgentNode, labels: Agent3DLabels): void {
  const state = agent.wsConnected ? labels.deviceType(agent.deviceType) : labels.offline;
  const s = a3d.shown;
  if (s.name !== agent.label) {
    a3d.nameEl.textContent = agent.label;
    s.name = agent.label;
  }
  if (s.state !== state || s.online !== agent.wsConnected) {
    a3d.stateEl.textContent = state;
    a3d.stateEl.style.color = agent.wsConnected ? PALETTE_3D.label.online : PALETTE_3D.label.offline;
    s.state = state;
    s.online = agent.wsConnected;
  }
  if (s.evaluateOnly !== agent.evaluateOnly) {
    a3d.evalEl.textContent = agent.evaluateOnly ? labels.evaluateOnly : '';
    a3d.evalEl.title = agent.evaluateOnly ? labels.evaluateOnlyTooltip : '';
    a3d.evalEl.style.display = agent.evaluateOnly ? '' : 'none';
    s.evaluateOnly = agent.evaluateOnly;
  }
}

/**
 * Per-frame update. `threatIps` = banned + suspicious IPs orbiting the agent:
 * the emissive colour drifts toward the threat red with it (the 2D heat glow).
 */
export function updateAgent3D(
  a3d: Agent3D, agent: AgentNode, time: number, threatIps: number, labels: Agent3DLabels,
): void {
  // Position sync
  a3d.group.position.set(agent.x * SCALE, 0, agent.y * SCALE);

  const r = agentRadius(agent);

  // Gentle pulse — subtle breathing
  const pulse = 1.0 + 0.02 * Math.sin(time * 1.0 + a3d.phase);
  a3d.coreMesh.scale.setScalar(r * pulse);
  a3d.label.position.set(0, -(r + 1.8), 0);

  // Emissive intensity drives bloom halo naturally
  const mat = a3d.coreMesh.material as THREE.MeshStandardMaterial;
  mat.emissiveIntensity = agent.wsConnected
    ? 2.0 + 0.3 * Math.sin(time * 0.6 + a3d.phase)
    : 0.3;

  // Threat tint
  const tint = Math.min(threatIps / THREAT_TINT_FULL, 1) * THREAT_TINT_MAX;
  scratchColor.copy(a3d.baseColor).lerp(threatColor, tint);
  if (!mat.emissive.equals(scratchColor)) mat.emissive.copy(scratchColor);

  syncLabel(a3d, agent, labels);
}

/**
 * Free the agent's material (the sphere geometry is shared) and drop its
 * label element: CSS2DRenderer only removes it when the label itself leaves
 * its parent, not when the agent group leaves the scene.
 */
export function disposeAgent3D(a3d: Agent3D): void {
  (a3d.coreMesh.material as THREE.Material).dispose();
  a3d.label.element.remove();
}
