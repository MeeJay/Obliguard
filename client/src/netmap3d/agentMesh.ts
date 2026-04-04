import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { DEVICE_COLORS, AGENT_RADIUS, SCALE } from './constants3d';
import type { AgentNode } from '../netmap/types';

export interface Agent3D {
  id: number;
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  label: CSS2DObject;
  phase: number;
}

const sphereGeo = new THREE.SphereGeometry(1, 32, 32);

export function createAgent3D(agent: AgentNode): Agent3D {
  const color = new THREE.Color(DEVICE_COLORS[agent.deviceType] ?? DEVICE_COLORS.default);
  const group = new THREE.Group();
  group.userData.agentId = agent.id;

  // Single bright core — bloom does the glow work
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: color,
    emissiveIntensity: agent.wsConnected ? 2.0 : 0.3,
    roughness: 0.1,
    metalness: 0.0,
  });
  const coreMesh = new THREE.Mesh(sphereGeo, coreMat);
  const r = AGENT_RADIUS * (0.6 + Math.min(agent.eventCount / 300, 0.6));
  coreMesh.scale.setScalar(r);
  group.add(coreMesh);

  // Position from 2D coords → 3D
  group.position.set(agent.x * SCALE, 0, agent.y * SCALE);

  // Label — small, clean, NASA-style
  const labelDiv = document.createElement('div');
  labelDiv.className = 'netmap3d-label';
  labelDiv.innerHTML = `
    <div style="font-family:'Inter','Segoe UI',sans-serif; text-align:center; pointer-events:none; white-space:nowrap;">
      <div style="font-size:10px; font-weight:600; color:rgba(200,215,235,0.75); text-shadow:0 0 4px rgba(0,0,0,1); letter-spacing:0.8px;">
        ${agent.label}
      </div>
      <div style="font-size:7px; color:${agent.wsConnected ? 'rgba(93,202,165,0.5)' : 'rgba(226,75,74,0.5)'}; text-transform:uppercase; letter-spacing:1.5px;">
        ${agent.wsConnected ? agent.deviceType : 'OFFLINE'}
      </div>
    </div>
  `;
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, -(r + 1.8), 0);
  group.add(label);

  return { id: agent.id, group, coreMesh, label, phase: agent.phase };
}

export function updateAgent3D(a3d: Agent3D, agent: AgentNode, time: number): void {
  // Position sync
  a3d.group.position.set(agent.x * SCALE, 0, agent.y * SCALE);

  const r = AGENT_RADIUS * (0.6 + Math.min(agent.eventCount / 300, 0.6));

  // Gentle pulse — subtle breathing
  const pulse = 1.0 + 0.02 * Math.sin(time * 1.0 + a3d.phase);
  a3d.coreMesh.scale.setScalar(r * pulse);

  // Emissive intensity drives bloom halo naturally
  const mat = a3d.coreMesh.material as THREE.MeshStandardMaterial;
  mat.emissiveIntensity = agent.wsConnected
    ? 2.0 + 0.3 * Math.sin(time * 0.6 + a3d.phase)
    : 0.3;
}
