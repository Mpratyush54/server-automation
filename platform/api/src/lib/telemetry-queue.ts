import type Redis from 'ioredis';
import { redisKey, stateBackend, withRedis } from './redis';
import { queueSettings, QueueSettings } from './telemetry-config';
import { processTelemetryEvent, processLogs, processApiMetrics, TelemetryKind } from './telemetry-processors';
import { workerIdentity } from './background-jobs';
import { registerLeaderJob } from './scheduler';

/**
 * Redis Streams queue for SDK telemetry that still arrives at the API (issue #49).
 *
 * Producer (every replica, request path): validate + authorize, then XADD to
 * `plat:api:telemetry:ingest` (MAXLEN ~ cap) and answer 202. When the backlog
 * (XLEN; processed entries are XDEL'd, so XLEN is the backlog) exceeds
 * TELEMETRY_QUEUE_MAX_BACKLOG the producer answers 429 with Retry-After instead.
 *
 * Consumer (leader only, `telemetry-consumer` leader job): consumer group
 * `telemetry-forwarders`; reads batches, forwards to the existing destinations
 * (MongoDB collections, Loki) through lib/telemetry-processors, then XACK + XDEL.
 * Failed entries stay pending and are re-claimed (XAUTOCLAIM) after
 * TELEMETRY_QUEUE_RECLAIM_IDLE_MS — also how a new leader picks up a dead leader's
 * in-flight entries. After TELEMETRY_QUEUE_MAX_ATTEMPTS deliveries an entry is dropped
 * and counted. Delivery is at-least-once.
 *
 * No Redis (PLATFORM_STATE_STORE=memory / tests) or TELEMETRY_QUEUE=off: events are
 * processed inline like before. A Redis error on enqueue also falls back to inline
 * processing (counted), so telemetry is not lost during a Redis outage.
 *
 * All state is in Redis; the counters below are per-process Prometheus counters
 * (scrape every pod and sum, like lib/job-metrics.ts).
 */

export const TELEMETRY_STREAM = redisKey('telemetry:ingest');
export const TELEMETRY_GROUP = 'telemetry-forwarders';
export const TELEMETRY_CONSUMER_JOB = 'telemetry-consumer';

export class TelemetryBackpressureError extends Error {
  readonly status = 429;
  constructor(readonly retryAfterSeconds: number, readonly backlog: number) {
    super('Telemetry queue is full; retry later');
    this.name = 'TelemetryBackpressureError';
  }
}

export class TelemetryPayloadTooLargeError extends Error {
  readonly status = 413;
  constructor(readonly bytes: number, readonly limit: number) {
    super(`Telemetry payload too large (${bytes} bytes, limit ${limit})`);
    this.name = 'TelemetryPayloadTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// Metrics (per process)
// ---------------------------------------------------------------------------

const counters = {
  enqueued: 0,
  inline: 0,
  rejected: 0,
  processed: 0,
  failedAttempts: 0,
};
/** Dropped events by reason (plain object: a handful of fixed reasons). */
const dropped: Record<string, number> = {};

function countDrop(reason: string, n = 1): void {
  if (n > 0) dropped[reason] = (dropped[reason] || 0) + n;
}

export function telemetryCounters() {
  return { ...counters, dropped: { ...dropped } };
}

export function resetTelemetryCountersForTests(): void {
  for (const k of Object.keys(counters) as (keyof typeof counters)[]) counters[k] = 0;
  for (const k of Object.keys(dropped)) delete dropped[k];
}

export interface QueueStats {
  depth: number;
  pending: number;
  lagSeconds: number;
}

/** Backlog stats from Redis (null in memory mode or when Redis is unreachable). */
export async function telemetryQueueStats(now: number = Date.now()): Promise<QueueStats | null> {
  if (!queueActive()) return null;
  try {
    return await withRedis(async (r) => {
      const depth = Number(await r.xlen(TELEMETRY_STREAM)) || 0;
      let pending = 0;
      try {
        const summary: any = await r.xpending(TELEMETRY_STREAM, TELEMETRY_GROUP);
        pending = Number(Array.isArray(summary) ? summary[0] : 0) || 0;
      } catch {
        /* group not created yet */
      }
      let lagSeconds = 0;
      const oldest: any = await r.xrange(TELEMETRY_STREAM, '-', '+', 'COUNT', 1);
      if (Array.isArray(oldest) && oldest.length > 0) {
        const ms = Number(String(oldest[0][0]).split('-')[0]);
        if (Number.isFinite(ms)) lagSeconds = Math.max(0, (now - ms) / 1000);
      }
      return { depth, pending, lagSeconds };
    });
  } catch {
    return null;
  }
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Prometheus text for the telemetry pipeline (appended to GET /api/metrics/jobs). */
export async function renderTelemetryMetrics(): Promise<string> {
  const stats = await telemetryQueueStats();
  const lines = [
    '# HELP platform_telemetry_events_enqueued_total SDK telemetry requests queued to the Redis stream by this replica.',
    '# TYPE platform_telemetry_events_enqueued_total counter',
    `platform_telemetry_events_enqueued_total ${counters.enqueued}`,
    '# HELP platform_telemetry_events_inline_total SDK telemetry requests processed inline (no queue, or Redis unavailable).',
    '# TYPE platform_telemetry_events_inline_total counter',
    `platform_telemetry_events_inline_total ${counters.inline}`,
    '# HELP platform_telemetry_events_rejected_total SDK telemetry requests refused with 429 (backpressure).',
    '# TYPE platform_telemetry_events_rejected_total counter',
    `platform_telemetry_events_rejected_total ${counters.rejected}`,
    '# HELP platform_telemetry_events_processed_total Queued telemetry events forwarded by this replica\'s consumer.',
    '# TYPE platform_telemetry_events_processed_total counter',
    `platform_telemetry_events_processed_total ${counters.processed}`,
    '# HELP platform_telemetry_event_failures_total Failed forwarding attempts (event stays queued and is retried).',
    '# TYPE platform_telemetry_event_failures_total counter',
    `platform_telemetry_event_failures_total ${counters.failedAttempts}`,
    '# HELP platform_telemetry_events_dropped_total Telemetry events dropped, by reason.',
    '# TYPE platform_telemetry_events_dropped_total counter',
  ];
  for (const [reason, n] of Object.entries(dropped).sort()) {
    lines.push(`platform_telemetry_events_dropped_total{reason="${esc(reason)}"} ${n}`);
  }
  if (stats) {
    lines.push(
      '# HELP platform_telemetry_queue_depth Events in the telemetry stream not yet forwarded.',
      '# TYPE platform_telemetry_queue_depth gauge',
      `platform_telemetry_queue_depth ${stats.depth}`,
      '# HELP platform_telemetry_queue_pending Events delivered to the consumer but not yet acknowledged.',
      '# TYPE platform_telemetry_queue_pending gauge',
      `platform_telemetry_queue_pending ${stats.pending}`,
      '# HELP platform_telemetry_queue_lag_seconds Age of the oldest event not yet forwarded.',
      '# TYPE platform_telemetry_queue_lag_seconds gauge',
      `platform_telemetry_queue_lag_seconds ${stats.lagSeconds.toFixed(3)}`,
    );
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

/** True when ingest goes through the Redis stream (Redis state backend and queue not off). */
export function queueActive(settings: QueueSettings = queueSettings()): boolean {
  return settings.enabled && stateBackend() === 'redis';
}

let lastFallbackWarn = 0;

/**
 * Accept one already-validated, project-bound telemetry payload.
 * Returns 'queued' (answer 202) or 'processed' (handled inline; answer as before).
 * Throws TelemetryBackpressureError (429) or TelemetryPayloadTooLargeError (413).
 */
export async function ingestTelemetry(kind: TelemetryKind, projectId: string, payload: unknown, count = 1): Promise<'queued' | 'processed'> {
  const settings = queueSettings();
  if (!queueActive(settings)) {
    await processTelemetryEvent(kind, payload);
    counters.inline += 1;
    return 'processed';
  }
  const data = JSON.stringify(payload);
  const bytes = Buffer.byteLength(data);
  if (bytes > settings.maxEventBytes) {
    countDrop('too_large', count);
    throw new TelemetryPayloadTooLargeError(bytes, settings.maxEventBytes);
  }
  let backlog = -1;
  try {
    backlog = await withRedis(async (r) => {
      const len = Number(await r.xlen(TELEMETRY_STREAM)) || 0;
      if (len >= settings.maxBacklog) return len;
      await r.xadd(TELEMETRY_STREAM, 'MAXLEN', '~', String(settings.maxLen), '*', 'k', kind, 'p', projectId, 'n', String(count), 'd', data);
      return -1;
    });
  } catch (err: any) {
    if (Date.now() - lastFallbackWarn > 30_000) {
      lastFallbackWarn = Date.now();
      console.warn(`[telemetry] queue unavailable (${err?.message || err}); processing inline`);
    }
    await processTelemetryEvent(kind, payload);
    counters.inline += 1;
    return 'processed';
  }
  if (backlog >= 0) {
    counters.rejected += 1;
    throw new TelemetryBackpressureError(settings.retryAfterSeconds, backlog);
  }
  counters.enqueued += 1;
  return 'queued';
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

interface Entry {
  id: string;
  kind: TelemetryKind | string;
  projectId: string;
  count: number;
  payload: any;
  parseError?: boolean;
}

function parseEntry(id: string, fields: string[]): Entry {
  const f: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) f[fields[i]] = fields[i + 1];
  const count = Math.max(1, Number(f.n) || 1);
  try {
    return { id, kind: f.k, projectId: f.p, count, payload: JSON.parse(f.d) };
  } catch {
    return { id, kind: f.k, projectId: f.p, count, payload: null, parseError: true };
  }
}

async function ensureGroup(r: Redis): Promise<void> {
  try {
    // '0' (not '$'): entries queued before the group existed are forwarded too.
    await r.xgroup('CREATE', TELEMETRY_STREAM, TELEMETRY_GROUP, '0', 'MKSTREAM');
  } catch (err: any) {
    if (!/BUSYGROUP/.test(String(err?.message || err))) throw err;
  }
}

async function finish(r: Redis, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await r.xack(TELEMETRY_STREAM, TELEMETRY_GROUP, ...ids);
  await r.xdel(TELEMETRY_STREAM, ...ids);
}

const KNOWN_KINDS = new Set(['logs', 'api-metrics', 'heartbeat', 'errors']);

/** Forward a batch; returns the ids that are done (forwarded or dropped). */
async function forward(entries: Entry[]): Promise<string[]> {
  const done: string[] = [];
  const logs: Entry[] = [];
  const metrics: Entry[] = [];
  const singles: Entry[] = [];
  for (const e of entries) {
    if (e.parseError || !KNOWN_KINDS.has(String(e.kind))) {
      countDrop('malformed', e.count);
      done.push(e.id);
    } else if (e.kind === 'logs') logs.push(e);
    else if (e.kind === 'api-metrics') metrics.push(e);
    else singles.push(e);
  }

  // Batch per destination (one insertMany for many requests); on failure retry each
  // event alone so one bad event cannot hold back the others.
  const grouped: [Entry[], (docs: any[]) => Promise<void>][] = [[logs, processLogs], [metrics, processApiMetrics]];
  for (const [group, run] of grouped) {
    if (group.length === 0) continue;
    try {
      await run(group.flatMap((e) => (Array.isArray(e.payload) ? e.payload : [])));
      for (const e of group) {
        done.push(e.id);
        counters.processed += e.count;
      }
    } catch {
      singles.push(...group);
    }
  }
  for (const e of singles) {
    try {
      await processTelemetryEvent(e.kind as TelemetryKind, e.payload);
      done.push(e.id);
      counters.processed += e.count;
    } catch (err: any) {
      counters.failedAttempts += 1;
      console.warn(`[telemetry] forwarding ${e.kind} event ${e.id} failed (will retry): ${err?.message || err}`);
    }
  }
  return done;
}

export interface DrainResult {
  processed: number;
  failed: number;
  dropped: number;
  reclaimed: number;
}

/**
 * One consumer run: re-claim stale pending entries, then read and forward new ones until
 * the stream is empty or the time budget is spent. Runs on the leader only.
 */
export async function drainTelemetryQueue(
  consumer: string = workerIdentity(),
  settings: QueueSettings = queueSettings(),
  now: () => number = Date.now,
): Promise<DrainResult> {
  const result: DrainResult = { processed: 0, failed: 0, dropped: 0, reclaimed: 0 };
  const started = now();
  const timeout = settings.drainBudgetMs + 5_000;

  await withRedis((r) => ensureGroup(r), timeout);

  const handle = async (raw: [string, string[]][], reclaimed: boolean) => {
    if (raw.length === 0) return;
    let entries = raw.map(([id, fields]) => parseEntry(id, fields));
    const exhausted: string[] = [];
    if (reclaimed) {
      result.reclaimed += entries.length;
      // Delivery counts: drop entries that already failed too often.
      const pend: any[] = await withRedis((r) => r.xpending(
        TELEMETRY_STREAM, TELEMETRY_GROUP, entries[0].id, entries[entries.length - 1].id, entries.length,
      ) as Promise<any[]>, timeout);
      const deliveries: Record<string, number> = {};
      for (const p of pend || []) deliveries[String(p[0])] = Number(p[3]) || 0;
      entries = entries.filter((e) => {
        if ((deliveries[e.id] || 0) > settings.maxAttempts) {
          countDrop('max_attempts', e.count);
          result.dropped += e.count;
          exhausted.push(e.id);
          return false;
        }
        return true;
      });
    }
    const before = counters.processed;
    const done = await forward(entries);
    result.processed += counters.processed - before;
    result.failed += entries.length - done.length;
    await withRedis((r) => finish(r, [...exhausted, ...done]), timeout);
  };

  // 1. Re-claim entries pending longer than the idle threshold (failures, dead leader).
  let cursor = '0-0';
  do {
    const claimed: any = await withRedis((r) => r.xautoclaim(
      TELEMETRY_STREAM, TELEMETRY_GROUP, consumer, settings.reclaimIdleMs, cursor, 'COUNT', settings.batchSize,
    ), timeout);
    cursor = String(claimed?.[0] ?? '0-0');
    // Redis 7 also returns ids that were trimmed (MAXLEN) while pending: count them as dropped.
    const deletedIds: string[] = Array.isArray(claimed?.[2]) ? claimed[2].map(String) : [];
    if (deletedIds.length > 0) {
      countDrop('trimmed', deletedIds.length);
      result.dropped += deletedIds.length;
      await withRedis((r) => r.xack(TELEMETRY_STREAM, TELEMETRY_GROUP, ...deletedIds), timeout);
    }
    const live = (claimed?.[1] || []).filter((e: any) => Array.isArray(e) && Array.isArray(e[1]));
    await handle(live, true);
  } while (cursor !== '0-0' && now() - started < settings.drainBudgetMs);

  // 2. New entries.
  while (now() - started < settings.drainBudgetMs) {
    const read: any = await withRedis((r) => r.xreadgroup(
      'GROUP', TELEMETRY_GROUP, consumer, 'COUNT', settings.batchSize, 'STREAMS', TELEMETRY_STREAM, '>',
    ) as Promise<any>, timeout);
    const entries: [string, string[]][] = read?.[0]?.[1] || [];
    if (entries.length === 0) break;
    await handle(entries, false);
    if (entries.length < settings.batchSize) break;
  }
  return result;
}

let lastConsumerWarn = 0;

/** Register the leader-only consumer (1 s cadence; runs never overlap). */
export function startTelemetryConsumer(): boolean {
  return registerLeaderJob({
    name: TELEMETRY_CONSUMER_JOB,
    intervalMs: 1_000,
    initialDelayMs: 1_000,
    run: async () => {
      if (!queueActive()) return 'skipped';
      try {
        await drainTelemetryQueue();
      } catch (err: any) {
        // Redis outage: log at most every 30 s instead of every second.
        if (Date.now() - lastConsumerWarn > 30_000) {
          lastConsumerWarn = Date.now();
          console.warn(`[telemetry] consumer run failed: ${err?.message || err}`);
        }
        return 'skipped';
      }
    },
  });
}
