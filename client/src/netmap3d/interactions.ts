import * as THREE from 'three';
import type { SceneContext } from './scene';

/**
 * Setup mouse interaction handlers for the 3D scene.
 * Returns a cleanup function.
 */
export function setupInteractions(
  ctx: SceneContext,
  container: HTMLElement,
  _onHoverAgent: (agentId: number | null) => void,
  _onHoverIp: (ipIndex: number | null) => void,
  onClick: (type: 'agent' | 'ip', id: number | string) => void,
  onDoubleClick: (position: THREE.Vector3) => void,
): () => void {
  const { raycaster, mouse, camera } = ctx;

  const onMouseMove = (e: MouseEvent) => {
    const rect = container.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  };

  const onClickHandler = (e: MouseEvent) => {
    if (e.button !== 0) return; // left click only
    raycaster.setFromCamera(mouse, camera);

    // Check agents first (they're larger)
    const agentMeshes = ctx.scene.children.filter(c => c.userData.agentId != null);
    const agentHits = raycaster.intersectObjects(agentMeshes, true);
    if (agentHits.length > 0) {
      let obj: THREE.Object3D | null = agentHits[0].object;
      while (obj && !obj.userData.agentId) obj = obj.parent;
      if (obj?.userData.agentId) {
        onClick('agent', obj.userData.agentId);
        return;
      }
    }

    // Check IPs (instanced mesh — use instanceId)
    const ipMeshes = ctx.scene.children.filter(c => c.userData.isIpPool);
    const ipHits = raycaster.intersectObjects(ipMeshes, false);
    if (ipHits.length > 0 && ipHits[0].instanceId != null) {
      onClick('ip', ipHits[0].instanceId);
    }
  };

  const onDblClick = (_e: MouseEvent) => {
    raycaster.setFromCamera(mouse, camera);
    const allMeshes = ctx.scene.children.filter(c => c.userData.agentId != null);
    const hits = raycaster.intersectObjects(allMeshes, true);
    if (hits.length > 0) {
      onDoubleClick(hits[0].point);
    }
  };

  container.addEventListener('mousemove', onMouseMove);
  container.addEventListener('click', onClickHandler);
  container.addEventListener('dblclick', onDblClick);

  return () => {
    container.removeEventListener('mousemove', onMouseMove);
    container.removeEventListener('click', onClickHandler);
    container.removeEventListener('dblclick', onDblClick);
  };
}

/**
 * Smooth camera fly-to animation.
 */
export function flyTo(
  controls: THREE.EventDispatcher & { target: THREE.Vector3 },
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  duration = 1.5,
): void {
  const start = camera.position.clone();
  const startTarget = (controls as any).target.clone();
  const dir = target.clone().sub(camera.position).normalize();
  const endPos = target.clone().sub(dir.multiplyScalar(30)); // 30 units away
  const startTime = performance.now();

  function animate() {
    const elapsed = (performance.now() - startTime) / 1000;
    const t = Math.min(elapsed / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad

    camera.position.lerpVectors(start, endPos, ease);
    (controls as any).target.lerpVectors(startTarget, target, ease);
    (controls as any).update();

    if (t < 1) requestAnimationFrame(animate);
  }
  animate();
}
