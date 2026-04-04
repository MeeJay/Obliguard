// ── 3D NetMap Constants ──────────────────────────────────────────────────────

/** Device type colors — same as 2D */
export const DEVICE_COLORS: Record<string, number> = {
  firewall: 0xF5A623,
  router:   0x00cfff,
  server:   0x7F77DD,
  windows:  0x3b82f6,
  desktop:  0x5DCAA5,
  default:  0x90c8f0,
};

/** IP status colors */
export const STATUS_COLORS = {
  banned:      0xE24B4A,
  suspicious:  0xF9A825,
  whitelisted: 0x5DCAA5,
  clean:       0x82A0C3,
} as const;

/** Peer link colors */
export const PEER_COLORS = {
  lan: 0x3b82f6,
  wan: 0xf97316,
} as const;

/** Spatial scale — how 2D pixel coords map to 3D units */
export const SCALE = 0.15;

/** Agent sphere base radius */
export const AGENT_RADIUS = 2.0;

/** IP sphere radius range */
export const IP_RADIUS_MIN = 0.15;
export const IP_RADIUS_MAX = 0.6;

/** Orbit ring spacing in 3D units */
export const ORBIT_RING_GAP_3D = 1.5;

/** Camera defaults */
export const CAM_INITIAL_DIST = 120;
export const CAM_MIN_DIST = 15;
export const CAM_MAX_DIST = 2000;

/** Star field */
export const STAR_COUNT = 12000;
export const STAR_SPHERE_RADIUS = 4000;

/** Bloom settings */
export const BLOOM_STRENGTH = 0.6;
export const BLOOM_RADIUS = 0.4;
export const BLOOM_THRESHOLD = 0.5;
