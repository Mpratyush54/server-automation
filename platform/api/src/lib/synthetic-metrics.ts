import { getDb } from '../config/database';
import { SyntheticCheck } from '../entities/SyntheticCheck';
import { isLeader } from './leader';

/**
 * Prometheus metrics for synthetic checks (#42), appended to GET /api/metrics/jobs.
 *
 * - platform_synthetic_runs_total{type,result}: per-process counter (sum across pods).
 * - Per-check gauges (up, latency, consecutive failures, last run, TLS expiry) come from
 *   the check rows and are emitted by the LEADER only, so every series exists once
 *   across replicas. Labels: project_id, check_id, type (no names/URLs: no user text).
 */

const runs: Record<string, number> = {};

export function recordRun(type: string, result: string): void {
  const k = `${type}|${result}`;
  runs[k] = (runs[k] || 0) + 1;
}

export function resetSyntheticMetricsForTests(): void {
  for (const k of Object.keys(runs)) delete runs[k];
}

const SAFE = /^[A-Za-z0-9_-]+$/;
const lbl = (v: string) => (SAFE.test(v) ? v : 'invalid');

type GaugeRow = Pick<SyntheticCheck, 'id' | 'projectId' | 'type' | 'enabled' | 'lastStatus' | 'lastLatencyMs' | 'consecutiveFailures' | 'lastRunAt' | 'sslExpiresAt'>;

export function renderSyntheticMetricsText(rows: GaugeRow[], includeGauges: boolean): string {
  const lines = [
    '# HELP platform_synthetic_runs_total Synthetic check runs recorded by this replica, by type and result.',
    '# TYPE platform_synthetic_runs_total counter',
  ];
  for (const [k, n] of Object.entries(runs).sort()) {
    const [type, result] = k.split('|');
    lines.push(`platform_synthetic_runs_total{type="${lbl(type)}",result="${lbl(result)}"} ${n}`);
  }
  if (includeGauges) {
    const series: Record<string, string[]> = { up: [], latency: [], failures: [], last: [], ssl: [] };
    for (const r of rows) {
      if (!r.enabled || r.lastStatus === 'unknown') continue;
      const l = `project_id="${lbl(r.projectId)}",check_id="${lbl(r.id)}",type="${lbl(r.type)}"`;
      series.up.push(`platform_synthetic_check_up{${l}} ${r.lastStatus === 'down' ? 0 : 1}`);
      if (r.lastLatencyMs !== null && r.lastLatencyMs !== undefined) series.latency.push(`platform_synthetic_check_latency_seconds{${l}} ${(r.lastLatencyMs / 1000).toFixed(3)}`);
      series.failures.push(`platform_synthetic_check_consecutive_failures{${l}} ${r.consecutiveFailures || 0}`);
      if (r.lastRunAt) series.last.push(`platform_synthetic_check_last_run_timestamp_seconds{${l}} ${Math.floor(new Date(r.lastRunAt).getTime() / 1000)}`);
      if (r.sslExpiresAt) series.ssl.push(`platform_synthetic_check_ssl_expiry_timestamp_seconds{${l}} ${Math.floor(new Date(r.sslExpiresAt).getTime() / 1000)}`);
    }
    const meta: Array<[keyof typeof series, string, string]> = [
      ['up', 'platform_synthetic_check_up', '1 when the last run passed (or only warned), 0 when it failed.'],
      ['latency', 'platform_synthetic_check_latency_seconds', 'Duration of the last run.'],
      ['failures', 'platform_synthetic_check_consecutive_failures', 'Consecutive failed runs.'],
      ['last', 'platform_synthetic_check_last_run_timestamp_seconds', 'Start time of the last run.'],
      ['ssl', 'platform_synthetic_check_ssl_expiry_timestamp_seconds', 'Expiry (notAfter) of the certificate seen by the last run.'],
    ];
    for (const [key, name, help] of meta) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...series[key]);
    }
  }
  return lines.join('\n') + '\n';
}

export async function renderSyntheticMetrics(): Promise<string> {
  if (!isLeader()) return renderSyntheticMetricsText([], false);
  let rows: GaugeRow[] = [];
  try {
    const ds = await getDb();
    rows = await ds.getRepository(SyntheticCheck).find({
      select: { id: true, projectId: true, type: true, enabled: true, lastStatus: true, lastLatencyMs: true, consecutiveFailures: true, lastRunAt: true, sslExpiresAt: true },
      take: 5000,
    });
  } catch {
    return renderSyntheticMetricsText([], false);
  }
  return renderSyntheticMetricsText(rows, true);
}
