import * as THREE from 'three';
import { STAR_COUNT, STAR_SPHERE_RADIUS } from './constants3d';

/**
 * Creates a star field — 12K points on a large sphere with per-star
 * twinkling via a custom ShaderMaterial.
 */
export function createStarField(): THREE.Points {
  const positions = new Float32Array(STAR_COUNT * 3);
  const sizes     = new Float32Array(STAR_COUNT);
  const phases    = new Float32Array(STAR_COUNT);
  const colors    = new Float32Array(STAR_COUNT * 3);

  for (let i = 0; i < STAR_COUNT; i++) {
    // Random point on sphere surface
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = STAR_SPHERE_RADIUS * (0.9 + Math.random() * 0.2);

    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    sizes[i]   = 0.8 + Math.random() * 2.5;
    phases[i]  = Math.random() * 100; // random twinkle phase

    // Mostly white with occasional warm/cool tints
    const tint = Math.random();
    if (tint < 0.08) {
      // Warm yellow-orange
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 0.6;
    } else if (tint < 0.15) {
      // Cool blue
      colors[i * 3] = 0.7; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 1.0;
    } else {
      // White-blue
      colors[i * 3] = 0.9; colors[i * 3 + 1] = 0.92; colors[i * 3 + 2] = 1.0;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aPhase',   new THREE.BufferAttribute(phases, 1));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      varying float vAlpha;
      varying vec3 vColor;
      uniform float uTime;
      uniform float uPixelRatio;

      void main() {
        vColor = color;
        // Twinkle: slow sine wave per star
        float twinkle = 0.55 + 0.45 * sin(uTime * (0.3 + aPhase * 0.02) + aPhase);
        vAlpha = twinkle;

        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (200.0 / -mvPos.z);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec3 vColor;

      void main() {
        // Soft circular point
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float alpha = vAlpha * (1.0 - d * d);
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // always render (wraps around camera)
  return points;
}

/** Call each frame to update twinkling */
export function updateStarField(stars: THREE.Points, time: number): void {
  (stars.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
  // Very slow rotation for subtle motion
  stars.rotation.y = time * 0.00008;
  stars.rotation.x = time * 0.00003;
}
