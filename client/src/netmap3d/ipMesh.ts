import * as THREE from 'three';
import {
  STATUS_COLORS, IP_RADIUS_MIN, IP_RADIUS_MAX, IP_POOL_INITIAL, IP_POOL_MAX, PALETTE_3D,
} from './constants3d';

/** One IP instance of a frame. */
export interface IpInstance {
  x: number; y: number; z: number;
  radius: number;
  color: number;
}

/**
 * InstancedMesh pool for all IP dots — single draw call for hundreds of IPs.
 * Uses emissive glow so IPs are self-illuminating like NASA Eyes.
 *
 * The pool grows (capacity ×2, up to IP_POOL_MAX) when a frame carries more
 * IPs than it holds: the InstancedMesh is rebuilt inside `group`, which stays
 * in the scene. IPs beyond the hard cap are counted in `hidden`.
 */
export class IpMeshPool {
  /** Add this to the scene once; the instanced mesh lives inside it. */
  readonly group = new THREE.Group();
  mesh: THREE.InstancedMesh;
  /** IPs of the last frame that did not fit under IP_POOL_MAX. */
  hidden = 0;
  private capacity: number;
  private colorAttr!: THREE.InstancedBufferAttribute;
  private readonly geo = new THREE.SphereGeometry(1, 16, 16);
  private readonly mat = new THREE.MeshStandardMaterial({
    color: PALETTE_3D.black,
    roughness: 0.1,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE_3D.white),
    emissiveIntensity: 1.2,
  });
  private readonly dummy = new THREE.Object3D();
  private readonly scratch = new THREE.Color();

  constructor(initialCapacity = IP_POOL_INITIAL) {
    this.capacity = Math.max(1, Math.min(initialCapacity, IP_POOL_MAX));
    this.mesh = this.build(this.capacity);
  }

  private build(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.userData.isIpPool = true;

    // Per-instance color
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor = this.colorAttr;
    mesh.count = 0;
    this.group.add(mesh);
    return mesh;
  }

  private grow(needed: number): void {
    let capacity = this.capacity;
    while (capacity < needed && capacity < IP_POOL_MAX) capacity *= 2;
    capacity = Math.min(capacity, IP_POOL_MAX);
    if (capacity === this.capacity) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.capacity = capacity;
    this.mesh = this.build(capacity);
  }

  update(positions: IpInstance[]): void {
    if (positions.length > this.capacity) this.grow(positions.length);
    const count = Math.min(positions.length, this.capacity);
    this.hidden = positions.length - count;
    this.mesh.count = count;

    for (let i = 0; i < count; i++) {
      const p = positions[i];
      this.dummy.position.set(p.x, p.y, p.z);
      const r = IP_RADIUS_MIN + (p.radius / 8) * (IP_RADIUS_MAX - IP_RADIUS_MIN);
      this.dummy.scale.setScalar(Math.max(r, IP_RADIUS_MIN));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      this.scratch.setHex(p.color);
      this.colorAttr.setXYZ(i, this.scratch.r, this.scratch.g, this.scratch.b);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  dispose(): void {
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}

export function statusToColor3D(status: string): number {
  if (status === 'banned') return STATUS_COLORS.banned;
  if (status === 'suspicious') return STATUS_COLORS.suspicious;
  if (status === 'whitelisted') return STATUS_COLORS.whitelisted;
  return STATUS_COLORS.clean;
}
