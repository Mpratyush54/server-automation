import type Redis from 'ioredis';
import { withRedis } from './redis';
import { ALERT_EVENTS_STREAM, AlertEvent } from './alert-events';
import { InvalidAlertEventError, processAlertEvent } from './alerting-engine';
import { alertingSettings } from './alerting-config';
import { workerIdentity } from './background-jobs';

/**
 * Leader-run consumer of ALERT_EVENTS_STREAM (#43), modelled on the telemetry queue (#49):
 * consumer group `alerting`; each entry (field `event` = JSON AlertEvent) is applied with
 * processAlertEvent, then XACK + XDEL. A failure (e.g. Postgres down) leaves the entry
 * pending; it is re-claimed with XAUTOCLAIM after the idle threshold (also how a new leader
 * picks up a dead leader's entries) and dropped after ALERTING_CONSUMER_MAX_ATTEMPTS
 * deliveries. Malformed / invalid events are dropped at once. Delivery is at-least-once;
 * processAlertEvent is idempotent per dedupeKey state, so a replay does not re-notify.
 */
export const ALERT_EVENTS_GROUP = 'alerting';
export const ALERT_CONSUMER_JOB = 'alerting-consumer';

export interface AlertDrainResult {
  processed: number;
  failed: number;
  dropped: number;
  reclaimed: number;
}

const counters = { processed: 0, failed: 0, dropped: 0 };
export function alertConsumerCounters() {
  return { ...counters };
}

function parse(fields: string[]): AlertEvent | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === 'event') {
      try { return JSON.parse(fields[i + 1]); } catch { return null; }
    }
  }
  return null;
}

async function ensureGroup(r: Redis): Promise<void> {
  try {
    await r.xgroup('CREATE', ALERT_EVENTS_STREAM, ALERT_EVENTS_GROUP, '0', 'MKSTREAM');
  } catch (err: any) {
    if (!/BUSYGROUP/.test(String(err?.message || err))) throw err;
  }
}

export async function drainAlertEvents(
  consumer: string = workerIdentity(),
  settings = alertingSettings(),
  now: () => number = Date.now,
  apply: (e: AlertEvent) => Promise<unknown> = (e) => processAlertEvent(e),
): Promise<AlertDrainResult> {
  const result: AlertDrainResult = { processed: 0, failed: 0, dropped: 0, reclaimed: 0 };
  const started = now();
  const timeout = settings.consumerBudgetMs + 5_000;
  await withRedis((r) => ensureGroup(r), timeout);

  const finish = (ids: string[]) => ids.length
    ? withRedis(async (r) => { await r.xack(ALERT_EVENTS_STREAM, ALERT_EVENTS_GROUP, ...ids); await r.xdel(ALERT_EVENTS_STREAM, ...ids); }, timeout)
    : Promise.resolve();

  const handle = async (raw: [string, string[]][], reclaimed: boolean) => {
    if (!raw.length) return;
    let entries = raw;
    const done: string[] = [];
    if (reclaimed) {
      result.reclaimed += raw.length;
      const pend: any[] = await withRedis((r) => r.xpending(
        ALERT_EVENTS_STREAM, ALERT_EVENTS_GROUP, raw[0][0], raw[raw.length - 1][0], raw.length,
      ) as Promise<any[]>, timeout);
      const deliveries: Record<string, number> = {};
      for (const p of pend || []) deliveries[String(p[0])] = Number(p[3]) || 0;
      entries = raw.filter(([id]) => {
        if ((deliveries[id] || 0) > settings.consumerMaxAttempts) {
          result.dropped++;
          counters.dropped++;
          done.push(id);
          console.warn(`[alerting] dropping alert event ${id} after ${deliveries[id]} attempts`);
          return false;
        }
        return true;
      });
    }
    // Sequential: events of one dedupeKey must apply in order.
    for (const [id, fields] of entries) {
      const e = parse(fields);
      if (!e) {
        result.dropped++;
        counters.dropped++;
        done.push(id);
        continue;
      }
      try {
        await apply(e);
        result.processed++;
        counters.processed++;
        done.push(id);
      } catch (err: any) {
        if (err instanceof InvalidAlertEventError) {
          result.dropped++;
          counters.dropped++;
          done.push(id);
          continue;
        }
        result.failed++;
        counters.failed++;
        console.warn(`[alerting] event ${id} failed (will retry): ${err?.message || err}`);
      }
    }
    await finish(done);
  };

  let cursor = '0-0';
  do {
    const claimed: any = await withRedis((r) => r.xautoclaim(
      ALERT_EVENTS_STREAM, ALERT_EVENTS_GROUP, consumer, settings.consumerReclaimIdleMs, cursor, 'COUNT', settings.consumerBatch,
    ), timeout);
    cursor = String(claimed?.[0] ?? '0-0');
    const deletedIds: string[] = Array.isArray(claimed?.[2]) ? claimed[2].map(String) : [];
    if (deletedIds.length) {
      result.dropped += deletedIds.length;
      await withRedis((r) => r.xack(ALERT_EVENTS_STREAM, ALERT_EVENTS_GROUP, ...deletedIds), timeout);
    }
    const live = (claimed?.[1] || []).filter((e: any) => Array.isArray(e) && Array.isArray(e[1]));
    await handle(live, true);
  } while (cursor !== '0-0' && now() - started < settings.consumerBudgetMs);

  while (now() - started < settings.consumerBudgetMs) {
    const read: any = await withRedis((r) => r.xreadgroup(
      'GROUP', ALERT_EVENTS_GROUP, consumer, 'COUNT', settings.consumerBatch, 'STREAMS', ALERT_EVENTS_STREAM, '>',
    ) as Promise<any>, timeout);
    const entries: [string, string[]][] = read?.[0]?.[1] || [];
    if (!entries.length) break;
    await handle(entries, false);
    if (entries.length < settings.consumerBatch) break;
  }
  return result;
}
