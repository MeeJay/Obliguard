import { db } from '../db';
import type {
  AgentUpdatePolicy, NotificationTypeField, ResolvedSettingValue, ResolvedSettingsMap, ScopeSettingsView,
  SettingLevel, SettingRawValue, SettingsKey, SettingDefinition, WindowsFirewallBackend,
} from '@obliview/shared';
import {
  SETTINGS_DEFINITIONS, NOTIFICATION_TYPE_FIELDS, DEFAULT_NOTIFICATION_TYPES, MASTER_TENANT_ID,
} from '@obliview/shared';
import { logger } from '../utils/logger';
import { isAgentUpdatePolicy, resolveAgentUpdatePolicy } from '../utils/agentUpdate';
import { settingsService } from './settings.service';

/**
 * IPS agent configuration resolver (W13-1): ONE cascade for every agent knob,
 *
 *   default -> GLOBAL -> TENANT -> GROUP chain (root -> leaf, closure, nearest
 *   wins) -> AGENT
 *
 * with the source of each value (Obliance settings.service resolveForDevice).
 * agent.service (device payloads, config frame) and obliguardHub (offline
 * grace) read through it. Rules per key: shared/src/settingsDefaults.ts.
 *
 * A snapshot (settings rows, group closure, group / tenant names, group
 * evaluate_only flags) is cached 15 s and dropped by every settings write,
 * group create / move / delete and tenant rename: the agent channel resolves
 * every heartbeat without a query. Only groups of the device's own tenant
 * count (legacy cross-tenant nesting is ignored, as in the C17 resolver).
 *
 * updatePolicy is resolved by the C17 resolver (utils/agentUpdate) for
 * display only: never stored nor re-resolved here (owner directive).
 */

export interface DeviceConfigRef {
  id: number;
  tenantId: number;
  groupId: number | null;
  /** The agent's own evaluate_only column. */
  evaluateOnly?: boolean | null;
}

export interface ResolvedAgentSettings {
  checkIntervalSeconds: number;
  maxMissedPushes: number;
  evaluateOnly: boolean;
  autoBanEnabled: boolean;
  windowsFirewallBackend: WindowsFirewallBackend;
  notificationTypes: Record<NotificationTypeField, boolean>;
  /** Value + source of every cascade key (updatePolicy excluded). */
  sources: ResolvedSettingsMap;
}

interface GroupInfo { name: string; tenantId: number; evaluateOnly: boolean }

interface Snapshot {
  at: number;
  /** `${level}:${scopeId}` ('global:') -> key -> stored value. */
  rows: Map<string, Map<string, unknown>>;
  groups: Map<number, GroupInfo>;
  /** group id -> its ancestors, nearest first (itself at index 0). */
  ancestry: Map<number, number[]>;
  tenants: Map<number, string>;
}

/** One level of a chain, farthest first when resolving. */
interface ChainLevel {
  level: SettingLevel;
  scopeId: number | null;
  name: string;
  /** Column-backed evaluate_only of a group / agent level. */
  evaluateOnly?: boolean;
}

const SNAPSHOT_TTL_MS = 15_000;
/** Keys resolved here (updatePolicy has its own resolver). */
const CASCADE_DEFS: readonly SettingDefinition[] = SETTINGS_DEFINITIONS.filter((d) => d.resolution !== 'external');
const STORED_KEYS = CASCADE_DEFS.filter((d) => d.resolution !== 'anyTrue').map((d) => d.key);
const DEFAULT_GRACE_MS = 60 * 2 * 1000;

let _snapshot: Snapshot | null = null;
let _loading: Promise<Snapshot> | null = null;
let _generation = 0;

const rowKey = (level: SettingLevel, scopeId: number | null) => `${level}:${scopeId ?? ''}`;

async function loadSnapshot(): Promise<Snapshot> {
  const [rows, groups, closure, tenants] = await Promise.all([
    db('settings').whereIn('key', STORED_KEYS).select('scope', 'scope_id', 'key', 'value') as Promise<Array<{ scope: string; scope_id: number | null; key: string; value: unknown }>>,
    db('monitor_groups').select('id', 'name', 'tenant_id', 'evaluate_only') as Promise<Array<{ id: number; name: string; tenant_id: number; evaluate_only: boolean | null }>>,
    db('group_closure').select('ancestor_id', 'descendant_id', 'depth')
      .orderBy([{ column: 'descendant_id' }, { column: 'depth', order: 'asc' }]) as Promise<Array<{ ancestor_id: number; descendant_id: number; depth: number }>>,
    db('tenants').select('id', 'name') as Promise<Array<{ id: number; name: string }>>,
  ]);
  const snap: Snapshot = { at: Date.now(), rows: new Map(), groups: new Map(), ancestry: new Map(), tenants: new Map() };
  for (const r of rows) {
    const k = rowKey(r.scope as SettingLevel, r.scope_id == null ? null : Number(r.scope_id));
    let m = snap.rows.get(k);
    if (!m) { m = new Map(); snap.rows.set(k, m); }
    m.set(r.key, r.value);
  }
  for (const g of groups) snap.groups.set(Number(g.id), { name: g.name, tenantId: Number(g.tenant_id), evaluateOnly: !!g.evaluate_only });
  for (const c of closure) {
    const d = Number(c.descendant_id);
    let list = snap.ancestry.get(d);
    if (!list) { list = []; snap.ancestry.set(d, list); }
    list.push(Number(c.ancestor_id));
  }
  for (const t of tenants) snap.tenants.set(Number(t.id), t.name);
  return snap;
}

async function getSnapshot(): Promise<Snapshot> {
  if (_snapshot && Date.now() - _snapshot.at < SNAPSHOT_TTL_MS) return _snapshot;
  if (!_loading) {
    const gen = _generation;
    const p: Promise<Snapshot> = loadSnapshot()
      .then((s) => { if (gen === _generation) _snapshot = s; return s; })
      .finally(() => { if (_loading === p) _loading = null; });
    _loading = p;
  }
  return _loading;
}

/** A stored value usable for `def` (anything else is ignored, the level then inherits). */
function coerce(def: SettingDefinition, raw: unknown): SettingRawValue | undefined {
  switch (def.type) {
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw)
        && (def.min === undefined || raw >= def.min) && (def.max === undefined || raw <= def.max) ? raw : undefined;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'enum':
      return typeof raw === 'string' && (def.options ?? []).includes(raw) ? raw : undefined;
    case 'flags':
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as SettingRawValue : undefined;
  }
}

const DEFAULT_SOURCE = { source: 'default' as const, sourceId: null, sourceName: 'Default' };

/** Resolve every cascade key over `chain` (farthest first). */
function resolveChain(snap: Snapshot, chain: ChainLevel[]): ResolvedSettingsMap {
  const out: ResolvedSettingsMap = {};
  for (const def of CASCADE_DEFS) {
    if (def.resolution === 'anyTrue') {
      // Dry-run anywhere on the chain is absolute: the nearest flagged level is reported.
      let hit: ChainLevel | null = null;
      for (const lvl of chain) if (lvl.evaluateOnly) hit = lvl;
      out[def.key] = hit
        ? { value: true, source: hit.level, sourceId: hit.scopeId, sourceName: hit.name }
        : { value: def.defaultValue, ...DEFAULT_SOURCE };
      continue;
    }
    if (def.resolution === 'perField') {
      const defaults = def.defaultValue as Record<string, boolean>;
      const fields: NonNullable<ResolvedSettingValue['fields']> = {};
      for (const f of NOTIFICATION_TYPE_FIELDS) fields[f] = { value: defaults[f], ...DEFAULT_SOURCE };
      let nearest: ChainLevel | null = null;
      for (const lvl of chain) {
        const raw = coerce(def, snap.rows.get(rowKey(lvl.level, lvl.scopeId))?.get(def.key)) as Record<string, unknown> | undefined;
        if (!raw) continue;
        for (const f of NOTIFICATION_TYPE_FIELDS) {
          if (typeof raw[f] === 'boolean') {
            fields[f] = { value: raw[f] as boolean, source: lvl.level, sourceId: lvl.scopeId, sourceName: lvl.name };
            nearest = lvl;
          }
        }
      }
      const value = Object.fromEntries(NOTIFICATION_TYPE_FIELDS.map((f) => [f, fields[f]!.value]));
      out[def.key] = nearest
        ? { value, source: nearest.level, sourceId: nearest.scopeId, sourceName: nearest.name, fields }
        : { value, ...DEFAULT_SOURCE, fields };
      continue;
    }
    let res: ResolvedSettingValue = { value: def.defaultValue, ...DEFAULT_SOURCE };
    for (const lvl of chain) {
      const v = coerce(def, snap.rows.get(rowKey(lvl.level, lvl.scopeId))?.get(def.key));
      if (v !== undefined) res = { value: v, source: lvl.level, sourceId: lvl.scopeId, sourceName: lvl.name };
    }
    out[def.key] = res;
  }
  return out;
}

function tenantLevel(snap: Snapshot, tenantId: number): ChainLevel {
  return { level: 'tenant', scopeId: tenantId, name: snap.tenants.get(tenantId) ?? `Tenant ${tenantId}` };
}

/** Group levels of `groupId`'s chain in `tenantId`, root first; `withSelf` false drops the group itself. */
function groupLevels(snap: Snapshot, groupId: number | null, tenantId: number, withSelf = true): ChainLevel[] {
  if (groupId == null) return [];
  const ancestors = snap.ancestry.get(groupId) ?? [groupId];
  const out: ChainLevel[] = [];
  for (const id of [...ancestors].reverse()) {
    if (!withSelf && id === groupId) continue;
    const g = snap.groups.get(id);
    if (!g || g.tenantId !== Number(tenantId)) continue;
    out.push({ level: 'group', scopeId: id, name: g.name, evaluateOnly: g.evaluateOnly });
  }
  return out;
}

const GLOBAL_LEVEL: ChainLevel = { level: 'global', scopeId: null, name: 'Global' };

function deviceChain(snap: Snapshot, ref: DeviceConfigRef): ChainLevel[] {
  return [
    GLOBAL_LEVEL,
    tenantLevel(snap, Number(ref.tenantId)),
    ...groupLevels(snap, ref.groupId, Number(ref.tenantId)),
    { level: 'agent', scopeId: ref.id, name: 'This agent', evaluateOnly: !!ref.evaluateOnly },
  ];
}

function toSettings(sources: ResolvedSettingsMap): ResolvedAgentSettings {
  const v = <T>(k: SettingsKey) => sources[k]!.value as T;
  return {
    checkIntervalSeconds: v<number>('checkIntervalSeconds'),
    maxMissedPushes: v<number>('maxMissedPushes'),
    evaluateOnly: v<boolean>('evaluateOnly'),
    autoBanEnabled: v<boolean>('autoBanEnabled'),
    windowsFirewallBackend: v<WindowsFirewallBackend>('windowsFirewallBackend'),
    notificationTypes: v<Record<NotificationTypeField, boolean>>('notificationTypes'),
    sources,
  };
}

interface DeviceRow { id: number; tenant_id: number; group_id: number | null; evaluate_only: boolean | null; update_policy?: string | null }

async function loadDeviceRef(deviceId: number): Promise<DeviceRow | null> {
  const row = await db('agent_devices').where({ id: deviceId })
    .first('id', 'tenant_id', 'group_id', 'evaluate_only', 'update_policy') as DeviceRow | undefined;
  return row ?? null;
}

function refOf(row: DeviceRow): DeviceConfigRef {
  return { id: Number(row.id), tenantId: Number(row.tenant_id), groupId: row.group_id == null ? null : Number(row.group_id), evaluateOnly: !!row.evaluate_only };
}

/** The level's updatePolicy as the C17 resolver reports it (display only). */
async function updatePolicyView(
  snap: Snapshot, level: SettingLevel, scopeId: number | null, tenantId: number | null, device: DeviceRow | null,
): Promise<{ inherited: ResolvedSettingValue; effective: ResolvedSettingValue; own: AgentUpdatePolicy | null } | null> {
  try {
    const agentSvc = await import('./agent.service');
    const { appConfigService } = await import('./appConfig.service');
    const globalRaw = (await appConfigService.getAgentGlobal()).updatePolicy;
    const globalPolicy = isAgentUpdatePolicy(globalRaw) ? globalRaw : null;
    const tenantPolicies = tenantId != null ? await agentSvc.getTenantUpdatePolicies() : new Map<number, AgentUpdatePolicy>();
    const chains = await agentSvc.getGroupUpdatePolicyChains();
    if (tenantPolicies === null || chains === null) return null;
    const tenantPolicy = tenantId != null ? tenantPolicies.get(Number(tenantId)) ?? null : null;
    const groupId = level === 'group' ? scopeId : device?.group_id ?? null;
    const fullChain = groupId == null ? [] : (chains.get(Number(groupId)) ?? []).filter((e) => Number(e.tenantId) === Number(tenantId));
    const view = (r: ReturnType<typeof resolveAgentUpdatePolicy>): ResolvedSettingValue => {
      const sourceId = r.source === 'group' ? r.sourceGroupId : r.source === 'tenant' ? tenantId : r.source === 'agent' ? scopeId : null;
      const sourceName = r.source === 'group' ? (snap.groups.get(Number(r.sourceGroupId))?.name ?? `Group ${r.sourceGroupId}`)
        : r.source === 'tenant' ? (snap.tenants.get(Number(tenantId)) ?? `Tenant ${tenantId}`)
        : r.source === 'agent' ? 'This agent' : r.source === 'global' ? 'Global' : 'Default';
      return { value: r.policy, source: r.source, sourceId: sourceId ?? null, sourceName };
    };
    switch (level) {
      case 'global': {
        const eff = resolveAgentUpdatePolicy(null, [], null, globalPolicy);
        return { inherited: view(resolveAgentUpdatePolicy(null, [], null, null)), effective: view(eff), own: globalPolicy };
      }
      case 'tenant':
        return {
          inherited: view(resolveAgentUpdatePolicy(null, [], null, globalPolicy)),
          effective: view(resolveAgentUpdatePolicy(null, [], tenantPolicy, globalPolicy)),
          own: tenantPolicy,
        };
      case 'group': {
        const own = fullChain.find((e) => Number(e.groupId) === Number(scopeId))?.policy ?? null;
        const above = fullChain.filter((e) => Number(e.groupId) !== Number(scopeId));
        return {
          inherited: view(resolveAgentUpdatePolicy(null, above, tenantPolicy, globalPolicy)),
          effective: view(resolveAgentUpdatePolicy(null, fullChain, tenantPolicy, globalPolicy)),
          own,
        };
      }
      case 'agent': {
        const own = isAgentUpdatePolicy(device?.update_policy) ? device!.update_policy as AgentUpdatePolicy : null;
        return {
          inherited: view(resolveAgentUpdatePolicy(null, fullChain, tenantPolicy, globalPolicy)),
          effective: view(resolveAgentUpdatePolicy(own, fullChain, tenantPolicy, globalPolicy)),
          own,
        };
      }
    }
  } catch (err) {
    logger.warn({ err }, 'agentConfig: update policy view failed');
    return null;
  }
}

export const agentConfigService = {
  /** Drop the cached snapshot (settings write, group tree or tenant change). */
  invalidate(): void {
    _generation++;
    _snapshot = null;
    // A load started before the write may have read the old rows: never reuse it.
    _loading = null;
  },

  /** Resolved settings of many devices (one snapshot, no per-device query). */
  async resolveForDevices(refs: DeviceConfigRef[]): Promise<Map<number, ResolvedAgentSettings>> {
    const snap = await getSnapshot();
    const out = new Map<number, ResolvedAgentSettings>();
    for (const ref of refs) out.set(Number(ref.id), toSettings(resolveChain(snap, deviceChain(snap, ref))));
    return out;
  },

  async resolveForDevice(ref: DeviceConfigRef): Promise<ResolvedAgentSettings> {
    const snap = await getSnapshot();
    return toSettings(resolveChain(snap, deviceChain(snap, ref)));
  },

  /** Resolved settings of a device by id (null when it does not exist). */
  async resolveForDeviceId(deviceId: number): Promise<ResolvedAgentSettings | null> {
    const row = await loadDeviceRef(deviceId);
    return row ? this.resolveForDevice(refOf(row)) : null;
  },

  /**
   * Offline grace of a device: checkIntervalSeconds x maxMissedPushes, in ms
   * (obliguardHub). A failed lookup falls back to the defaults (2 min).
   */
  async offlineGraceMs(deviceId: number): Promise<number> {
    try {
      const s = await this.resolveForDeviceId(deviceId);
      if (s) return s.checkIntervalSeconds * s.maxMissedPushes * 1000;
    } catch (err) {
      logger.warn({ err, deviceId }, 'agentConfig: offline grace lookup failed');
    }
    return DEFAULT_GRACE_MS;
  },

  /**
   * Effective notification types of a device (every field resolved), same
   * shape as notificationService.resolveNotificationTypesForDevice.
   */
  async resolveNotificationTypesForDevice(deviceId: number): Promise<Record<NotificationTypeField, boolean>> {
    const s = await this.resolveForDeviceId(deviceId);
    return s ? s.notificationTypes : { ...DEFAULT_NOTIFICATION_TYPES };
  },

  /** Of `refs`, the ids whose autoBanEnabled resolves to false (ban engine). */
  async autoBanDisabledIds(refs: DeviceConfigRef[]): Promise<Set<number>> {
    const resolved = await this.resolveForDevices(refs);
    return new Set([...resolved].filter(([, s]) => !s.autoBanEnabled).map(([id]) => id));
  },

  /**
   * Settings view of one level (settings panels): what it inherits, its own
   * values and what applies there. `tenantId` is the scope's owning tenant
   * (the caller has checked access). updatePolicy is added for display.
   */
  async getScopeView(level: SettingLevel, scopeId: number | null, tenantId: number | null): Promise<ScopeSettingsView> {
    const snap = await getSnapshot();
    const owner = level === 'global' ? null : Number(tenantId ?? MASTER_TENANT_ID);
    let device: DeviceRow | null = null;
    let above: ChainLevel[];
    let self: ChainLevel;
    switch (level) {
      case 'global':
        above = [];
        self = GLOBAL_LEVEL;
        break;
      case 'tenant':
        above = [GLOBAL_LEVEL];
        self = tenantLevel(snap, Number(scopeId));
        break;
      case 'group': {
        const g = snap.groups.get(Number(scopeId));
        above = [GLOBAL_LEVEL, tenantLevel(snap, owner!), ...groupLevels(snap, scopeId, owner!, false)];
        self = { level: 'group', scopeId, name: g?.name ?? `Group ${scopeId}`, evaluateOnly: !!g?.evaluateOnly };
        break;
      }
      case 'agent': {
        device = await loadDeviceRef(Number(scopeId));
        const ref = device ? refOf(device) : { id: Number(scopeId), tenantId: owner!, groupId: null, evaluateOnly: false };
        above = [GLOBAL_LEVEL, tenantLevel(snap, ref.tenantId), ...groupLevels(snap, ref.groupId, ref.tenantId)];
        self = { level: 'agent', scopeId, name: 'This agent', evaluateOnly: !!ref.evaluateOnly };
        break;
      }
    }
    const resolved = resolveChain(snap, above);
    const effective = resolveChain(snap, [...above, self]);
    const overrides = await settingsService.getOwn(level, scopeId);

    const policy = await updatePolicyView(snap, level, scopeId, owner, device);
    if (policy) {
      resolved.updatePolicy = policy.inherited;
      effective.updatePolicy = policy.effective;
      if (policy.own) overrides.updatePolicy = policy.own;
    }
    return { level, scopeId, tenantId: owner, resolved, overrides, effective };
  },
};
