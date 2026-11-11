/**
 * Retention of alerting history (#43), hourly leader job `alerting-retention`:
 *  - alert_deliveries that are done (sent / failed / skipped) and older than
 *    ALERTING_DELIVERY_RETENTION_DAYS (default 30). Pending rows are never pruned.
 *  - resolved alert_incidents whose resolved time is older than
 *    ALERTING_INCIDENT_RETENTION_DAYS (default 180), with their remaining deliveries.
 * Open and acknowledged incidents are kept however old. audit_logs are not touched
 * (compliance record; see docs/operations/alerting.md).
 */
import type { DataSource } from 'typeorm';
import { getDb } from '../config/database';
import { alertingSettings } from './alerting-config';

export const ALERTING_RETENTION_JOB = 'alerting-retention';
const DAY_MS = 86_400_000;
const BATCH = 2_000;
const MAX_BATCHES = 50;

type Query = Pick<DataSource, 'query'>;

async function loop(db: Query, sql: string, params: unknown[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await db.query(sql, [...params, BATCH]);
    const n = Number(rows?.[0]?.n || 0);
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

export async function pruneAlertHistory(
  now: Date = new Date(),
  db?: Query,
  settings: { deliveryRetentionDays: number; incidentRetentionDays: number } = alertingSettings(),
): Promise<{ deliveries: number; incidents: number }> {
  const conn = db || (await getDb());
  const deliveryCutoff = new Date(now.getTime() - settings.deliveryRetentionDays * DAY_MS);
  const incidentCutoff = new Date(now.getTime() - settings.incidentRetentionDays * DAY_MS);

  const deliveries = await loop(conn, `WITH doomed AS (
      SELECT id FROM alert_deliveries WHERE status <> 'pending' AND created_at < $1 LIMIT $2
    ), gone AS (
      DELETE FROM alert_deliveries a USING doomed d WHERE a.id = d.id RETURNING 1
    ) SELECT count(*)::int AS n FROM gone`, [deliveryCutoff]);

  // Deliveries of the incident first (no FK), then the incident; status re-checked on delete.
  const incidents = await loop(conn, `WITH doomed AS (
      SELECT id FROM alert_incidents WHERE status = 'resolved' AND resolved_at < $1 LIMIT $2
    ), dropped_deliveries AS (
      DELETE FROM alert_deliveries a USING doomed d WHERE a.incident_id = d.id RETURNING 1
    ), gone AS (
      DELETE FROM alert_incidents i USING doomed d
       WHERE i.id = d.id AND i.status = 'resolved' AND i.resolved_at < $1
      RETURNING 1
    ) SELECT count(*)::int AS n FROM gone`, [incidentCutoff]);

  if (deliveries || incidents) console.log(`[alerting] retention: pruned ${deliveries} delivery row(s), ${incidents} resolved incident(s)`);
  return { deliveries, incidents };
}
