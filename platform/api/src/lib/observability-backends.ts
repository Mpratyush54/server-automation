/**
 * Upstream calls and response shaping for the observability proxies (#48).
 *
 * All requests go through `obsRequest`: fixed backend base URLs, a timeout, a
 * response size cap, and errors mapped to generic messages (upstream error
 * bodies are logged, never returned to the client).
 */
import axios from 'axios';
import { Backend, backendUrl, observabilityLimits } from './observability-config';
import { QueryScopeError } from './observability-scope';

export class UpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ObsRequest {
  backend: Backend;
  method?: 'GET' | 'POST';
  path: string;
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ObsResponse {
  status: number;
  data: any;
}

export type ObsTransport = (url: string, req: ObsRequest, limits: { timeoutMs: number; maxResponseBytes: number }) => Promise<ObsResponse>;

const axiosTransport: ObsTransport = async (url, req, limits) => {
  const res = await axios.request({
    url,
    method: req.method || 'GET',
    params: req.params,
    data: req.body,
    headers: { Accept: 'application/json', ...(req.headers || {}) },
    timeout: limits.timeoutMs,
    maxContentLength: limits.maxResponseBytes,
    maxBodyLength: 1024 * 1024,
    maxRedirects: 0,
    validateStatus: () => true,
    responseType: 'json',
  });
  return { status: res.status, data: res.data };
};

let transport: ObsTransport = axiosTransport;

/** Tests only: replace the HTTP transport (null restores axios). */
export function setObservabilityTransport(t: ObsTransport | null): void {
  transport = t || axiosTransport;
}

const LABEL: Record<Backend, string> = { prometheus: 'Metrics', loki: 'Logs', tempo: 'Traces', pyroscope: 'Profiles' };

export async function obsRequest(req: ObsRequest): Promise<any> {
  const limits = observabilityLimits();
  if (!req.path.startsWith('/') || req.path.includes('..')) throw new UpstreamError(500, 'invalid upstream path');
  const url = backendUrl(req.backend) + req.path;
  let res: ObsResponse;
  try {
    res = await transport(url, req, limits);
  } catch (err: any) {
    const code = String(err?.code || '');
    console.warn(`[observability] ${req.backend} ${req.path} failed: ${code || err?.message || err}`);
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(String(err?.message))) {
      throw new UpstreamError(504, `${LABEL[req.backend]} query timed out; narrow the time range or the query`);
    }
    if (/maxContentLength/i.test(String(err?.message)) || code === 'ERR_BAD_RESPONSE') {
      throw new UpstreamError(502, `${LABEL[req.backend]} response is too large; narrow the query`);
    }
    throw new UpstreamError(502, `${LABEL[req.backend]} backend is unavailable`);
  }
  if (res.status >= 200 && res.status < 300) return res.data;
  const detail = typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data ?? '').slice(0, 300);
  console.warn(`[observability] ${req.backend} ${req.path} HTTP ${res.status}: ${detail}`);
  if (res.status === 404) throw new UpstreamError(404, 'Not found');
  if (res.status === 400 || res.status === 422) throw new UpstreamError(400, `${LABEL[req.backend]} backend rejected the query; check its syntax`);
  if (res.status === 429 || res.status === 503) throw new UpstreamError(503, `${LABEL[req.backend]} backend is busy; retry shortly`);
  if (res.status === 504) throw new UpstreamError(504, `${LABEL[req.backend]} query timed out; narrow the time range or the query`);
  throw new UpstreamError(502, `${LABEL[req.backend]} backend error`);
}

// ---------------------------------------------------------------------------
// Time ranges
// ---------------------------------------------------------------------------

export interface TimeRange {
  /** Unix seconds. */
  start: number;
  end: number;
  clamped: boolean;
}

const DUR_RE = /^(\d+)(s|m|h|d|w)$/;
const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** `15m` / `1h` / `7d` -> seconds; null when invalid. */
export function parseDuration(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = DUR_RE.exec(v.trim());
  if (!m) return null;
  const s = Number(m[1]) * UNIT[m[2]];
  return s > 0 ? s : null;
}

function parseTime(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // Accept seconds, milliseconds and nanoseconds.
    if (n > 1e17) return n / 1e9;
    if (n > 1e11) return n / 1e3;
    return n;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new QueryScopeError(`invalid ${field}`);
  return t / 1000;
}

/**
 * `start`/`end` (unix s/ms/ns or RFC 3339) or `since` (duration, default 1h).
 * Ranges longer than the configured maximum are clamped to the most recent part.
 */
export function parseRange(q: Record<string, unknown>, now = Date.now(), defaultSince = 3600): TimeRange {
  const { maxRangeSeconds } = observabilityLimits();
  const nowS = now / 1000;
  let end = parseTime(q.end, 'end') ?? nowS;
  if (end > nowS + 300) end = nowS;
  let start = parseTime(q.start, 'start');
  if (start === null) {
    const since = q.since === undefined || q.since === '' ? defaultSince : parseDuration(q.since);
    if (since === null) throw new QueryScopeError('invalid since (use e.g. 15m, 1h, 24h, 7d)');
    start = end - since;
  }
  if (start >= end) throw new QueryScopeError('start must be before end');
  let clamped = false;
  if (end - start > maxRangeSeconds) {
    start = end - maxRangeSeconds;
    clamped = true;
  }
  return { start: Math.floor(start), end: Math.ceil(end), clamped };
}

/** Step (seconds) so a range query returns at most maxPoints points. */
export function rangeStep(range: TimeRange, requested?: unknown): number {
  const { maxPoints } = observabilityLimits();
  const span = range.end - range.start;
  const min = Math.max(1, Math.ceil(span / maxPoints));
  let step = 0;
  if (requested !== undefined && requested !== '') {
    const s = String(requested);
    step = /^\d+(\.\d+)?$/.test(s) ? Number(s) : parseDuration(s) ?? NaN;
    if (!Number.isFinite(step) || step <= 0) throw new QueryScopeError('invalid step');
  } else {
    step = Math.max(15, Math.ceil(span / 240));
  }
  return Math.max(min, Math.ceil(step));
}

/** `[<n>s]` window for rate() over a range, at least 1m. */
export function rateWindow(range: TimeRange): string {
  return `${Math.max(60, range.end - range.start)}s`;
}

// ---------------------------------------------------------------------------
// Prometheus
// ---------------------------------------------------------------------------

export interface PromResult {
  resultType: string;
  result: any[];
  truncated: boolean;
}

function capSeries(data: any, maxSeries: number): PromResult {
  const d = data?.data ?? {};
  const result = Array.isArray(d.result) ? d.result : [];
  return { resultType: String(d.resultType || 'vector'), result: result.slice(0, maxSeries), truncated: result.length > maxSeries };
}

export async function promInstant(query: string, time?: number): Promise<PromResult> {
  const limits = observabilityLimits();
  const data = await obsRequest({
    backend: 'prometheus',
    path: '/api/v1/query',
    params: { query, time, timeout: `${Math.floor(limits.timeoutMs / 1000)}s` },
  });
  return capSeries(data, limits.maxSeries);
}

export async function promRange(query: string, range: TimeRange, step: number): Promise<PromResult> {
  const limits = observabilityLimits();
  const data = await obsRequest({
    backend: 'prometheus',
    path: '/api/v1/query_range',
    params: { query, start: range.start, end: range.end, step, timeout: `${Math.floor(limits.timeoutMs / 1000)}s` },
  });
  return capSeries(data, limits.maxSeries);
}

/** Map of `label value -> number` from an instant vector. */
export function vectorBy(res: PromResult, label: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of res.result) {
    const k = String(s?.metric?.[label] ?? '');
    const v = Number(s?.value?.[1]);
    if (Number.isFinite(v)) out.set(k, v);
  }
  return out;
}

/** The single value of an instant vector (null when empty / NaN). */
export function scalarOf(res: PromResult): number | null {
  const v = Number(res.result[0]?.value?.[1]);
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Loki
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: string;
  line: string;
  labels: Record<string, string>;
  traceId: string | null;
  spanId: string | null;
}

const MAX_LINE = 16 * 1024;
const TRACE_KEYS = ['trace_id', 'traceid', 'traceID', 'traceId'];
const SPAN_KEYS = ['span_id', 'spanid', 'spanID', 'spanId'];

function pick(obj: Record<string, any> | undefined, keys: string[], re: RegExp): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && re.test(v)) return v.toLowerCase();
  }
  return null;
}

function idFromLine(line: string, keys: string[], re: RegExp): string | null {
  if (line.startsWith('{')) {
    try {
      const j = JSON.parse(line);
      const v = pick(j, keys, re);
      if (v) return v;
    } catch { /* not JSON */ }
  }
  const m = new RegExp(`(?:${keys.join('|')})["']?\\s*[=:]\\s*["']?([0-9a-fA-F]{16,32})`).exec(line);
  return m && re.test(m[1]) ? m[1].toLowerCase() : null;
}

const TRACE_RE = /^[0-9a-fA-F]{32}$/;
const SPAN_RE = /^[0-9a-fA-F]{16}$/;

export function shapeLokiStreams(data: any, limit: number): { entries: LogEntry[]; truncated: boolean } {
  const result = Array.isArray(data?.data?.result) ? data.data.result : [];
  const entries: LogEntry[] = [];
  for (const s of result) {
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(s?.stream || {})) labels[k] = String(v);
    for (const v of Array.isArray(s?.values) ? s.values : []) {
      const line = String(v?.[1] ?? '');
      const meta = v?.[2] && typeof v[2] === 'object' ? { ...(v[2].structuredMetadata || {}), ...(v[2].parsed || {}) } : {};
      const all = { ...labels, ...meta };
      entries.push({
        ts: String(v?.[0] ?? ''),
        line: line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line,
        labels: all,
        // Per-entry structured metadata, then the line itself, then stream labels.
        traceId: pick(meta, TRACE_KEYS, TRACE_RE) || idFromLine(line, TRACE_KEYS, TRACE_RE) || pick(labels, TRACE_KEYS, TRACE_RE),
        spanId: pick(meta, SPAN_KEYS, SPAN_RE) || idFromLine(line, SPAN_KEYS, SPAN_RE) || pick(labels, SPAN_KEYS, SPAN_RE),
      });
    }
  }
  entries.sort((a, b) => (BigInt(b.ts || '0') > BigInt(a.ts || '0') ? 1 : BigInt(b.ts || '0') < BigInt(a.ts || '0') ? -1 : 0));
  return { entries: entries.slice(0, limit), truncated: entries.length > limit };
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

export interface TraceSummary {
  traceId: string;
  rootServiceName: string | null;
  startTime: string | null;
  durationMs: number | null;
  spans: Array<{ spanId: string; name: string | null; serviceName: string | null; startTime: string | null; durationMs: number | null; attributes: Record<string, unknown> }>;
  matched: number;
}

function attrValue(v: any): unknown {
  if (!v || typeof v !== 'object') return v ?? null;
  if ('stringValue' in v) return String(v.stringValue).slice(0, 2048);
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('arrayValue' in v) return (v.arrayValue?.values || []).slice(0, 32).map(attrValue);
  return null;
}

function attrsToObject(list: any, max = 64): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(list)) return out;
  for (const a of list.slice(0, max)) {
    if (a && typeof a.key === 'string') out[a.key.slice(0, 200)] = attrValue(a.value);
  }
  return out;
}

/**
 * Shape a Tempo search response. The root service / root span name belong to
 * the trace's root, which may be a span of another project; the root service
 * name is only kept when it is one of the caller's own services.
 */
export function shapeTempoSearch(data: any, ownServices: Set<string>, limit: number): TraceSummary[] {
  const traces = Array.isArray(data?.traces) ? data.traces : [];
  return traces.slice(0, limit).map((t: any) => {
    const sets = Array.isArray(t?.spanSets) ? t.spanSets : t?.spanSet ? [t.spanSet] : [];
    const spans: TraceSummary['spans'] = [];
    let matched = 0;
    for (const s of sets) {
      matched += Number(s?.matched || 0);
      for (const sp of Array.isArray(s?.spans) ? s.spans : []) {
        const attributes = attrsToObject(sp?.attributes, 16);
        spans.push({
          spanId: String(sp?.spanID || sp?.spanId || ''),
          name: sp?.name ? String(sp.name) : null,
          serviceName: typeof attributes['service.name'] === 'string' ? String(attributes['service.name']) : null,
          startTime: sp?.startTimeUnixNano ? String(sp.startTimeUnixNano) : null,
          durationMs: sp?.durationNanos !== undefined ? Number(sp.durationNanos) / 1e6 : null,
          attributes,
        });
        if (spans.length >= 10) break;
      }
    }
    const root = typeof t?.rootServiceName === 'string' && ownServices.has(t.rootServiceName) ? t.rootServiceName : null;
    return {
      traceId: String(t?.traceID || t?.traceId || ''),
      rootServiceName: root,
      startTime: t?.startTimeUnixNano ? String(t.startTimeUnixNano) : null,
      durationMs: t?.durationMs !== undefined ? Number(t.durationMs) : null,
      spans,
      matched,
    };
  });
}

export interface FlatSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  serviceName: string;
  environment: string | null;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
  status: { code: string; message: string | null };
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  events: Array<{ name: string; timeUnixNano: string; attributes: Record<string, unknown> }>;
}

/** OTLP JSON ids are hex or base64 (protojson bytes); normalise to lowercase hex. */
export function normaliseId(v: unknown): string {
  const s = String(v ?? '');
  if (!s) return '';
  if (/^[0-9a-fA-F]+$/.test(s) && (s.length === 16 || s.length === 32)) return s.toLowerCase();
  try {
    const hex = Buffer.from(s, 'base64').toString('hex');
    if (hex.length === 16 || hex.length === 32) return hex;
  } catch { /* fall through */ }
  return s.toLowerCase().replace(/[^0-9a-f]/g, '');
}

const KIND_NAMES = ['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
const STATUS_NAMES = ['UNSET', 'OK', 'ERROR'];

function enumName(v: unknown, names: string[], prefix: string): string {
  if (typeof v === 'number') return names[v] || 'UNSPECIFIED';
  const s = String(v ?? '').toUpperCase().replace(prefix, '');
  return s || names[0];
}

/**
 * Keep only the spans whose resource carries the caller's project id. Spans of
 * other projects in the same distributed trace are dropped (only their number
 * is reported); the caller gets 404 when no span is theirs.
 */
export function filterTraceToProject(data: any, projectId: string, maxSpans: number): { spans: FlatSpan[]; hiddenSpans: number; truncated: boolean } {
  const resourceSpans = Array.isArray(data?.batches) ? data.batches
    : Array.isArray(data?.resourceSpans) ? data.resourceSpans
      : Array.isArray(data?.trace?.resourceSpans) ? data.trace.resourceSpans
        : Array.isArray(data?.trace?.batches) ? data.trace.batches : [];
  const spans: FlatSpan[] = [];
  let hiddenSpans = 0;
  let truncated = false;
  for (const rs of resourceSpans) {
    const resource = attrsToObject(rs?.resource?.attributes, 128);
    const scopes = Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : Array.isArray(rs?.instrumentationLibrarySpans) ? rs.instrumentationLibrarySpans : [];
    const own = resource['platform.project_id'] === projectId;
    for (const ss of scopes) {
      for (const sp of Array.isArray(ss?.spans) ? ss.spans : []) {
        if (!own) { hiddenSpans++; continue; }
        if (spans.length >= maxSpans) { truncated = true; continue; }
        const start = String(sp?.startTimeUnixNano ?? '0');
        const end = String(sp?.endTimeUnixNano ?? start);
        let durationMs = 0;
        try { durationMs = Number(BigInt(end) - BigInt(start)) / 1e6; } catch { durationMs = 0; }
        spans.push({
          traceId: normaliseId(sp?.traceId),
          spanId: normaliseId(sp?.spanId),
          parentSpanId: sp?.parentSpanId ? normaliseId(sp.parentSpanId) || null : null,
          name: String(sp?.name ?? '').slice(0, 500),
          kind: enumName(sp?.kind, KIND_NAMES, 'SPAN_KIND_'),
          serviceName: String(resource['service.name'] ?? 'unknown'),
          environment: resource['deployment.environment'] ? String(resource['deployment.environment']) : null,
          startTimeUnixNano: start,
          endTimeUnixNano: end,
          durationMs,
          status: { code: enumName(sp?.status?.code, STATUS_NAMES, 'STATUS_CODE_'), message: sp?.status?.message ? String(sp.status.message).slice(0, 1000) : null },
          attributes: attrsToObject(sp?.attributes),
          resource,
          events: (Array.isArray(sp?.events) ? sp.events : []).slice(0, 32).map((e: any) => ({
            name: String(e?.name ?? '').slice(0, 200),
            timeUnixNano: String(e?.timeUnixNano ?? ''),
            attributes: attrsToObject(e?.attributes, 32),
          })),
        });
      }
    }
  }
  spans.sort((a, b) => { try { const d = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano); return d < 0n ? -1 : d > 0n ? 1 : 0; } catch { return 0; } });
  return { spans, hiddenSpans, truncated };
}

// ---------------------------------------------------------------------------
// Pyroscope
// ---------------------------------------------------------------------------

export function shapeFlamegraph(data: any): { flamebearer: { names: string[]; levels: number[][]; numTicks: number; maxSelf: number }; metadata: Record<string, unknown> } | null {
  const fb = data?.flamebearer;
  if (!fb || !Array.isArray(fb.names) || !Array.isArray(fb.levels)) return null;
  const m = data?.metadata || {};
  return {
    flamebearer: {
      names: fb.names.slice(0, 50_000).map((n: unknown) => String(n).slice(0, 500)),
      levels: fb.levels.slice(0, 2000).map((l: unknown) => (Array.isArray(l) ? l.slice(0, 200_000).map(Number) : [])),
      numTicks: Number(fb.numTicks) || 0,
      maxSelf: Number(fb.maxSelf) || 0,
    },
    metadata: { units: m.units ?? null, format: m.format ?? 'single', name: m.name ?? null, sampleRate: m.sampleRate ?? null, spyName: m.spyName ?? null },
  };
}
