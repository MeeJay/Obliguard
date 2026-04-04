import * as THREE from 'three';
import { STATUS_COLORS, IP_RADIUS_MIN, IP_RADIUS_MAX } from './constants3d';

/**
 * InstancedMesh pool for all IP dots — single draw call for hundreds of IPs.
 */
export class IpMeshPool {
  mesh: THREE.InstancedMesh;
  private maxCount: number;
  private colorAttr: THREE.InstancedBufferAttribute;
  private dummy = new THREE.Object3D();

  constructor(maxCount = 1000) {
    this.maxCount = maxCount;
    const geo = new THREE.SphereGeometry(1, 12, 12);
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.4,
      metalness: 0.1,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.3,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    // Per-instance color
    const colors = new Float32Array(maxCount * 3);
    this.colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
    this.mesh.instanceColor = this.colorAttr;

    // Start with 0 visible
    this.mesh.count = 0;
  }

  /**
   * Update all IP instances in one pass.
   */
  update(
    positions: { x: number; y: number; z: number; radius: number; color: number }[],
  ): void {
    const count = Math.min(positions.length, this.maxCount);
    this.mesh.count = count;

    for (let i = 0; i < count; i++) {
      const p = positions[i];
      this.dummy.position.set(p.x, p.y, p.z);
      const r = IP_RADIUS_MIN + (p.radius / 8) * (IP_RADIUS_MAX - IP_RADIUS_MIN);
      this.dummy.scale.setScalar(Math.max(r, IP_RADIUS_MIN));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      const col = new THREE.Color(p.color);
      this.colorAttr.setXYZ(i, col.r, col.g, col.b);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }
}

export function statusToColor3D(status: string): number {
  if (status === 'banned') return STATUS_COLORS.banned;
  if (status === 'suspicious') return STATUS_COLORS.suspicious;
  if (status === 'whitelisted') return STATUS_COLORS.whitelisted;
  return STATUS_COLORS.clean;
}
