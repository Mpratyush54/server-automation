/**
 * In-process counters for background jobs, rendered in Prometheus text format.
 *
 * Counters are per process: only the replica that ran a job counts it, so a
 * scraper should collect every API pod and `sum` across them.
 */

export type JobResult = 'success' | 'failure' | 'skipped';

const runs = new Map<string, number>(); // `${job}\u0000${result}` -> count
const lastSuccess = new Map<string, number>(); // job -> unix seconds
let leaderGauge = 0;

export function recordJobRun(job: string, result: JobResult, at: Date = new Date()): void {
  const key = `${job}\u0000${result}`;
  runs.set(key, (runs.get(key) || 0) + 1);
  if (result === 'success') lastSuccess.set(job, Math.floor(at.getTime() / 1000));
}

export function setLeaderGauge(isLeader: boolean): void {
  leaderGauge = isLeader ? 1 : 0;
}

/** Run `fn` as job `job`, recording success/failure. Rethrows nothing: returns the error. */
export async function runRecorded(job: string, fn: () => Promise<void | 'skipped'>): Promise<Error | null> {
  try {
    const r = await fn();
    recordJobRun(job, r === 'skipped' ? 'skipped' : 'success');
    return null;
  } catch (err: any) {
    recordJobRun(job, 'failure');
    console.error(`[jobs] ${job} failed: ${err?.message || err}`);
    return err instanceof Error ? err : new Error(String(err));
  }
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function renderJobMetrics(): string {
  const lines: string[] = [
    '# HELP platform_job_runs_total Background job runs by job and result.',
    '# TYPE platform_job_runs_total counter',
  ];
  for (const [key, n] of [...runs.entries()].sort()) {
    const [job, result] = key.split('\u0000');
    lines.push(`platform_job_runs_total{job="${esc(job)}",result="${esc(result)}"} ${n}`);
  }
  lines.push(
    '# HELP platform_job_last_success_timestamp_seconds Unix time of the last successful run per job.',
    '# TYPE platform_job_last_success_timestamp_seconds gauge',
  );
  for (const [job, ts] of [...lastSuccess.entries()].sort()) {
    lines.push(`platform_job_last_success_timestamp_seconds{job="${esc(job)}"} ${ts}`);
  }
  lines.push(
    '# HELP platform_api_leader 1 when this API replica holds the platform-api-leader lease.',
    '# TYPE platform_api_leader gauge',
    `platform_api_leader ${leaderGauge}`,
  );
  return lines.join('\n') + '\n';
}

/** Test hook. */
export function resetJobMetrics(): void {
  runs.clear();
  lastSuccess.clear();
  leaderGauge = 0;
}
