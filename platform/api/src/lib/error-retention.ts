/**
 * Error-tracking retention (#41 / #47): an hourly leader job deletes error_events older
 * than the project's `errors` retention (privacy settings override, default 90 days) in
 * bounded batches, then deletes issues that have no events left and were last seen before
 * the cutoff.
 *
 * Behaviour (keeps the UI consistent):
 *  - Issues with recent events stay; `count`, `first_seen` and `release_counts` remain
 *    lifetime totals, while the event samples shown on the issue are the retained ones.
 *  - An issue whose last event aged out disappears from the list. If the same error comes
 *    back later it opens a new issue ("New issue" alert, not "Regression").
 * The issue delete re-checks `last_seen` on the row it removes, so an event ingested
 * concurrently (which bumps last_seen under the row lock) keeps its issue.
 */
import type { DataSource } from 'typeorm';
import { getDb } from '../config/database';
import { DEFAULT_RETENTION_DAYS } from '../entities/TelemetryPrivacySettings';
import { clampRetentionDays } from './privacy-settings';
import { registerLeaderJob } from './scheduler';

export const ERROR_RETENTION_JOB = 'error-retention';
const DAY_MS = 86_400_000;

export const errorRetentionSettings = (env: NodeJS.ProcessEnv = process.env) => ({
  batchSize: clampInt(env.ERROR_RETENTION_BATCH, 5_000, 100, 50_000),
  /** Per scope and run; the rest is picked up by the next hourly run. */
  maxBatches: clampInt(env.ERROR_RETENTION_MAX_BATCHES, 20, 1, 1_000),
});

function clampInt(raw: unknown, def: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

type Query = Pick<DataSource, 'query'>;

/** Projects whose errors retention differs from the default. */
export async function errorRetentionOverrides(db: Query): Promise<Record<string, number>> {
  const rows: { project_id: string; days: string }[] = await db.query(
    `SELECT project_id, retention_days->>'errors' AS days FROM telemetry_privacy_settings
      WHERE jsonb_typeof(retention_days->'errors') = 'number'`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.project_id)] = clampRetentionDays(r.days, DEFAULT_RETENTION_DAYS.errors);
  return out;
}

/** One scope: a single project (override) or every project without an override. */
interface Scope { sql: string; params: unknown[] }

function scopes(overrides: Record<string, number>, now: Date): { scope: Scope; cutoff: Date }[] {
  const out: { scope: Scope; cutoff: Date }[] = [];
  for (const [projectId, days] of Object.entries(overrides)) {
    out.push({ scope: { sql: 'project_id = $1', params: [projectId] }, cutoff: new Date(now.getTime() - days * DAY_MS) });
  }
  out.push({
    scope: { sql: 'NOT (project_id = ANY($1::uuid[]))', params: [Object.keys(overrides)] },
    cutoff: new Date(now.getTime() - DEFAULT_RETENTION_DAYS.errors * DAY_MS),
  });
  return out;
}

async function countDeleted(db: Query, sql: string, params: unknown[]): Promise<number> {
  // SELECT over a data-modifying CTE: the driver returns rows for SELECT on every version.
  const rows = await db.query(sql, params);
  return Number(rows?.[0]?.n || 0);
}

export async function deleteExpiredEvents(db: Query, scope: Scope, cutoff: Date, batchSize: number, maxBatches: number): Promise<number> {
  const n = scope.params.length;
  const sql = `WITH doomed AS (
      SELECT project_id, id FROM error_events WHERE ${scope.sql} AND received_at < $${n + 1} LIMIT $${n + 2}
    ), gone AS (
      DELETE FROM error_events e USING doomed d WHERE e.project_id = d.project_id AND e.id = d.id RETURNING 1
    ) SELECT count(*)::int AS n FROM gone`;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const deleted = await countDeleted(db, sql, [...scope.params, cutoff, batchSize]);
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

export async function deleteEmptyIssues(db: Query, scope: Scope, cutoff: Date, batchSize: number, maxBatches: number): Promise<number> {
  const n = scope.params.length;
  const empty = (alias: string) => `NOT EXISTS (SELECT 1 FROM error_events e WHERE e.project_id = ${alias}.project_id AND e.issue_id = ${alias}.id)`;
  const sql = `WITH doomed AS (
      SELECT i.id FROM error_issues i WHERE ${scope.sql.replace(/project_id/g, 'i.project_id')} AND i.last_seen < $${n + 1} AND ${empty('i')}
      LIMIT $${n + 2}
    ), gone AS (
      DELETE FROM error_issues x USING doomed d
       WHERE x.id = d.id AND x.last_seen < $${n + 1} AND ${empty('x')}
      RETURNING 1
    ) SELECT count(*)::int AS n FROM gone`;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const deleted = await countDeleted(db, sql, [...scope.params, cutoff, batchSize]);
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

export async function runErrorRetention(
  now: Date = new Date(),
  db?: Query,
  settings = errorRetentionSettings(),
): Promise<{ events: number; issues: number }> {
  const conn = db || (await getDb());
  const overrides = await errorRetentionOverrides(conn);
  let events = 0;
  let issues = 0;
  for (const { scope, cutoff } of scopes(overrides, now)) {
    events += await deleteExpiredEvents(conn, scope, cutoff, settings.batchSize, settings.maxBatches);
    issues += await deleteEmptyIssues(conn, scope, cutoff, settings.batchSize, settings.maxBatches);
  }
  if (events || issues) console.log(`[error-retention] deleted ${events} event(s) and ${issues} empty issue(s)`);
  return { events, issues };
}

export function startErrorRetention(): void {
  registerLeaderJob({
    name: ERROR_RETENTION_JOB,
    intervalMs: 60 * 60_000,
    initialDelayMs: 7 * 60_000,
    run: async () => { await runErrorRetention(); },
  });
}
