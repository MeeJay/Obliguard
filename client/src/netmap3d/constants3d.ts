// ── 3D NetMap Constants ──────────────────────────────────────────────────────

import { NETMAP_PALETTE, rgba } from '../netmap/constants';

/** `#rrggbb` palette entry → Three.js colour number. */
const hexNum = (hex: string): number => parseInt(hex.replace('#', ''), 16);

/**
 * 3D palette. Every colour of the Three.js scene lives here (the 2D palette
 * of netmap/constants.ts is the source where both views share a colour); the
 * 3D variants are brighter because bloom and tone mapping dim them.
 */
export const PALETTE_3D = {
  /** Scene background, fog and the container behind the canvas. */
  space:       hexNum(NETMAP_PALETTE.chrome.space3d),
  spaceCss:    NETMAP_PALETTE.chrome.space3d,
  /** Non-emissive base of the agent and IP spheres (bloom does the glow). */
  black:       0x000000,
  /** Emissive base of the instanced IP spheres (tinted per instance). */
  white:       0xffffff,
  orbitRing:   0x3388cc,
  /** Agent tint toward which heavily targeted agents drift. */
  threat:      0xff3333,
  /** Evaluate-only marker (labels). */
  evaluateCss: rgba(NETMAP_PALETTE.amber, 0.85),
  lights: {
    ambient:   0x0a1530,
    sun:       0xffeedd,
    fillBelow: 0x2244aa,
    key:       0xaaccff,
  },
  label: {
    name:    rgba(NETMAP_PALETTE.label, 0.75),
    shadow:  rgba(NETMAP_PALETTE.shadow, 1),
    online:  rgba(NETMAP_PALETTE.mint, 0.5),
    offline: rgba(NETMAP_PALETTE.threat, 0.5),
  },
  tooltip: {
    bg:     NETMAP_PALETTE.chrome.tooltip,
    border: NETMAP_PALETTE.chrome.tooltipBorder,
    shadow: NETMAP_PALETTE.chrome.tooltipShadow,
  },
} as const;

/** Device type colors — same as 2D but more vivid for 3D */
export const DEVICE_COLORS: Record<string, number> = {
  firewall: hexNum(NETMAP_PALETTE.device.firewall),
  router:   hexNum(NETMAP_PALETTE.device.router),
  server:   hexNum(NETMAP_PALETTE.device.server),
  windows:  0x4a9eff,
  desktop:  hexNum(NETMAP_PALETTE.device.desktop),
  default:  hexNum(NETMAP_PALETTE.device.default),
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
  lan: hexNum(NETMAP_PALETTE.peer.lan),
  wan: hexNum(NETMAP_PALETTE.peer.wan),
} as const;

/** Spatial scale — how 2D pixel coords map to 3D units */
export const SCALE = 0.35;

/** Agent sphere base radius */
export const AGENT_RADIUS = 3.0;

/** IP sphere radius range */
export const IP_RADIUS_MIN = 0.25;
export const IP_RADIUS_MAX = 0.9;

/** IP instance pool: initial capacity, doubled on demand up to the hard cap. */
export const IP_POOL_INITIAL = 1024;
export const IP_POOL_MAX = 32768;

/** Orbit ring spacing in 3D units */
export const ORBIT_RING_GAP_3D = 2.5;

/** Threat IPs (banned + suspicious) at which an agent reaches its full threat tint. */
export const THREAT_TINT_FULL = 60;
/** Strongest share of the threat colour in an agent's emissive colour. */
export const THREAT_TINT_MAX = 0.6;

/** Hover raycast throttle (ms). */
export const HOVER_THROTTLE_MS = 80;

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
