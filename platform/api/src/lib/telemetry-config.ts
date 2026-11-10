/**
 * Telemetry settings from the environment (platform-env Secret in the cluster).
 *
 * | Variable                              | Default            | Meaning |
 * |---------------------------------------|--------------------|---------|
 * | PLATFORM_OBSERVABILITY                | (unset = off)      | `enabled` (also true/1/yes/on/full) when the observability backend (Grafana Alloy collector, issue #37) is installed. Set by platformctl for the full profile. |
 * | TELEMETRY_COLLECTOR_URL               | -                  | Public collector base URL, e.g. `https://otel.example.com`. Optional. |
 * | OTEL_COLLECTOR_HOST                   | `otel.<DOMAIN>`    | Collector host when TELEMETRY_COLLECTOR_URL is unset (https). |
 * | TELEMETRY_SAMPLING_RATIO              | 1.0                | Trace sampling ratio handed to SDKs (0..1). |
 * | TELEMETRY_INGEST_TOKEN_TTL_SECONDS    | 86400 (24 h)       | Lifetime of ingest tokens. |
 * | TELEMETRY_INGEST_SIGNING_KEY          | generated          | HMAC key for ingest tokens. Generated on first boot and stored in platform-credentials. |
 * | TELEMETRY_INGEST_SIGNING_KEY_PREVIOUS | -                  | Previous key, still accepted for verification during a rotation. |
 * | TELEMETRY_INGEST_AUTH_RATE_LIMIT      | 600                | ingest-auth calls per minute per server token. |
 * | TELEMETRY_INGEST_AUTH_WEB_RATE_LIMIT  | 300                | ingest-auth calls per minute per browser token. |
 * | TELEMETRY_QUEUE                       | `redis`            | `off` processes API ingest inline (old behaviour). Memory state mode is always inline. |
 * | TELEMETRY_QUEUE_MAX_BACKLOG           | 50000              | Above this many queued events, ingest answers 429 + Retry-After. |
 * | TELEMETRY_QUEUE_MAXLEN                | 200000             | Hard cap (XADD MAXLEN ~); trimmed events are counted as dropped. |
 * | TELEMETRY_QUEUE_RETRY_AFTER_SECONDS   | 5                  | Retry-After on 429. |
 * | TELEMETRY_QUEUE_MAX_EVENT_BYTES       | 1048576            | Larger request payloads are refused with 413. |
 * | TELEMETRY_QUEUE_MAX_ATTEMPTS          | 5                  | Deliveries before a failing event is dropped (and counted). |
 */

function num(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled', 'full']);

/** True when the observability backend is installed (PLATFORM_OBSERVABILITY). */
export function observabilityInstalled(): boolean {
  return TRUTHY.has(String(process.env.PLATFORM_OBSERVABILITY || '').trim().toLowerCase());
}

/** Public collector base URL (no trailing slash), or null when it cannot be determined. */
export function collectorBaseUrl(): string | null {
  const explicit = String(process.env.TELEMETRY_COLLECTOR_URL || '').trim();
  if (explicit) {
    try {
      const u = new URL(explicit);
      if (u.protocol === 'https:' || u.protocol === 'http:') return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      /* fall through */
    }
    return null;
  }
  const host = String(process.env.OTEL_COLLECTOR_HOST || '').trim()
    || (process.env.DOMAIN ? `otel.${String(process.env.DOMAIN).trim()}` : '');
  if (!host || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  return `https://${host.toLowerCase()}`;
}

export interface TelemetryEndpoints {
  otlpEndpoint: string;
  faroEndpoint: string;
  profilesEndpoint: string;
}

/** Collector endpoints when telemetry is enabled, otherwise null. */
export function telemetryEndpoints(): TelemetryEndpoints | null {
  if (!observabilityInstalled()) return null;
  const base = collectorBaseUrl();
  if (!base) return null;
  return { otlpEndpoint: base, faroEndpoint: `${base}/collect`, profilesEndpoint: `${base}/pyroscope` };
}

export function samplingRatio(): number {
  return Math.min(1, Math.max(0, num('TELEMETRY_SAMPLING_RATIO', 1)));
}

export function ingestTokenTtlSeconds(): number {
  return Math.max(300, Math.floor(num('TELEMETRY_INGEST_TOKEN_TTL_SECONDS', 86_400, 1)));
}

export function ingestAuthRateLimit(kind: 'server' | 'web'): number {
  return kind === 'web'
    ? Math.floor(num('TELEMETRY_INGEST_AUTH_WEB_RATE_LIMIT', 300, 1))
    : Math.floor(num('TELEMETRY_INGEST_AUTH_RATE_LIMIT', 600, 1));
}

export interface QueueSettings {
  enabled: boolean;
  maxBacklog: number;
  maxLen: number;
  retryAfterSeconds: number;
  maxEventBytes: number;
  maxAttempts: number;
  batchSize: number;
  /** Pending entries idle this long are re-claimed (failed or orphaned by a previous leader). */
  reclaimIdleMs: number;
  /** Time budget of one consumer run. */
  drainBudgetMs: number;
}

export function queueSettings(): QueueSettings {
  const maxBacklog = Math.floor(num('TELEMETRY_QUEUE_MAX_BACKLOG', 50_000, 1));
  return {
    enabled: String(process.env.TELEMETRY_QUEUE || 'redis').trim().toLowerCase() !== 'off',
    maxBacklog,
    maxLen: Math.max(maxBacklog, Math.floor(num('TELEMETRY_QUEUE_MAXLEN', 200_000, 1))),
    retryAfterSeconds: Math.max(1, Math.floor(num('TELEMETRY_QUEUE_RETRY_AFTER_SECONDS', 5, 1))),
    maxEventBytes: Math.floor(num('TELEMETRY_QUEUE_MAX_EVENT_BYTES', 1_048_576, 1024)),
    maxAttempts: Math.max(1, Math.floor(num('TELEMETRY_QUEUE_MAX_ATTEMPTS', 5, 1))),
    batchSize: Math.max(1, Math.floor(num('TELEMETRY_QUEUE_BATCH_SIZE', 200, 1))),
    reclaimIdleMs: Math.floor(num('TELEMETRY_QUEUE_RECLAIM_IDLE_MS', 30_000, 0)),
    drainBudgetMs: Math.floor(num('TELEMETRY_QUEUE_DRAIN_BUDGET_MS', 3_000, 10)),
  };
}
