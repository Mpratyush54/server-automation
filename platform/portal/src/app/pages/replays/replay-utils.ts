/** Pure helpers for the session replay pages (#40); unit-tested in replays.component.spec.ts. */

export interface ReplaySessionRow {
  session_id: string;
  environment: string | null;
  release: string | null;
  app: string | null;
  user_id: string | null;
  user_agent: string | null;
  first_page: string | null;
  pages: string[];
  trace_ids: string[];
  started_at: string;
  ended_at: string;
  duration_ms: number | string;
  chunk_count: number;
  event_count: number | string;
  bytes: number | string;
  error_count: number;
  network_error_count: number;
  viewport_width: number | null;
  viewport_height: number | null;
}

export interface ReplayErrorRow {
  id: string;
  issue_id: string;
  received_at: string;
  title: string;
  type: string | null;
  message: string | null;
  trace_id: string | null;
  release: string | null;
}

export interface ReplayFilters {
  page: string;
  errors: '' | 'true' | 'false';
  minDurationSec: number | null;
  maxDurationSec: number | null;
  environment: string;
}

export type MarkerKind = 'error' | 'network' | 'navigation';

export interface ReplayMarker {
  kind: MarkerKind;
  /** Milliseconds from the start of the recording. */
  offsetMs: number;
  label: string;
  traceId?: string | null;
  issueId?: string;
  failed?: boolean;
}

/** Query params for GET /api/projects/:id/replays. */
export function listParams(f: ReplayFilters, offset = 0): Record<string, string> {
  const out: Record<string, string> = { limit: '50', offset: String(offset) };
  if (f.page.trim()) out['page'] = f.page.trim();
  if (f.errors) out['errors'] = f.errors;
  if (f.minDurationSec != null && f.minDurationSec >= 0) out['minDurationMs'] = String(Math.round(f.minDurationSec * 1000));
  if (f.maxDurationSec != null && f.maxDurationSec > 0) out['maxDurationMs'] = String(Math.round(f.maxDurationSec * 1000));
  if (f.environment.trim()) out['environment'] = f.environment.trim();
  return out;
}

export function formatDuration(raw: number | string | null | undefined): string {
  const ms = Number(raw) || 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Short browser label from a user agent (no fingerprinting detail). */
export function browserLabel(ua: string | null | undefined): string {
  const u = ua || '';
  const os = /Android/.test(u) ? 'Android' : /iPhone|iPad/.test(u) ? 'iOS' : /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : '';
  const b = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : u ? 'Other' : '—';
  return os ? `${b} · ${os}` : b;
}

/** All rrweb events of a session: chunks in seq order, events sorted by timestamp (stable). */
export function mergeChunkEvents(chunks: Array<{ seq: number; events?: any[] } | null>): any[] {
  const ordered = chunks.filter((c): c is { seq: number; events?: any[] } => !!c).sort((a, b) => a.seq - b.seq);
  const all: Array<[any, number]> = [];
  for (const c of ordered) for (const e of c.events || []) if (e && Number.isFinite(Number(e.timestamp))) all.push([e, all.length]);
  all.sort((a, b) => Number(a[0].timestamp) - Number(b[0].timestamp) || a[1] - b[1]);
  return all.map(([e]) => e);
}

/**
 * Timeline markers: errors / network / navigation custom events recorded by the SDK,
 * plus #41 error events linked by replayId (matched to the recording by time).
 */
export function replayMarkers(events: any[], linkedErrors: ReplayErrorRow[] = []): ReplayMarker[] {
  if (!events.length) return [];
  const start = Number(events[0].timestamp);
  const end = Number(events[events.length - 1].timestamp);
  const markers: ReplayMarker[] = [];
  for (const e of events) {
    if (e.type !== 5 || !e.data) continue;
    const p = e.data.payload || {};
    const offsetMs = Math.max(0, Number(e.timestamp) - start);
    if (e.data.tag === 'error') {
      markers.push({ kind: 'error', offsetMs, label: `${p.type || 'Error'}: ${p.message || ''}`.slice(0, 200) });
    } else if (e.data.tag === 'network') {
      const status = p.status == null ? '' : ` → ${p.status}`;
      markers.push({ kind: 'network', offsetMs, label: `${p.method || ''} ${p.url || ''}${status} (${p.durationMs ?? 0} ms)`.slice(0, 300), traceId: p.traceId || null, failed: !!p.failed });
    } else if (e.data.tag === 'navigation') {
      markers.push({ kind: 'navigation', offsetMs, label: String(p.path || '/') });
    }
  }
  for (const err of linkedErrors) {
    const at = Date.parse(err.received_at);
    if (!Number.isFinite(at)) continue;
    markers.push({
      kind: 'error',
      offsetMs: Math.min(Math.max(0, at - start), Math.max(0, end - start)),
      label: `${err.title || err.type || 'Error'} (issue)`.slice(0, 200),
      traceId: err.trace_id,
      issueId: err.issue_id,
    });
  }
  return markers.sort((a, b) => a.offsetMs - b.offsetMs);
}

/** Grafana Explore link for a trace id (same as the errors page). */
export function traceUrl(traceId: string): string {
  return '/grafana/explore?left=' + encodeURIComponent(JSON.stringify({
    datasource: 'Tempo', queries: [{ refId: 'A', queryType: 'traceId', query: traceId }], range: { from: 'now-7d', to: 'now' },
  }));
}

export function formatOffset(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
