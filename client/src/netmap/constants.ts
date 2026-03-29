// ── NetMap Constants ──────────────────────────────────────────────────────────

export const IP_TTL        = 90 * 1000;   // 90 s — IPs fade then disappear if no fresh event
export const IP_FADE_AGE   = 45 * 1000;   // fade starts at 45 s
export const PEER_LINK_TTL = 120 * 1000;  // 120 s — peer links linger after last event

/** Ring layout constants — shared by layout functions and animate(). */
export const RING_INNER_R = 42;              // first ring distance from agent centre (px)
export const RING_GAP     = 7;               // gap between successive rings (px)
export const PER_RING     = 30;              // max IPs per ring
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

/** Badge rendering constants */
export const BADGE_H    = 13;
export const BADGE_FONT = '7.5px "Inter", "Segoe UI", ui-sans-serif, sans-serif';
