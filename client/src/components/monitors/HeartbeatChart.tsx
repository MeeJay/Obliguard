import { useMemo, useState, useCallback } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceArea,
} from 'recharts';
import type { Heartbeat } from '@/store/monitorStore';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ChartPoint {
  ts: number;          // epoch ms — XAxis numeric key
  rt: number | null;   // null → visual gap
  hasOutage: boolean;  // some failures in bucket → orange tint
  allDown: boolean;    // all checks in bucket failed → red tint
  fullLabel: string;   // tooltip header
  slotEnd: number;     // right-edge of bucket (ms) — for ReferenceArea x2
  tickLabel: string;   // formatted x-axis tick label
}

interface RefArea { x1: number; x2: number; fill: string; opacity: number }

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
const fmtDate   = (d: Date) => `${p2(d.getDate())} ${MONTHS[d.getMonth()]}`;
const fmtDateHm = (d: Date) => `${fmtDate(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const fmtHms    = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const fmtHm     = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

// ─────────────────────────────────────────────────────────────────────────────
// Period → milliseconds
// ─────────────────────────────────────────────────────────────────────────────

const PERIOD_MS: Record<string, number> = {
  '1h':   3_600_000,
  '24h':  86_400_000,
  '7d':   604_800_000,
  '30d':  2_592_000_000,
  '365d': 31_536_000_000,
};

// Always 60 buckets: bucket size = total period / 60
const N_BUCKETS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Build ChartPoint[60] from raw heartbeats
// ─────────────────────────────────────────────────────────────────────────────

function buildPoints(
  heartbeats: Heartbeat[],
  period: string,
  customRange?: { from: Date; to: Date },
): ChartPoint[] {
  const now = Date.now();

  // Determine range boundaries and bucket size
  let rangeStart: number;
  let bucketMs: number;
  let fullLabelFn: (d: Date) => string;
  let tickLabelFn: (ts: number) => string;

  if (customRange) {
    rangeStart = customRange.from.getTime();
    const rangeEnd = customRange.to.getTime();
    bucketMs = (rangeEnd - rangeStart) / N_BUCKETS;
    const rangeDays = bucketMs * N_BUCKETS / 86_400_000;
    if (rangeDays < 0.1)     { fullLabelFn = fmtHms;    tickLabelFn = ts => fmtHms(new Date(ts)); }
    else if (rangeDays < 3)  { fullLabelFn = fmtDateHm; tickLabelFn = ts => fmtHm(new Date(ts)); }
    else                     { fullLabelFn = fmtDate;   tickLabelFn = ts => fmtDate(new Date(ts)); }
  } else {
    const totalMs  = PERIOD_MS[period] ?? PERIOD_MS['24h'];
    rangeStart     = now - totalMs;
    bucketMs       = totalMs / N_BUCKETS;

    switch (period) {
      case '1h':
        fullLabelFn = fmtHms;
        tickLabelFn = ts => fmtHms(new Date(ts));
        break;
      case '24h':
        fullLabelFn = fmtDateHm;
        tickLabelFn = ts => fmtHm(new Date(ts));
        break;
      case '7d': {
        // bucketMs ≈ 2h48m — show start hour in label
        const bh = Math.round(bucketMs / 3_600_000);
        fullLabelFn = d => `${fmtDate(d)} ${p2(d.getHours())}:00 – ${p2((d.getHours() + bh) % 24)}:00`;
        tickLabelFn = ts => { const d = new Date(ts); return `${p2(d.getDate())}/${p2(d.getMonth()+1)} ${p2(d.getHours())}h`; };
        break;
      }
      case '30d':
        // bucketMs = 12h — 2 per day; label shows date + half-day
        fullLabelFn = d => `${fmtDate(d)} ${p2(d.getHours())}:00 – ${p2((d.getHours() + 12) % 24)}:00`;
        tickLabelFn = ts => fmtDate(new Date(ts));
        break;
      default: // 365d — bucketMs ≈ 6.1 days
        fullLabelFn = d => `${fmtDate(d)} – ${fmtDate(new Date(d.getTime() + bucketMs))}`;
        tickLabelFn = ts => fmtDate(new Date(ts));
        break;
    }
  }

  // Generate N_BUCKETS equidistant slots
  const slotList = Array.from({ length: N_BUCKETS }, (_, i) => rangeStart + i * bucketMs);

  // Seed bucket map
  const buckets = new Map<number, { upRts: number[]; total: number }>();
  for (const ts of slotList) buckets.set(ts, { upRts: [], total: 0 });

  // Distribute heartbeats into buckets by index
  for (const hb of heartbeats) {
    if (!hb.createdAt) continue;
    const hbMs = new Date(hb.createdAt).getTime();
    const idx  = Math.min(N_BUCKETS - 1, Math.max(0, Math.floor((hbMs - rangeStart) / bucketMs)));
    const b    = buckets.get(slotList[idx]);
    if (!b) continue;
    b.total++;
    if (hb.status === 'up' && hb.responseTime != null) b.upRts.push(hb.responseTime);
  }

  return slotList.map(ts => {
    const b    = buckets.get(ts)!;
    const d    = new Date(ts);
    // Average excludes failed checks — only upRts contribute
    const avg  = b.upRts.length > 0
      ? Math.round(b.upRts.reduce((s, v) => s + v, 0) / b.upRts.length)
      : null;
    const allDown = b.total > 0 && b.upRts.length === 0;
    return {
      ts,
      rt:        avg,
      hasOutage: b.total > 0 && b.upRts.length < b.total,
      allDown,
      fullLabel: fullLabelFn(d),
      slotEnd:   ts + bucketMs,
      tickLabel: tickLabelFn(ts),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference areas (outage shading)
// ─────────────────────────────────────────────────────────────────────────────

function buildRefAreas(points: ChartPoint[]): RefArea[] {
  return points.flatMap(pt => {
    if (pt.allDown)  return [{ x1: pt.ts, x2: pt.slotEnd, fill: '#ef4444', opacity: 0.13 }];
    if (pt.hasOutage) return [{ x1: pt.ts, x2: pt.slotEnd, fill: '#f97316', opacity: 0.13 }];
    return [];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticks: every 3rd bucket → 20 labels
// ─────────────────────────────────────────────────────────────────────────────

function getTicks(points: ChartPoint[]): number[] {
  return points.filter((_, i) => i % 3 === 0).map(p => p.ts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom tooltip
// ─────────────────────────────────────────────────────────────────────────────

interface TPay { payload: ChartPoint; value: number | null }

function CustomTooltip({ active, payload }: { active?: boolean; payload?: TPay[] }) {
  if (!active || !payload?.length) return null;
  const pt = payload[0]?.payload;
  if (!pt) return null;
  return (
    <div style={{
      background: '#161b22', border: '1px solid #30363d', borderRadius: 6,
      padding: '8px 12px', fontSize: 12, color: '#e6edf3', lineHeight: 1.6,
    }}>
      <div style={{ color: '#8b949e', marginBottom: 4 }}>{pt.fullLabel}</div>
      {pt.rt !== null ? (
        <>
          <span style={{ color: '#58a6ff', fontWeight: 600 }}>{pt.rt} ms</span>
          {pt.hasOutage && (
            <div style={{ color: '#f97316', fontSize: 11, marginTop: 2 }}>⚠ Partial outage in window</div>
          )}
        </>
      ) : (
        <div style={{ color: '#ef4444' }}>
          {pt.hasOutage ? 'All checks failed' : 'No data'}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────────────────────

function EmptyChart({ height, msg }: { height: number; msg: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-border bg-bg-secondary text-text-muted text-sm"
      style={{ height }}
    >
      {msg}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public props
// ─────────────────────────────────────────────────────────────────────────────

export interface HeartbeatChartProps {
  heartbeats: Heartbeat[];
  height?: number;
  period?: string;
  /** When true, plots heartbeat.value (value_watcher monitors) */
  valueMode?: boolean;
  /** Called when the user drag-selects a range to zoom into */
  onZoom?: (from: Date, to: Date) => void;
  /** True when we are in a zoomed view */
  isZoomed?: boolean;
  /** Resets to the original period view */
  onZoomReset?: () => void;
  /** Custom date range (used when zoomed) — overrides period bucketing */
  customRange?: { from: Date; to: Date };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function HeartbeatChart({
  heartbeats,
  height = 200,
  period = '24h',
  valueMode = false,
  onZoom,
  isZoomed = false,
  onZoomReset,
  customRange,
}: HeartbeatChartProps) {

  // ── Drag-to-zoom state ────────────────────────────────────────────────────
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd,   setDragEnd]   = useState<number | null>(null);
  const [dragging,  setDragging]  = useState(false);

  const onMouseDown = useCallback((e: { activeLabel?: number | string | null }) => {
    if (!onZoom || e?.activeLabel == null) return;
    setDragStart(Number(e.activeLabel));
    setDragEnd(null);
    setDragging(true);
  }, [onZoom]);

  const onMouseMove = useCallback((e: { activeLabel?: number | string | null }) => {
    if (!dragging || e?.activeLabel == null) return;
    setDragEnd(Number(e.activeLabel));
  }, [dragging]);

  const onMouseUp = useCallback((e: { activeLabel?: number | string | null }) => {
    if (!dragging) return;
    setDragging(false);
    const l = dragStart;
    const r = dragEnd ?? (e?.activeLabel != null ? Number(e.activeLabel) : null);
    setDragStart(null);
    setDragEnd(null);
    if (l === null || r === null) return;
    const from = new Date(Math.min(l, r));
    const to   = new Date(Math.max(l, r));
    // Ignore selections smaller than 1 minute
    if (to.getTime() - from.getTime() < 60_000) return;
    onZoom?.(from, to);
  }, [dragging, dragStart, dragEnd, onZoom]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const points   = useMemo(() => buildPoints(heartbeats, period, customRange), [heartbeats, period, customRange]);
  const refAreas = useMemo(() => buildRefAreas(points),                        [points]);
  const ticks    = useMemo(() => getTicks(points),                             [points]);

  // tickFormatter reads tickLabel from the point matching each tick ts
  const tickLabelMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const pt of points) map.set(pt.ts, pt.tickLabel);
    return map;
  }, [points]);
  const tickFormatter = useCallback((ts: number) => tickLabelMap.get(ts) ?? '', [tickLabelMap]);

  // ── Y-axis domain ─────────────────────────────────────────────────────────
  // Always start at 0 so the scale is consistent whether zoomed or not.
  // 'auto' top lets recharts compute the max from non-null data points.
  const yDomain: [number, string] = [0, 'auto'];

  // ── value_watcher mode (unchanged) ───────────────────────────────────────
  if (valueMode) {
    const vdata = heartbeats
      .filter(h => h.value != null && h.createdAt != null)
      .map(h => ({ time: new Date(h.createdAt!).toLocaleTimeString(), value: Number(h.value) }))
      .filter(d => !isNaN(d.value));
    if (!vdata.length) return <EmptyChart height={height} msg="No value data available" />;
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={vdata} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <defs>
            <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#f0b429" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#f0b429" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
          <XAxis dataKey="time" tick={{ fill: '#8b949e', fontSize: 11 }} stroke="#30363d" />
          <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} stroke="#30363d"
            tickFormatter={(v: number) => v.toLocaleString()} />
          <Tooltip
            contentStyle={{ backgroundColor: '#161b22', border: '1px solid #30363d',
              borderRadius: '6px', color: '#e6edf3', fontSize: '12px' }}
            formatter={(v: number) => [v.toLocaleString(), 'Value']}
          />
          <Area type="monotone" dataKey="value" stroke="#f0b429" strokeWidth={2} fill="url(#vg)" />
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  if (points.length === 0 || !points.some(p => p.rt !== null)) {
    return <EmptyChart height={height} msg="No response time data available" />;
  }

  const domain: [number, number] = [points[0].ts, points[points.length - 1].slotEnd];

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>
      {/* ── Reset zoom button ─────────────────────────────────────────────── */}
      {isZoomed && onZoomReset && (
        <button
          onClick={onZoomReset}
          title="Revenir à la période d'origine"
          style={{
            position: 'absolute', top: 6, right: 8, zIndex: 10,
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'rgba(22,27,34,0.92)', border: '1px solid #30363d',
            borderRadius: 6, padding: '3px 8px', fontSize: 11,
            color: '#8b949e', cursor: 'pointer', lineHeight: 1.4,
          }}
        >
          ↺ Reset zoom
        </button>
      )}

      {/* ── Hint while not zoomed ─────────────────────────────────────────── */}
      {!isZoomed && onZoom && (
        <div style={{
          position: 'absolute', top: 6, right: 8, zIndex: 10,
          fontSize: 10, color: '#484f58', pointerEvents: 'none',
        }}>
          Glisser pour zoomer
        </div>
      )}

      <ResponsiveContainer width="100%" height={height}>
        <AreaChart
          data={points}
          margin={{ top: 5, right: 5, bottom: 5, left: 5 }}
          onMouseDown={onMouseDown as any}
          onMouseMove={onMouseMove as any}
          onMouseUp={onMouseUp as any}
          style={{ cursor: onZoom ? 'crosshair' : 'default' }}
        >
          <defs>
            <linearGradient id="rtg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#58a6ff" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* Failure / outage background shading */}
          {refAreas.map((a, i) => (
            <ReferenceArea key={`ra-${i}`}
              x1={a.x1} x2={a.x2}
              fill={a.fill} fillOpacity={a.opacity}
              stroke="none"
            />
          ))}

          {/* Drag selection indicator */}
          {dragging && dragStart !== null && dragEnd !== null && (
            <ReferenceArea
              x1={Math.min(dragStart, dragEnd)}
              x2={Math.max(dragStart, dragEnd)}
              fill="#58a6ff"
              fillOpacity={0.08}
              stroke="#58a6ff"
              strokeOpacity={0.5}
              strokeWidth={1}
            />
          )}

          <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />

          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={domain}
            ticks={ticks}
            tickFormatter={tickFormatter}
            tick={{ fill: '#8b949e', fontSize: 10 }}
            stroke="#30363d"
          />
          <YAxis
            tick={{ fill: '#8b949e', fontSize: 11 }}
            stroke="#30363d"
            unit="ms"
            domain={yDomain}
            width={60}
          />

          {/* Hide tooltip while drag-selecting to avoid flicker */}
          {!dragging && <Tooltip content={<CustomTooltip />} />}

          <Area
            type="monotone"
            dataKey="rt"
            stroke="#58a6ff"
            strokeWidth={2}
            fill="url(#rtg)"
            connectNulls={true}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
