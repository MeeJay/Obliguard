import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { DEVICE_COLORS, AGENT_RADIUS, SCALE } from './constants3d';
import type { AgentNode } from '../netmap/types';

export interface Agent3D {
  id: number;
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  glowMesh: THREE.Mesh;
  label: CSS2DObject;
  phase: number;
}

const sphereGeo = new THREE.SphereGeometry(1, 32, 32);

export function createAgent3D(agent: AgentNode): Agent3D {
  const color = new THREE.Color(DEVICE_COLORS[agent.deviceType] ?? DEVICE_COLORS.default);
  const group = new THREE.Group();
  group.userData.agentId = agent.id;

  // Core sphere
  const coreMat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: agent.wsConnected ? 0.6 : 0.1,
    roughness: 0.3,
    metalness: 0.1,
  });
  const coreMesh = new THREE.Mesh(sphereGeo, coreMat);
  const r = AGENT_RADIUS * (0.8 + Math.min(agent.eventCount / 200, 0.8));
  coreMesh.scale.setScalar(r);
  group.add(coreMesh);

  // Glow halo (additive blend)
  const glowMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: agent.wsConnected ? 0.12 : 0.03,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowMesh = new THREE.Mesh(sphereGeo, glowMat);
  glowMesh.scale.setScalar(r * 3.5);
  group.add(glowMesh);

  // Position from 2D coords → 3D
  group.position.set(agent.x * SCALE, 0, agent.y * SCALE);

  // Label
  const labelDiv = document.createElement('div');
  labelDiv.className = 'netmap3d-label';
  labelDiv.innerHTML = `
    <div style="font-family:'Inter',sans-serif; text-align:center; pointer-events:none;">
      <div style="font-size:11px; font-weight:600; color:rgba(200,220,240,0.85); text-shadow:0 0 6px rgba(0,0,0,0.9); letter-spacing:0.5px;">
        ${agent.label}
      </div>
      <div style="font-size:8px; color:${agent.wsConnected ? 'rgba(93,202,165,0.6)' : 'rgba(226,75,74,0.6)'}; text-transform:uppercase; letter-spacing:1px;">
        ${agent.wsConnected ? agent.deviceType : 'OFFLINE'}
      </div>
    </div>
  `;
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, -(r + 1.5), 0);
  group.add(label);

  return { id: agent.id, group, coreMesh, glowMesh, label, phase: agent.phase };
}

export function updateAgent3D(a3d: Agent3D, agent: AgentNode, time: number): void {
  // Position sync
  a3d.group.position.set(agent.x * SCALE, 0, agent.y * SCALE);

  // Pulse
  const pulse = 1.0 + 0.03 * Math.sin(time * 1.5 + a3d.phase);
  a3d.coreMesh.scale.setScalar(
    AGENT_RADIUS * (0.8 + Math.min(agent.eventCount / 200, 0.8)) * pulse,
  );

  // Online/offline emissive
  const mat = a3d.coreMesh.material as THREE.MeshStandardMaterial;
  mat.emissiveIntensity = agent.wsConnected ? 0.6 : 0.1;
  const glowMat = a3d.glowMesh.material as THREE.MeshBasicMaterial;
  glowMat.opacity = agent.wsConnected ? 0.12 + 0.03 * Math.sin(time + a3d.phase) : 0.03;
}
