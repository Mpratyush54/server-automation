import { getDb } from '../config/database';
import { SyntheticCheck } from '../entities/SyntheticCheck';

/**
 * Public-safe status feed per project (#42, consumed by status pages #46).
 *
 * Aggregates only: component name (statusPage.name or the check name), type, current
 * status, uptime percentages and per-day bars. Never includes URLs, hosts, errors,
 * assertion details, headers, latency of individual runs or secret names.
 */

export type ComponentStatus = 'operational' | 'degraded' | 'outage' | 'unknown';
export type OverallStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'unknown';

export interface StatusFeedDay {
  date: string;
  uptime: number | null;
  status: ComponentStatus;
}

export interface StatusFeedComponent {
  id: string;
  name: string;
  type: string;
  status: ComponentStatus;
  lastCheckedAt: string | null;
  uptime: { '24h': number | null; '7d': number | null; '30d': number | null };
  avgLatencyMs24h: number | null;
  days: StatusFeedDay[];
}

export interface StatusFeed {
  projectId: string;
  generatedAt: string;
  status: OverallStatus;
  components: StatusFeedComponent[];
}

export interface AggregateRow {
  checkId: string;
  /** YYYY-MM-DD (UTC), or null for the 24h window row. */
  day: string | null;
  total: number;
  failed: number;
  avgLatencyMs: number | null;
}

export const STATUS_FEED_DAYS = 30;

function pct(total: number, failed: number): number | null {
  if (!total) return null;
  return Math.round(((total - failed) / total) * 100_000) / 1000;
}

function dayStatus(uptime: number | null): ComponentStatus {
  if (uptime === null) return 'unknown';
  if (uptime >= 99.9) return 'operational';
  if (uptime >= 95) return 'degraded';
  return 'outage';
}

function currentStatus(c: Pick<SyntheticCheck, 'lastStatus' | 'enabled'>): ComponentStatus {
  if (!c.enabled) return 'unknown';
  if (c.lastStatus === 'up') return 'operational';
  if (c.lastStatus === 'degraded') return 'degraded';
  if (c.lastStatus === 'down') return 'outage';
  return 'unknown';
}

export function overallStatus(components: Array<{ status: ComponentStatus }>): OverallStatus {
  const known = components.filter((c) => c.status !== 'unknown');
  if (known.length === 0) return 'unknown';
  const out = known.filter((c) => c.status === 'outage').length;
  if (out === known.length) return 'major_outage';
  if (out > 0) return 'partial_outage';
  if (known.some((c) => c.status === 'degraded')) return 'degraded';
  return 'operational';
}

/** Pure builder (unit-tested): checks + aggregate rows → feed. */
export function buildStatusFeed(
  projectId: string,
  checks: Array<Pick<SyntheticCheck, 'id' | 'name' | 'type' | 'enabled' | 'lastStatus' | 'lastRunAt' | 'config'>>,
  daily: AggregateRow[],
  last24h: AggregateRow[],
  now = new Date(),
  days = STATUS_FEED_DAYS,
): StatusFeed {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) dates.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  const cutoff7 = dates[Math.max(0, dates.length - 7)];
  const components: StatusFeedComponent[] = checks
    .filter((c) => c.config?.statusPage?.visible !== false)
    .map((c) => {
      const rows = daily.filter((r) => r.checkId === c.id && r.day !== null && r.day >= dates[0]);
      const byDay: Record<string, AggregateRow> = {};
      for (const r of rows) if (r.day) byDay[r.day] = r;
      const sum = (rs: AggregateRow[]) => rs.reduce((a, r) => ({ total: a.total + r.total, failed: a.failed + r.failed }), { total: 0, failed: 0 });
      const all = sum(rows);
      const week = sum(rows.filter((r) => r.day !== null && r.day >= cutoff7));
      const h24 = last24h.find((r) => r.checkId === c.id);
      return {
        id: c.id,
        name: String(c.config?.statusPage?.name || c.name),
        type: c.type,
        status: currentStatus(c),
        lastCheckedAt: c.lastRunAt ? new Date(c.lastRunAt).toISOString() : null,
        uptime: { '24h': h24 ? pct(h24.total, h24.failed) : null, '7d': pct(week.total, week.failed), '30d': pct(all.total, all.failed) },
        avgLatencyMs24h: h24?.avgLatencyMs !== null && h24?.avgLatencyMs !== undefined ? Math.round(h24.avgLatencyMs) : null,
        days: dates.map((d) => {
          const r = byDay[d];
          const u = r ? pct(r.total, r.failed) : null;
          return { date: d, uptime: u, status: dayStatus(u) };
        }),
      };
    });
  return { projectId, generatedAt: now.toISOString(), status: overallStatus(components), components };
}

export async function getProjectStatusFeed(projectId: string, now = new Date()): Promise<StatusFeed> {
  const ds = await getDb();
  const checks = await ds.getRepository(SyntheticCheck).find({ where: { projectId }, order: { name: 'ASC' } });
  if (checks.length === 0) return buildStatusFeed(projectId, [], [], [], now);
  const since = new Date(now.getTime() - (STATUS_FEED_DAYS - 1) * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  const map = (rows: any[]): AggregateRow[] => rows.map((r) => ({
    checkId: r.check_id,
    day: r.day ?? null,
    total: Number(r.total) || 0,
    failed: Number(r.failed) || 0,
    avgLatencyMs: r.avg_latency === null || r.avg_latency === undefined ? null : Number(r.avg_latency),
  }));
  const daily = await ds.query(
    `SELECT check_id, to_char(started_at, 'YYYY-MM-DD') AS day, count(*) AS total,
            count(*) FILTER (WHERE status = 'fail') AS failed, avg(latency_ms) AS avg_latency
       FROM synthetic_results WHERE project_id = $1 AND started_at >= $2 GROUP BY 1, 2`,
    [projectId, since],
  );
  const h24 = await ds.query(
    `SELECT check_id, count(*) AS total, count(*) FILTER (WHERE status = 'fail') AS failed, avg(latency_ms) AS avg_latency
       FROM synthetic_results WHERE project_id = $1 AND started_at >= $2 GROUP BY 1`,
    [projectId, new Date(now.getTime() - 86_400_000)],
  );
  return buildStatusFeed(projectId, checks, map(daily), map(h24), now);
}
