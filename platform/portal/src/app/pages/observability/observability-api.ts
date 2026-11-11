/**
 * Observability views (#48): API paths, formatting and pure layout helpers
 * (trace waterfall, service map, flame graph, chart paths). No chart library:
 * everything renders as SVG/HTML with the theme tokens in obs-theme.css.
 */

export const SINCE_OPTIONS = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
];
export const DEFAULT_SINCE = '1h';
export const SINCE_SECONDS: Record<string, number> = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };

/** Time range echoed by the API; `clamped` when it was shortened server-side. */
export interface ApiRange { start: number; end: number; clamped?: boolean }

/** Short duration label: 7 d, 24 h, 23 h 59 min, 15 min. */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} d`);
  if (h) parts.push(`${h} h`);
  if (m && !d) parts.push(`${m} min`);
  return parts.slice(0, 2).join(' ') || `${s} s`;
}

/**
 * "Range shortened to N" when the API reports `range.clamped`. Trims of under 1 %
 * of the requested window (e.g. Pyroscope's 24 h → 23 h 59 min) are not worth a notice.
 */
export function rangeNotice(range: ApiRange | null | undefined, requestedSeconds?: number): string {
  if (!range?.clamped) return '';
  const actual = range.end - range.start;
  if (requestedSeconds && actual >= requestedSeconds * 0.99) return '';
  return `Range shortened to ${fmtDuration(actual)}`;
}

export const PROJECT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'apm', label: 'APM' },
  { id: 'traces', label: 'Traces' },
  { id: 'logs', label: 'Logs' },
  { id: 'errors', label: 'Errors' },
  { id: 'rum', label: 'RUM' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'synthetics', label: 'Synthetics' },
  { id: 'infra', label: 'Infra' },
  { id: 'profiles', label: 'Profiles' },
] as const;
export type ProjectTab = typeof PROJECT_TABS[number]['id'];

export function isProjectTab(v: string | null | undefined): v is ProjectTab {
  return !!v && PROJECT_TABS.some((t) => t.id === v);
}

export function isSince(v: string | null | undefined): boolean {
  return !!v && SINCE_OPTIONS.some((o) => o.value === v);
}

export function projectBase(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/observability`;
}

export type Health = 'healthy' | 'degraded' | 'critical' | 'unknown';

export interface FleetRow {
  projectId: string;
  name: string;
  requestRate: number | null;
  errorRate: number | null;
  p95Ms: number | null;
  activeAlerts: number;
  criticalAlerts: number;
  openErrors: number;
  synthetics: string | null;
  slos: { total: number; breaching: number };
  health: Health;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtRate(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 100) return `${v.toFixed(0)}/s`;
  if (v >= 1) return `${v.toFixed(1)}/s`;
  if (v * 60 >= 1) return `${(v * 60).toFixed(1)}/min`;
  return v === 0 ? '0/s' : `${(v * 3600).toFixed(1)}/h`;
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v < 10 ? `${v.toFixed(2)}%` : `${v.toFixed(1)}%`;
}

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 60_000) return `${(v / 60_000).toFixed(1)} min`;
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 1) return `${v.toFixed(v >= 100 ? 0 : 1)} ms`;
  return `${(v * 1000).toFixed(0)} µs`;
}

export function fmtBytes(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Nanosecond timestamp string -> Date. */
export function nsToDate(ns: string | null | undefined): Date | null {
  if (!ns || !/^\d+$/.test(ns)) return null;
  return new Date(Number(BigInt(ns) / 1_000_000n));
}

export function healthLabel(h: Health): string {
  return { healthy: 'Healthy', degraded: 'Degraded', critical: 'Critical', unknown: 'No data' }[h] || 'No data';
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export type Point = [number, number | null];

export interface ChartGeometry {
  paths: string[];
  yMax: number;
  tMin: number;
  tMax: number;
}

/** SVG path data for each series (gaps for null values), sharing one y scale from 0. */
export function chartPaths(series: Point[][], width: number, height: number, tRange?: [number, number]): ChartGeometry {
  const all = series.flat();
  const ts = all.map((p) => p[0]);
  const tMin = tRange ? tRange[0] : Math.min(...ts);
  const tMax = tRange ? tRange[1] : Math.max(...ts);
  const vals = all.map((p) => p[1]).filter((v): v is number => v !== null && Number.isFinite(v));
  const yMax = vals.length ? Math.max(...vals) * 1.1 || 1 : 1;
  const span = tMax - tMin || 1;
  const x = (t: number) => ((t - tMin) / span) * width;
  const y = (v: number) => height - (v / yMax) * height;
  const paths = series.map((pts) => {
    let d = '';
    let pen = false;
    for (const [t, v] of pts) {
      if (v === null || !Number.isFinite(v)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  });
  return { paths, yMax, tMin: Number.isFinite(tMin) ? tMin : 0, tMax: Number.isFinite(tMax) ? tMax : 0 };
}

// ---------------------------------------------------------------------------
// Trace waterfall
// ---------------------------------------------------------------------------

export interface Span {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  serviceName: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
  status: { code: string; message: string | null };
  attributes: Record<string, unknown>;
  resource?: Record<string, unknown>;
  events?: Array<{ name: string; timeUnixNano: string; attributes: Record<string, unknown> }>;
}

export interface WaterfallRow {
  span: Span;
  depth: number;
  /** Percent of the trace duration. */
  offset: number;
  width: number;
  error: boolean;
}

/**
 * Order spans depth-first from the roots (spans whose parent is absent — e.g.
 * hidden spans of another project — become roots) and compute bar geometry.
 */
export function buildWaterfall(spans: Span[]): { rows: WaterfallRow[]; durationMs: number } {
  if (!spans.length) return { rows: [], durationMs: 0 };
  const start = spans.reduce((m, s) => (BigInt(s.startTimeUnixNano) < m ? BigInt(s.startTimeUnixNano) : m), BigInt(spans[0].startTimeUnixNano));
  const end = spans.reduce((m, s) => (BigInt(s.endTimeUnixNano) > m ? BigInt(s.endTimeUnixNano) : m), BigInt(spans[0].endTimeUnixNano));
  const total = Number(end - start) || 1;
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const s of spans) {
    if (s.parentSpanId && ids.has(s.parentSpanId) && s.parentSpanId !== s.spanId) {
      const list = children.get(s.parentSpanId) || [];
      list.push(s);
      children.set(s.parentSpanId, list);
    } else roots.push(s);
  }
  const byStart = (a: Span, b: Span) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1);
  const rows: WaterfallRow[] = [];
  const seen = new Set<string>();
  const walk = (s: Span, depth: number) => {
    if (seen.has(s.spanId)) return;
    seen.add(s.spanId);
    const offset = (Number(BigInt(s.startTimeUnixNano) - start) / total) * 100;
    const width = Math.max(0.3, (Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / total) * 100);
    rows.push({ span: s, depth, offset, width: Math.min(width, 100 - offset), error: s.status?.code === 'ERROR' });
    for (const c of (children.get(s.spanId) || []).sort(byStart)) walk(c, depth + 1);
  };
  for (const r of roots.sort(byStart)) walk(r, 0);
  return { rows, durationMs: total / 1e6 };
}

// ---------------------------------------------------------------------------
// Service map
// ---------------------------------------------------------------------------

export interface GraphNode { id: string; external: boolean; virtual: boolean }
export interface GraphEdge { source: string; target: string; requestRate: number; errorRate: number | null }
export interface PlacedNode extends GraphNode { x: number; y: number }

/** Layered left-to-right layout: callers left of callees (cycles broken by visit order). */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], colWidth = 200, rowHeight = 70): { nodes: PlacedNode[]; width: number; height: number } {
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) if (e.source !== e.target) incoming.set(e.target, (incoming.get(e.target) || 0) + 1);
  const level = new Map<string, number>();
  const queue = nodes.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  for (const id of queue) level.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const e of edges) {
      if (e.source !== id || e.target === id) continue;
      const next = (level.get(id) || 0) + 1;
      if (!level.has(e.target) && next < nodes.length) { level.set(e.target, next); queue.push(e.target); }
    }
  }
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, 0);
  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    const l = level.get(n.id)!;
    columns.set(l, [...(columns.get(l) || []), n.id]);
  }
  const placed: PlacedNode[] = nodes.map((n) => {
    const l = level.get(n.id)!;
    const col = columns.get(l)!;
    return { ...n, x: 90 + l * colWidth, y: 40 + col.indexOf(n.id) * rowHeight };
  });
  const width = Math.max(300, 180 + (Math.max(0, ...level.values())) * colWidth);
  const height = Math.max(120, 40 + Math.max(...[...columns.values()].map((c) => c.length)) * rowHeight);
  return { nodes: placed, width, height };
}

// ---------------------------------------------------------------------------
// Flame graph (Pyroscope flamebearer, single format)
// ---------------------------------------------------------------------------

export interface Flamebearer { names: string[]; levels: number[][]; numTicks: number; maxSelf: number }
export interface FlameRect { level: number; start: number; width: number; name: string; total: number; self: number }

/** Decode flamebearer levels ([offset delta, total, self, nameIndex] quadruples) into rectangles (0..1 widths). */
export function flameRects(fb: Flamebearer, minWidth = 0.002): FlameRect[] {
  const out: FlameRect[] = [];
  const ticks = fb.numTicks || 1;
  fb.levels.forEach((level, li) => {
    let x = 0;
    for (let i = 0; i + 3 < level.length; i += 4) {
      const start = x + level[i];
      const total = level[i + 1];
      x = start + total;
      const width = total / ticks;
      if (width < minWidth) continue;
      out.push({ level: li, start: start / ticks, width, name: fb.names[level[i + 3]] ?? '?', total, self: level[i + 2] });
    }
  });
  return out;
}

/** Human label for a status enum: "major_outage" -> "Major outage". */
export function humanizeStatus(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).replace(/[_-]+/g, ' ').trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}
