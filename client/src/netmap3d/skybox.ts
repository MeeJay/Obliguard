import * as THREE from 'three';
import { STAR_COUNT, STAR_SPHERE_RADIUS } from './constants3d';

/**
 * Creates a star field — 15K points on a large sphere with per-star
 * twinkling via a custom ShaderMaterial.
 * Includes bright foreground stars and dim distant ones for depth.
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
    const r     = STAR_SPHERE_RADIUS * (0.85 + Math.random() * 0.3);

    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    // Size distribution: mostly small, a few bright ones
    const sizeRoll = Math.random();
    if (sizeRoll < 0.02) {
      sizes[i] = 3.0 + Math.random() * 3.0; // bright stars
    } else if (sizeRoll < 0.15) {
      sizes[i] = 1.5 + Math.random() * 2.0; // medium
    } else {
      sizes[i] = 0.4 + Math.random() * 1.2; // dim background
    }

    phases[i] = Math.random() * 100;

    // Color distribution — realistic star colors
    const tint = Math.random();
    if (tint < 0.05) {
      // Hot blue-white (O/B type)
      colors[i * 3] = 0.7; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 1.0;
    } else if (tint < 0.10) {
      // Warm yellow (G type — sun-like)
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.7;
    } else if (tint < 0.13) {
      // Cool orange (K type)
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.75; colors[i * 3 + 2] = 0.5;
    } else if (tint < 0.15) {
      // Red (M type)
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.55; colors[i * 3 + 2] = 0.4;
    } else {
      // White-blue (A/F type — most common visible)
      const b = 0.85 + Math.random() * 0.15;
      colors[i * 3] = b; colors[i * 3 + 1] = b + 0.02; colors[i * 3 + 2] = b + 0.06;
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
      varying float vBright;
      varying vec3 vColor;
      uniform float uTime;
      uniform float uPixelRatio;

      void main() {
        vColor = color;
        // Twinkle: slow sine wave per star, faster for brighter stars
        float speed = 0.2 + aPhase * 0.015;
        float twinkle = 0.5 + 0.5 * sin(uTime * speed + aPhase);
        // Bright stars twinkle more subtly
        vAlpha = aSize > 2.5 ? 0.7 + 0.3 * twinkle : 0.3 + 0.7 * twinkle;
        vBright = aSize > 2.5 ? 1.2 : 1.0;

        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (250.0 / -mvPos.z);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vBright;
      varying vec3 vColor;

      void main() {
        // Soft circular point with bright core
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float core = exp(-d * d * 3.0); // bright gaussian core
        float halo = (1.0 - d * d) * 0.3; // soft outer halo
        float alpha = vAlpha * (core + halo);
        gl_FragColor = vec4(vColor * vBright, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

/** Call each frame to update twinkling */
export function updateStarField(stars: THREE.Points, time: number): void {
  (stars.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
  // Very slow rotation
  stars.rotation.y = time * 0.00005;
  stars.rotation.x = time * 0.00002;
}
