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

export const EVENT_COLORS = {
  auth_success: '#22d3ee',
  auth_failure: '#f97316',
  ban:          '#ef4444',
} as const;

export const SVC_COLORS: Record<string, string> = {
  ssh: '#f97316', rdp: '#a855f7', ftp: '#eab308',
  mail: '#06b6d4', mysql: '#ec4899', nginx: '#22c55e',
  apache: '#22c55e', iis: '#3b82f6',
};

export const DANGEROUS_SVCS = new Set(['ssh', 'rdp', 'ftp', 'mysql', 'telnet', 'smb', 'vnc']);

/** Colors used for peer link edges: LAN = subdued blue, WAN = amber/orange */
export const PEER_LINK_COLOR: Record<'lan' | 'wan', string> = { lan: '#3b82f6', wan: '#f97316' };

/** Device type colors — matching mockup v5 */
export const DEVICE_TYPE_COLORS: Record<string, string> = {
  firewall: '#F5A623',   // MikroTik, OPNsense, pfSense
  router:   '#00cfff',   // network equipment
  server:   '#7F77DD',   // Linux servers
  windows:  '#3b82f6',   // Windows machines
  desktop:  '#5DCAA5',   // workstations
  default:  '#90c8f0',   // unknown
};

/** Badge rendering constants */
export const BADGE_H    = 15;
export const BADGE_FONT = '8.5px "Inter", "Segoe UI", ui-sans-serif, sans-serif';

/** Hit detection padding — extra px around IP dots for easier hover/click */
export const IP_HIT_PADDING = 10;
