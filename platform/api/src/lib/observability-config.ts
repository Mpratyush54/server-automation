/**
 * Settings for the observability query proxies (#48).
 *
 * | Variable                                 | Default                                                        | Meaning |
 * |------------------------------------------|----------------------------------------------------------------|---------|
 * | PLATFORM_OBSERVABILITY                   | (unset = off)                                                  | Backends installed (full profile). Without it every query route answers 503 `observability_disabled`. |
 * | OBSERVABILITY_PROMETHEUS_URL             | PROMETHEUS_URL or http://kube-prometheus-kube-prome-prometheus.monitoring.svc:9090 | Prometheus (Tempo span metrics / service graphs, cAdvisor). |
 * | OBSERVABILITY_LOKI_URL                   | LOKI_URL or http://loki.monitoring.svc:3100                     | Loki. |
 * | OBSERVABILITY_TEMPO_URL                  | TEMPO_URL or http://tempo.monitoring.svc:3200                   | Tempo. |
 * | OBSERVABILITY_PYROSCOPE_URL              | PYROSCOPE_URL or http://pyroscope.monitoring.svc:4040           | Pyroscope. |
 * | OBSERVABILITY_QUERY_TIMEOUT_MS           | 10000 (max 30000)                                              | Upstream request timeout. |
 * | OBSERVABILITY_MAX_RANGE_HOURS            | 168 (7 days)                                                   | Longest time range a query may cover (longer ranges are clamped). |
 * | OBSERVABILITY_MAX_LOG_LINES              | 1000                                                           | Cap on log lines per query. |
 * | OBSERVABILITY_MAX_TRACES                 | 100                                                            | Cap on traces per search. |
 * | OBSERVABILITY_MAX_SERIES                 | 500                                                            | Cap on series returned by metric queries. |
 * | OBSERVABILITY_MAX_POINTS                 | 1100                                                           | Max points per series (the step is raised to fit). |
 * | OBSERVABILITY_MAX_TRACE_SPANS            | 5000                                                           | Cap on spans returned for one trace. |
 * | OBSERVABILITY_MAX_RESPONSE_BYTES         | 16777216                                                       | Upstream responses larger than this are refused. |
 * | OBSERVABILITY_RATE_LIMIT                 | 600                                                            | Proxy requests per minute per user, shared by every observability route (one portal tab load is 1-5 requests). |
 * | OBSERVABILITY_LOKI_SCOPE                 | `stream`                                                       | `stream`: `platform_project_id` is a Loki stream label. `metadata`: it is structured metadata (filter after the selector). |
 * | OBSERVABILITY_FLEET_MAX_PROJECTS         | 200                                                            | Projects shown in the fleet view. |
 */
import type { LokiScopeMode } from './observability-scope';
import { observabilityInstalled } from './telemetry-config';

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function url(name: string, legacy: string | undefined, fallback: string): string {
  const raw = String(process.env[name] || (legacy ? process.env[legacy] : '') || fallback).trim();
  return raw.replace(/\/+$/, '');
}

export type Backend = 'prometheus' | 'loki' | 'tempo' | 'pyroscope';

export function observabilityEnabled(): boolean {
  return observabilityInstalled();
}

export function backendUrl(b: Backend): string {
  switch (b) {
    case 'prometheus': return url('OBSERVABILITY_PROMETHEUS_URL', 'PROMETHEUS_URL', 'http://kube-prometheus-kube-prome-prometheus.monitoring.svc:9090');
    case 'loki': return url('OBSERVABILITY_LOKI_URL', 'LOKI_URL', 'http://loki.monitoring.svc:3100');
    case 'tempo': return url('OBSERVABILITY_TEMPO_URL', 'TEMPO_URL', 'http://tempo.monitoring.svc:3200');
    case 'pyroscope': return url('OBSERVABILITY_PYROSCOPE_URL', 'PYROSCOPE_URL', 'http://pyroscope.monitoring.svc:4040');
  }
}

/**
 * Default per-user requests/minute across all observability routes. Sized for a
 * few people clicking through tabs: the RUM tab alone sends 5 Loki queries, and
 * live log tail polls every 5 s.
 */
export const DEFAULT_OBSERVABILITY_RATE_LIMIT = 600;

export interface ObservabilityLimits {
  timeoutMs: number;
  maxRangeSeconds: number;
  maxLogLines: number;
  maxTraces: number;
  maxSeries: number;
  maxPoints: number;
  maxTraceSpans: number;
  maxResponseBytes: number;
  rateLimitPerMinute: number;
  fleetMaxProjects: number;
}

export function observabilityLimits(): ObservabilityLimits {
  return {
    timeoutMs: num('OBSERVABILITY_QUERY_TIMEOUT_MS', 10_000, 1_000, 30_000),
    maxRangeSeconds: num('OBSERVABILITY_MAX_RANGE_HOURS', 168, 1, 24 * 90) * 3600,
    maxLogLines: num('OBSERVABILITY_MAX_LOG_LINES', 1000, 10, 5000),
    maxTraces: num('OBSERVABILITY_MAX_TRACES', 100, 5, 500),
    maxSeries: num('OBSERVABILITY_MAX_SERIES', 500, 10, 5000),
    maxPoints: num('OBSERVABILITY_MAX_POINTS', 1100, 50, 11_000),
    maxTraceSpans: num('OBSERVABILITY_MAX_TRACE_SPANS', 5000, 100, 50_000),
    maxResponseBytes: num('OBSERVABILITY_MAX_RESPONSE_BYTES', 16 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024),
    rateLimitPerMinute: num('OBSERVABILITY_RATE_LIMIT', DEFAULT_OBSERVABILITY_RATE_LIMIT, 10, 10_000),
    fleetMaxProjects: num('OBSERVABILITY_FLEET_MAX_PROJECTS', 200, 1, 2000),
  };
}

export function lokiScopeMode(): LokiScopeMode {
  return String(process.env.OBSERVABILITY_LOKI_SCOPE || '').trim().toLowerCase() === 'metadata' ? 'metadata' : 'stream';
}
