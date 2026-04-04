// ── 3D NetMap Constants ──────────────────────────────────────────────────────

/** Device type colors — same as 2D but more vivid for 3D */
export const DEVICE_COLORS: Record<string, number> = {
  firewall: 0xF5A623,
  router:   0x00cfff,
  server:   0x7F77DD,
  windows:  0x4a9eff,
  desktop:  0x5DCAA5,
  default:  0x90c8f0,
};

/** IP status colors — brighter for emissive glow */
export const STATUS_COLORS = {
  banned:      0xff3333,
  suspicious:  0xffaa00,
  whitelisted: 0x33ffaa,
  clean:       0x6699cc,
} as const;

/** Peer link colors */
export const PEER_COLORS = {
  lan: 0x3b82f6,
  wan: 0xf97316,
} as const;

/** Spatial scale — how 2D pixel coords map to 3D units */
export const SCALE = 0.35;

/** Agent sphere base radius */
export const AGENT_RADIUS = 3.0;

/** IP sphere radius range */
export const IP_RADIUS_MIN = 0.25;
export const IP_RADIUS_MAX = 0.9;

/** Orbit ring spacing in 3D units */
export const ORBIT_RING_GAP_3D = 2.5;

/** Camera defaults */
export const CAM_INITIAL_DIST = 180;
export const CAM_MIN_DIST = 20;
export const CAM_MAX_DIST = 3000;

/** Star field */
export const STAR_COUNT = 15000;
export const STAR_SPHERE_RADIUS = 5000;

/** Bloom settings — high emissive objects get natural glow via bloom */
export const BLOOM_STRENGTH = 1.5;
export const BLOOM_RADIUS = 0.6;
export const BLOOM_THRESHOLD = 0.2;
