// Shared alert-event contract (Phase 4 wave B). Producers publish; the alerting
// consumer (#43) evaluates rules, silences and routes to channels.
import { redisKey, stateBackend, withRedis } from './redis';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertSource = 'error-tracking' | 'synthetics' | 'deploy' | 'database' | 'slo' | 'monitor' | 'status-page';

export interface AlertEvent {
  projectId: string;
  environment?: string;
  source: AlertSource;
  severity: AlertSeverity;
  /** Stable key for deduplication / resolution, e.g. `error:<fingerprint>` or `synthetic:<checkId>`. */
  dedupeKey: string;
  title: string;
  body?: string;
  /** Portal deep link (path only, e.g. `/projects/<id>?tab=errors`). */
  url?: string;
  /** `firing` (default) or `resolved` for the same dedupeKey. */
  status?: 'firing' | 'resolved';
  labels?: Record<string, string>;
  at?: string;
}

export const ALERT_EVENTS_STREAM = redisKey('alerts:events');

/** Fire-and-forget; never throws. Without Redis (tests / memory mode) it is a no-op unless a test hook is set. */
export async function publishAlertEvent(event: AlertEvent): Promise<void> {
  const e = { status: 'firing', at: new Date().toISOString(), ...event };
  try {
    if (alertEventTestHook) { alertEventTestHook(e as AlertEvent); return; }
    if (stateBackend() !== 'redis') return;
    await withRedis((r) => r.xadd(ALERT_EVENTS_STREAM, 'MAXLEN', '~', '100000', '*', 'event', JSON.stringify(e)));
  } catch { /* alerting must never break the producer */ }
}

let alertEventTestHook: ((e: AlertEvent) => void) | null = null;
/** Tests only: capture published events instead of writing to Redis. */
export function setAlertEventTestHook(hook: ((e: AlertEvent) => void) | null): void { alertEventTestHook = hook; }
