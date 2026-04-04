import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CAM_INITIAL_DIST, CAM_MIN_DIST, CAM_MAX_DIST, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD } from './constants3d';

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  composer: EffectComposer;
  controls: OrbitControls;
  clock: THREE.Clock;
  raycaster: THREE.Raycaster;
  mouse: THREE.Vector2;
}

export function createScene(container: HTMLElement): SceneContext {
  const w = container.clientWidth;
  const h = container.clientHeight;

  // Scene — deep space black
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000206);
  scene.fog = new THREE.FogExp2(0x000206, 0.00015);

  // Camera — wider FOV for immersion
  const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 12000);
  camera.position.set(0, CAM_INITIAL_DIST * 0.7, CAM_INITIAL_DIST);

  // Renderer — high quality
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // CSS2D label renderer
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(w, h);
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top = '0';
  labelRenderer.domElement.style.left = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);

  // Post-processing — bloom for glow
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(w, h),
    BLOOM_STRENGTH,
    BLOOM_RADIUS,
    BLOOM_THRESHOLD,
  );
  composer.addPass(bloomPass);

  // Orbit controls — smooth, cinematic
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = CAM_MIN_DIST;
  controls.maxDistance = CAM_MAX_DIST;
  controls.enablePan = true;
  controls.panSpeed = 0.6;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 0.8;

  // ── Lighting ──────────────────────────────────────────────────────────────

  // Soft ambient fill — cold blue tint
  scene.add(new THREE.AmbientLight(0x0a1530, 1.2));

  // Main "sun" — warm white at origin
  const sun = new THREE.PointLight(0xffeedd, 2.0, 800);
  sun.position.set(0, 30, 0);
  scene.add(sun);

  // Secondary fill light — cool blue from below for rim lighting
  const fillBelow = new THREE.PointLight(0x2244aa, 0.6, 600);
  fillBelow.position.set(0, -50, 0);
  scene.add(fillBelow);

  // Distant directional for key shadows
  const dirLight = new THREE.DirectionalLight(0xaaccff, 0.4);
  dirLight.position.set(100, 80, 60);
  scene.add(dirLight);

  return {
    scene,
    camera,
    renderer,
    labelRenderer,
    composer,
    controls,
    clock: new THREE.Clock(),
    raycaster: new THREE.Raycaster(),
    mouse: new THREE.Vector2(-999, -999),
  };
}

export function resizeScene(ctx: SceneContext, w: number, h: number): void {
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
  ctx.renderer.setSize(w, h);
  ctx.labelRenderer.setSize(w, h);
  ctx.composer.setSize(w, h);
}

export function disposeScene(ctx: SceneContext): void {
  ctx.composer.dispose();
  ctx.renderer.dispose();
  ctx.controls.dispose();
  ctx.renderer.domElement.remove();
  ctx.labelRenderer.domElement.remove();
}
