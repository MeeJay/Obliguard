/**
 * prettifySensorLabel
 *
 * Turns a raw sensor key (as emitted by the Go agent) into a human-readable
 * display name. Used as the automatic fallback when no custom sensorDisplayName
 * has been set by the user.
 *
 * Supported formats (all produced by the agent):
 *   lhm_<hw_snake>_<sensor_snake>   — LibreHardwareMonitor (Windows)
 *   drive_<model_snake>             — NVMe / SATA temps   (Windows)
 *   asus_<sensor_snake>             — ASUS ATK WMI        (Windows)
 *   gpu_<model_snake>[_N]           — GPU temps           (all platforms)
 *   "chip-bus-addr[ sensor name]"   — gopsutil / lm-sensors (Linux / macOS)
 */
export function prettifySensorLabel(raw: string): string {
  if (raw.startsWith('lhm_'))   return toTitleCase(raw.slice(4));
  if (raw.startsWith('drive_')) return toTitleCase(raw.slice(6));
  if (raw.startsWith('gpu_'))   return toTitleCase(raw.slice(4));
  if (raw.startsWith('asus_'))  return 'ASUS ' + toTitleCase(raw.slice(5));

  // gopsutil SensorKey: "chipname-bustype-busaddr[ sensor label]"
  // e.g. "coretemp-isa-0000 Core 0", "acpitz-acpi-0", "k10temp-pci-00c3 Tctl/Tdie"
  const spaceIdx = raw.indexOf(' ');
  const chipPart   = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
  const sensorPart = spaceIdx === -1 ? null : raw.slice(spaceIdx + 1);
  const ctx = gopsutilChipContext(chipPart);

  if (sensorPart) return ctx ? `${ctx} – ${sensorPart}` : sensorPart;
  return ctx ?? toTitleCase(raw.replace(/-/g, '_'));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Words that should be fully uppercased regardless of position.
 * Covers common abbreviations found in hardware model strings.
 */
const ACRONYMS = new Set([
  'cpu', 'gpu', 'vrm', 'soc', 'nvme', 'ssd', 'hdd', 'pcie',
  'rtx', 'gtx', 'rx', 'vddcr', 'ccd',
  'nvidia', 'amd', 'asus', 'rog', 'msi', 'mib',
]);

/**
 * Convert a snake_case string (with optional `#N` suffixes) to Title Case,
 * applying ACRONYMS uppercasing and leaving numeric tokens intact.
 *
 * Examples:
 *   "intel_core_i7_12700k_package"  → "Intel Core I7 12700K Package"
 *   "intel_core_i7_12700k_core_#0"  → "Intel Core I7 12700K Core #0"
 *   "samsung_ssd_980_pro"           → "Samsung SSD 980 Pro"
 *   "nvidia_geforce_rtx_3080"       → "NVIDIA Geforce RTX 3080"
 *   "cpu_vrm"                       → "CPU VRM"
 */
function toTitleCase(snake: string): string {
  return snake
    .split('_')
    .filter(Boolean)
    .map(word => {
      if (word.startsWith('#')) return word;               // #0, #1 → keep
      if (/^\d/.test(word)) return word;                  // 980, 3080, 12700k → keep
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Maps a gopsutil chip identifier (e.g. "coretemp-isa-0000") to a short
 * human-readable context string shown as a prefix ("CPU", "System", …).
 * Returns null when no mapping is known.
 */
const CHIP_PREFIXES: Array<[prefix: string, label: string]> = [
  ['coretemp', 'CPU'],
  ['k10temp',  'CPU'],
  ['zenpower', 'CPU'],
  ['acpitz',   'System'],
  ['nvme',     'NVMe'],
  ['it87',     'Board'],
  ['nct',      'Board'],     // nct6775, nct6776, nct6779, …
  ['w83',      'Board'],     // w83627ehf, …
  ['radeon',   'GPU'],
  ['amdgpu',   'GPU'],
  ['nouveau',  'GPU'],
];

function gopsutilChipContext(chip: string): string | null {
  const name = chip.split('-')[0].toLowerCase();
  for (const [prefix, label] of CHIP_PREFIXES) {
    if (name === prefix || name.startsWith(prefix)) return label;
  }
  return null;
}
