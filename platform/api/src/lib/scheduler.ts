import { getLeadership, Leadership } from './leader';
import { runRecorded } from './job-metrics';

/**
 * Leader-gated periodic jobs.
 *
 * A registered job's timer exists only while this replica is the leader: it
 * starts on leadership gain and is cleared on loss, so across N replicas each
 * interval runs once. Runs of the same job never overlap. A job can also be
 * moved to a Kubernetes CronJob (`node dist/jobs/<name>.js`): list it in
 * JOBS_EXTERNAL (comma separated) and the in-process timer is not started.
 */

export interface LeaderJob {
  name: string;
  intervalMs: number;
  /** Delay before the first run after gaining leadership (default: 30 s). */
  initialDelayMs?: number;
  run: () => Promise<void | 'skipped'>;
}

interface Registered {
  job: LeaderJob;
  interval: ReturnType<typeof setInterval> | null;
  initial: ReturnType<typeof setTimeout> | null;
  running: boolean;
  unsubscribe: () => void;
}

const registered = new Map<string, Registered>();

export function externallyScheduledJobs(): Set<string> {
  return new Set(
    String(process.env.JOBS_EXTERNAL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function fire(r: Registered, leadership: Leadership): Promise<void> {
  if (r.running || !leadership.isLeader()) return;
  r.running = true;
  try {
    await runRecorded(r.job.name, r.job.run);
  } finally {
    r.running = false;
  }
}

function startTimers(r: Registered, leadership: Leadership): void {
  if (r.interval || r.initial) return;
  // First run after the initial delay, then every interval from there.
  r.initial = setTimeout(() => {
    r.initial = null;
    r.interval = setInterval(() => void fire(r, leadership), r.job.intervalMs);
    r.interval.unref?.();
    void fire(r, leadership);
  }, r.job.initialDelayMs ?? 30_000);
  r.initial.unref?.();
}

function stopTimers(r: Registered): void {
  if (r.interval) clearInterval(r.interval);
  if (r.initial) clearTimeout(r.initial);
  r.interval = null;
  r.initial = null;
}

/** Register a periodic job that runs only on the leader. Returns false when scheduled externally. */
export function registerLeaderJob(job: LeaderJob, leadership: Leadership = getLeadership()): boolean {
  if (registered.has(job.name)) return true;
  if (externallyScheduledJobs().has(job.name)) {
    console.log(`[jobs] ${job.name}: scheduled externally (JOBS_EXTERNAL), in-process timer disabled`);
    return false;
  }
  const r: Registered = { job, interval: null, initial: null, running: false, unsubscribe: () => {} };
  r.unsubscribe = leadership.onLeadershipChange((leader) => (leader ? startTimers(r, leadership) : stopTimers(r)));
  registered.set(job.name, r);
  if (leadership.isLeader()) startTimers(r, leadership);
  return true;
}

export function isJobTimerActive(name: string): boolean {
  const r = registered.get(name);
  return !!(r && (r.interval || r.initial));
}

/** Stop and forget one registered job. */
export function unregisterLeaderJob(name: string): void {
  const r = registered.get(name);
  if (!r) return;
  stopTimers(r);
  r.unsubscribe();
  registered.delete(name);
}

/** Stop and forget every registered job (shutdown / tests). */
export function unregisterAllJobs(): void {
  for (const r of registered.values()) {
    stopTimers(r);
    r.unsubscribe();
  }
  registered.clear();
}
