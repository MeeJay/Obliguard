import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { DEVICE_COLORS, AGENT_RADIUS, SCALE } from './constants3d';
import type { AgentNode } from '../netmap/types';

export interface Agent3D {
  id: number;
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  glowMesh: THREE.Mesh;
  ringMesh: THREE.Mesh;
  label: CSS2DObject;
  phase: number;
}

const sphereGeo = new THREE.SphereGeometry(1, 48, 48);
const ringGeo = new THREE.RingGeometry(1.3, 1.5, 64);

export function createAgent3D(agent: AgentNode): Agent3D {
  const color = new THREE.Color(DEVICE_COLORS[agent.deviceType] ?? DEVICE_COLORS.default);
  const group = new THREE.Group();
  group.userData.agentId = agent.id;

  // Core sphere — luminous body
  const coreMat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: agent.wsConnected ? 0.8 : 0.15,
    roughness: 0.2,
    metalness: 0.3,
  });
  const coreMesh = new THREE.Mesh(sphereGeo, coreMat);
  const r = AGENT_RADIUS * (0.8 + Math.min(agent.eventCount / 200, 0.8));
  coreMesh.scale.setScalar(r);
  group.add(coreMesh);

  // Glow halo — larger additive sphere
  const glowMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: agent.wsConnected ? 0.15 : 0.03,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const glowMesh = new THREE.Mesh(sphereGeo, glowMat);
  glowMesh.scale.setScalar(r * 4.0);
  group.add(glowMesh);

  // Equatorial ring — like Saturn, adds visual interest
  const ringMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: agent.wsConnected ? 0.12 : 0.03,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.scale.setScalar(r * 2.5);
  ringMesh.rotation.x = Math.PI / 2; // horizontal ring
  group.add(ringMesh);

  // Position from 2D coords → 3D
  group.position.set(agent.x * SCALE, 0, agent.y * SCALE);

  // Label
  const labelDiv = document.createElement('div');
  labelDiv.className = 'netmap3d-label';
  labelDiv.innerHTML = `
    <div style="font-family:'Inter','Segoe UI',sans-serif; text-align:center; pointer-events:none;">
      <div style="font-size:12px; font-weight:700; color:rgba(220,235,255,0.9); text-shadow:0 0 10px rgba(0,0,0,1), 0 0 20px ${color.getStyle()}40; letter-spacing:0.8px;">
        ${agent.label}
      </div>
      <div style="font-size:9px; color:${agent.wsConnected ? 'rgba(93,202,165,0.7)' : 'rgba(226,75,74,0.7)'}; text-transform:uppercase; letter-spacing:1.5px; margin-top:2px;">
        ${agent.wsConnected ? agent.deviceType : 'OFFLINE'}
      </div>
    </div>
  `;
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, -(r + 2.5), 0);
  group.add(label);

  return { id: agent.id, group, coreMesh, glowMesh, ringMesh, label, phase: agent.phase };
}

export function updateAgent3D(a3d: Agent3D, agent: AgentNode, time: number): void {
  // Position sync
  a3d.group.position.set(agent.x * SCALE, 0, agent.y * SCALE);

  const r = AGENT_RADIUS * (0.8 + Math.min(agent.eventCount / 200, 0.8));

  // Pulse — gentle breathing
  const pulse = 1.0 + 0.04 * Math.sin(time * 1.2 + a3d.phase);
  a3d.coreMesh.scale.setScalar(r * pulse);

  // Glow pulse — slightly out of phase
  const glowPulse = 1.0 + 0.06 * Math.sin(time * 0.8 + a3d.phase + 1.0);
  a3d.glowMesh.scale.setScalar(r * 4.0 * glowPulse);

  // Ring slow rotation
  a3d.ringMesh.rotation.z = time * 0.15 + a3d.phase;
  a3d.ringMesh.scale.setScalar(r * 2.5 * pulse);

  // Online/offline emissive
  const mat = a3d.coreMesh.material as THREE.MeshStandardMaterial;
  mat.emissiveIntensity = agent.wsConnected ? 0.8 : 0.15;
  const glowMat = a3d.glowMesh.material as THREE.MeshBasicMaterial;
  glowMat.opacity = agent.wsConnected ? 0.15 + 0.05 * Math.sin(time * 0.8 + a3d.phase) : 0.03;
  const ringMat = a3d.ringMesh.material as THREE.MeshBasicMaterial;
  ringMat.opacity = agent.wsConnected ? 0.12 + 0.03 * Math.sin(time + a3d.phase) : 0.03;
}
