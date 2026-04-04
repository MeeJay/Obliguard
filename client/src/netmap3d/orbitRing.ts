import * as THREE from 'three';
import { ORBIT_RING_GAP_3D, AGENT_RADIUS } from './constants3d';

const GOLDEN_ANGLE = 2.399963;

/**
 * Creates a set of 3D orbit ring LineLoops around an agent position.
 * Each ring is inclined differently for a 3D asteroid-belt effect.
 */
export function createOrbitRings(ringCount: number): THREE.Group {
  const group = new THREE.Group();

  for (let i = 0; i < ringCount; i++) {
    const radius = AGENT_RADIUS + 3 + i * ORBIT_RING_GAP_3D;
    const curve = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2, false, 0);
    const points = curve.getPoints(128);
    const geo = new THREE.BufferGeometry().setFromPoints(
      points.map(p => new THREE.Vector3(p.x, 0, p.y)),
    );
    const mat = new THREE.LineBasicMaterial({
      color: 0x4a8abb,
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
    });
    const ring = new THREE.LineLoop(geo, mat);

    // Incline each ring differently (golden angle distribution)
    ring.rotation.x = (i * GOLDEN_ANGLE * 0.15) % (Math.PI * 0.4);
    ring.rotation.z = (i * GOLDEN_ANGLE * 0.1) % (Math.PI * 0.3);

    group.add(ring);
  }

  return group;
}

/**
 * Get the 3D orbit position for an IP around its agent.
 */
export function getOrbitPosition3D(
  agentPos: THREE.Vector3,
  orbitSlot: number,
  totalSlots: number,
  orbitAngle: number,
  orbitCurrentR: number,
): THREE.Vector3 {
  // Map the 2D orbit radius to 3D
  const r3d = orbitCurrentR * 0.15; // same SCALE factor
  if (r3d <= 0) return agentPos.clone();

  // Ring index for inclination
  const ringCount = Math.max(1, Math.ceil(totalSlots / 20));
  const ringIndex = orbitSlot % ringCount;
  const inclX = (ringIndex * GOLDEN_ANGLE * 0.15) % (Math.PI * 0.4);
  const inclZ = (ringIndex * GOLDEN_ANGLE * 0.1) % (Math.PI * 0.3);

  // Position on flat circle
  const x = Math.cos(orbitAngle) * r3d;
  const z = Math.sin(orbitAngle) * r3d;

  // Apply inclination rotation
  const cosX = Math.cos(inclX), sinX = Math.sin(inclX);
  const cosZ = Math.cos(inclZ), sinZ = Math.sin(inclZ);

  // Rotate around X axis
  const y1 = -z * sinX;
  const z1 = z * cosX;

  // Rotate around Z axis
  const x2 = x * cosZ - y1 * sinZ;
  const y2 = x * sinZ + y1 * cosZ;

  return new THREE.Vector3(
    agentPos.x + x2,
    agentPos.y + y2,
    agentPos.z + z1,
  );
}
