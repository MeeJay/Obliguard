import * as THREE from 'three';
import type { SceneContext } from './scene';
import { HOVER_THROTTLE_MS } from './constants3d';

/** What the pointer is over: an agent (id) or an IP (instance index). */
export type Pick3D =
  | { type: 'agent'; id: number }
  | { type: 'ip'; index: number };

/** A click that moved more than this (px) was an orbit drag, not a pick. */
const CLICK_SLOP_PX = 5;

/**
 * Setup mouse interaction handlers for the 3D scene.
 * Returns a cleanup function.
 *
 * `onHover` gets the pick under the pointer (throttled) with the pointer
 * position relative to the container, or null when it left every object.
 */
export function setupInteractions(
  ctx: SceneContext,
  container: HTMLElement,
  onHover: (pick: Pick3D | null, x: number, y: number) => void,
  onClick: (pick: Pick3D) => void,
  onDoubleClick: (position: THREE.Vector3) => void,
): () => void {
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2(-999, -999);
  let lastHover = 0;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let down: { x: number; y: number } | null = null;
  /** A button is held (orbit / pan drag): hover raycasts pause. */
  let pressed = false;

  const setMouse = (e: MouseEvent) => {
    const rect = container.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** Agent meshes (children of the groups tagged with agentId) and the IP pool. */
  const collect = () => {
    const agentMeshes: THREE.Object3D[] = [];
    let ipPoolMesh: THREE.InstancedMesh | null = null;
    ctx.scene.traverse((obj) => {
      if (obj.userData.agentId != null) {
        for (const child of obj.children) if (child instanceof THREE.Mesh) agentMeshes.push(child);
      }
      if (obj.userData.isIpPool && obj instanceof THREE.InstancedMesh) ipPoolMesh = obj;
    });
    return { agentMeshes, ipPoolMesh: ipPoolMesh as THREE.InstancedMesh | null };
  };

  const pick = (): Pick3D | null => {
    raycaster.setFromCamera(mouse, ctx.camera);
    const { agentMeshes, ipPoolMesh } = collect();

    // Agents first
    const agentHits = raycaster.intersectObjects(agentMeshes, false);
    if (agentHits.length > 0) {
      // Walk up to find the group with agentId
      let obj: THREE.Object3D | null = agentHits[0].object;
      while (obj && obj.userData.agentId == null) obj = obj.parent;
      if (obj?.userData.agentId != null) return { type: 'agent', id: obj.userData.agentId as number };
    }

    // IPs (instanced mesh — use instanceId)
    if (ipPoolMesh) {
      const ipHits = raycaster.intersectObject(ipPoolMesh, false);
      if (ipHits.length > 0 && ipHits[0].instanceId != null) return { type: 'ip', index: ipHits[0].instanceId };
    }
    return null;
  };

  const onMouseMove = (e: MouseEvent) => {
    const pos = setMouse(e);
    if (pressed) return; // orbiting: no hover raycasts
    const run = () => {
      hoverTimer = null;
      lastHover = performance.now();
      onHover(pick(), pos.x, pos.y);
    };
    const wait = HOVER_THROTTLE_MS - (performance.now() - lastHover);
    if (wait <= 0) run();
    else if (!hoverTimer) hoverTimer = setTimeout(run, wait);
  };

  const onMouseLeave = () => {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    mouse.set(-999, -999);
    onHover(null, 0, 0);
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    pressed = true;
  };

  const onMouseUp = () => { pressed = false; };

  const onClickHandler = (e: MouseEvent) => {
    if (e.button !== 0) return; // left click only
    const start = down;
    down = null;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return;
    setMouse(e);
    const hit = pick();
    if (hit) onClick(hit);
  };

  const onDblClick = (e: MouseEvent) => {
    setMouse(e);
    raycaster.setFromCamera(mouse, ctx.camera);
    const hits = raycaster.intersectObjects(collect().agentMeshes, false);
    if (hits.length > 0) {
      onDoubleClick(hits[0].point);
    }
  };

  container.addEventListener('mousemove', onMouseMove);
  container.addEventListener('mouseleave', onMouseLeave);
  container.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  container.addEventListener('click', onClickHandler);
  container.addEventListener('dblclick', onDblClick);

  return () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    container.removeEventListener('mousemove', onMouseMove);
    container.removeEventListener('mouseleave', onMouseLeave);
    container.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    container.removeEventListener('click', onClickHandler);
    container.removeEventListener('dblclick', onDblClick);
  };
}

/**
 * Smooth camera fly-to animation.
 */
export function flyTo(
  controls: { target: THREE.Vector3; update: () => void },
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  duration = 1.5,
): void {
  const start = camera.position.clone();
  const startTarget = controls.target.clone();
  const dir = target.clone().sub(camera.position).normalize();
  const endPos = target.clone().sub(dir.multiplyScalar(30));
  const startTime = performance.now();

  function animate() {
    const elapsed = (performance.now() - startTime) / 1000;
    const t = Math.min(elapsed / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    camera.position.lerpVectors(start, endPos, ease);
    controls.target.lerpVectors(startTarget, target, ease);
    controls.update();

    if (t < 1) requestAnimationFrame(animate);
  }
  animate();
}
