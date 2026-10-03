// ── NetMap Constants ──────────────────────────────────────────────────────────

/** IP TTL by status — clean vanish fast, threats linger. */
export const IP_TTL_CLEAN      = 60 * 1000;   // 60 s — clean IPs stay visible a minute
export const IP_TTL_SUSPICIOUS = 5 * 60 * 1000; // 5 min — suspicious stay visible
export const IP_TTL_BANNED     = 10 * 60 * 1000; // 10 min — banned stay longest
export const IP_TTL            = 90 * 1000;   // fallback for unknown status
export const IP_FADE_AGE       = 0.6;         // fraction of TTL where fade starts (60%)
export const PEER_LINK_TTL = 120 * 1000;  // 120 s — peer links linger after last event

/** Ring layout constants — shared by layout functions and animate(). */
export const RING_INNER_R = 52;              // first ring distance from agent centre (px)
export const RING_GAP     = 14;             // gap between successive rings (px)
export const PER_RING     = 18;              // max IPs per ring — fewer = more spaced
export const ARC_START    = -Math.PI / 6;   // 330° — first arc position (bottom-right)
export const ARC_SPAN     = (4 * Math.PI) / 3; // 240° arc, skipping top 120° (label zone)

// ── Palette ───────────────────────────────────────────────────────────────────

/** RGB triplet of a palette colour, drawn with a variable alpha via rgba(). */
export type Rgb = readonly [number, number, number];

/** `rgba(r,g,b,a)` string of a palette triplet (canvas styles, inline styles). */
export function rgba(c: Rgb, a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** `#rrggbb` of a palette triplet. */
export function rgbHex(c: Rgb): string {
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * NetMap palette. The map keeps a fixed dark "space" look whatever the app
 * theme (owner decision), so its colours are not theme tokens: every colour of
 * the 2D canvas, the page chrome (through NETMAP_CSS_VARS) and the 3D scene
 * (constants3d.ts) comes from here — no hex literal elsewhere in the NetMap.
 */
export const NETMAP_PALETTE = {
  // ── Page chrome ────────────────────────────────────────────────────────
  chrome: {
    /** Canvas + page background (deep space). */
    space:        '#06090f',
    /** Header, live feed, floating panels. */
    panel:        '#070502',
    /** Floating legend panel over the canvas (translucent panel + border). */
    panelGlass:       'rgba(7,5,2,0.95)',
    panelGlassBorder: 'rgba(26,18,8,0.6)',
    /** Tab bar, inputs. */
    panelDeep:    '#050302',
    /** Modal body. */
    panelRaised:  '#0a0806',
    border:       '#110c04',
    borderSoft:   '#150e05',
    borderRaised: '#1a1408',
    /** Agent / IP side panels. */
    sidePanel:       'rgba(5,12,22,0.95)',
    sidePanelBorder: 'rgba(90,138,181,0.2)',
    tooltip:         'rgba(7,5,2,0.97)',
    tooltipBorder:   'rgba(60,45,20,0.7)',
    tooltipShadow:   'rgba(0,0,0,0.8)',
    loadingVeil:     'rgba(3,3,16,0.9)',
    /** 3D view background (also the Three.js clear colour). */
    space3d:      '#000206',
    /** Legend swatch of a disabled flow type. */
    swatchOff:    '#1e293b',
    textOn:       '#94a3b8',
    textOff:      '#334155',
  },

  // ── Header counters ────────────────────────────────────────────────────
  stats: {
    agents:  '#22d3ee',
    banned:  '#f87171',
    today:   '#fb923c',
    tracked: '#c084fc',
  },

  // ── IP status (legend, node colour, tooltips) ──────────────────────────
  status: {
    banned:      '#ef4444',
    suspicious:  '#f97316',
    whitelisted: '#22c55e',
    clean:       '#475569',
  },
  /** Softer status triplets of the canvas dots, trails and labels. */
  dot: {
    banned:      [226, 75, 74],
    suspicious:  [249, 168, 37],
    whitelisted: [93, 202, 165],
    clean:       [130, 160, 195],
  } satisfies Record<string, Rgb>,
  /** Comet-tail triplets (suspicious leans orange, like its status colour). */
  trail: {
    banned:      [226, 75, 74],
    suspicious:  [249, 115, 22],
    whitelisted: [93, 202, 165],
    clean:       [130, 160, 195],
  } satisfies Record<string, Rgb>,
  /** IP → agent link line and multi-agent orbit path of a non-threat IP. */
  linkClean:  '#3a6a8a',
  orbitClean: '#5a9abb',

  // ── Flow types ─────────────────────────────────────────────────────────
  event: {
    auth_success: '#22d3ee',
    auth_failure: '#f97316',
    ban:          '#ef4444',
    /** Any event on a dangerous service (SSH, RDP, MySQL…). */
    dangerous:    '#ef4444',
  },
  /** Fallback colour of an unknown service. */
  serviceUnknown: '#f43f5e',
  services: {
    ssh: '#f97316', rdp: '#a855f7', ftp: '#eab308',
    mail: '#06b6d4', mysql: '#ec4899', nginx: '#22c55e',
    apache: '#22c55e', iis: '#3b82f6',
  } as Record<string, string>,

  // ── Agents ─────────────────────────────────────────────────────────────
  /** Device type colours — matching mockup v5. */
  device: {
    firewall: '#F5A623',   // MikroTik, OPNsense, pfSense
    router:   '#00cfff',   // network equipment
    server:   '#7F77DD',   // Linux servers
    windows:  '#3b82f6',   // Windows machines
    desktop:  '#5DCAA5',   // workstations
    default:  '#90c8f0',   // unknown
  } as Record<string, string>,
  /** Threat red: offline agents, heavy attack heat, high IP counts. */
  threat:   [226, 75, 74] satisfies Rgb,
  /** Amber: firewall shields, warm heat, evaluate-only marker. */
  amber:    [245, 166, 35] satisfies Rgb,
  /** Mint: online state, low IP counts. */
  mint:     [93, 202, 165] satisfies Rgb,
  /** Agent label text. */
  label:    [200, 220, 240] satisfies Rgb,
  /** Group name under an agent. */
  groupLabel: [100, 140, 190] satisfies Rgb,
  /** Orbit rings of an online / offline agent. */
  orbitOnline:  '#4a8abb',
  orbitOffline: '#2a3a4a',
  /** Dashed edge between two agents sharing an IP. */
  sharedEdge:   '#5588a0',
  /** Recent-IP dot of a clean IP in the agent panel. */
  recentClean:  '#82a0c3',

  // ── Peer links ─────────────────────────────────────────────────────────
  /** LAN = subdued blue, WAN = amber/orange. */
  peer: { lan: '#3b82f6', wan: '#f97316' } as Record<'lan' | 'wan', string>,
  peerCount: 'rgba(200,200,200,0.5)',

  // ── Background ─────────────────────────────────────────────────────────
  nebulaCold:  [20, 40, 70] satisfies Rgb,
  nebulaDeep:  [15, 25, 50] satisfies Rgb,
  nebulaWarm:  [60, 30, 20] satisfies Rgb,
  star:        [180, 200, 230] satisfies Rgb,

  // ── Misc ───────────────────────────────────────────────────────────────
  white:  [255, 255, 255] satisfies Rgb,
  shadow: [0, 0, 0] satisfies Rgb,
  minimap: {
    bg:      'rgba(3,2,2,0.75)',
    border:  'rgba(80,60,30,0.3)',
    online:  '#22d3ee',
    offline: '#64748b',
  },
  /** IP label badge (drawBadgeAt). */
  badge: {
    bg:   'rgba(5,3,1,0.88)',
    text: '#dbe4ef',
  },
} as const;

/**
 * CSS custom properties of the page chrome, set on the NetMap root so the
 * Tailwind classes read `bg-[color:var(--nm-space)]` instead of a hex literal.
 */
export const NETMAP_CSS_VARS: Record<string, string> = {
  '--nm-space':          NETMAP_PALETTE.chrome.space,
  '--nm-panel':          NETMAP_PALETTE.chrome.panel,
  '--nm-panel-glass':    NETMAP_PALETTE.chrome.panelGlass,
  '--nm-panel-glass-border': NETMAP_PALETTE.chrome.panelGlassBorder,
  '--nm-panel-deep':     NETMAP_PALETTE.chrome.panelDeep,
  '--nm-panel-raised':   NETMAP_PALETTE.chrome.panelRaised,
  '--nm-border':         NETMAP_PALETTE.chrome.border,
  '--nm-border-soft':    NETMAP_PALETTE.chrome.borderSoft,
  '--nm-border-raised':  NETMAP_PALETTE.chrome.borderRaised,
  '--nm-side':           NETMAP_PALETTE.chrome.sidePanel,
  '--nm-side-border':    NETMAP_PALETTE.chrome.sidePanelBorder,
  '--nm-veil':           NETMAP_PALETTE.chrome.loadingVeil,
  '--nm-space-3d':       NETMAP_PALETTE.chrome.space3d,
};

export const EVENT_COLORS = {
  auth_success: NETMAP_PALETTE.event.auth_success,
  auth_failure: NETMAP_PALETTE.event.auth_failure,
  ban:          NETMAP_PALETTE.event.ban,
} as const;

export const SVC_COLORS: Record<string, string> = NETMAP_PALETTE.services;

export const DANGEROUS_SVCS = new Set(['ssh', 'rdp', 'ftp', 'mysql', 'telnet', 'smb', 'vnc']);

/** Colors used for peer link edges: LAN = subdued blue, WAN = amber/orange */
export const PEER_LINK_COLOR: Record<'lan' | 'wan', string> = NETMAP_PALETTE.peer;

/** Device type colors — matching mockup v5 */
export const DEVICE_TYPE_COLORS: Record<string, string> = NETMAP_PALETTE.device;

/** Badge rendering constants */
export const BADGE_H    = 15;
export const BADGE_FONT = '8.5px "Inter", "Segoe UI", ui-sans-serif, sans-serif';

/** Hit detection padding — extra px around IP dots for easier hover/click */
export const IP_HIT_PADDING = 10;

/** Spacing between 2D orbit rings (px). */
export const ORBIT_RING_GAP = 10;
/** IPs per orbit ring (2D and 3D). */
export const IPS_PER_ORBIT_RING = 20;
