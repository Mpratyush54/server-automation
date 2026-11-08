import { registerLeaderJob, unregisterAllJobs, isJobTimerActive } from '../../../src/lib/scheduler';
import { StaticLeader, LeadershipListener } from '../../../src/lib/leader';
import { renderJobMetrics, resetJobMetrics } from '../../../src/lib/job-metrics';

/** Leadership handle whose state the test flips by hand. */
class ManualLeader {
  private leader = false;
  private listeners = new Set<LeadershipListener>();
  isLeader() { return this.leader; }
  onLeadershipChange(fn: LeadershipListener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  start() {}
  async stop() {}
  set(v: boolean) { this.leader = v; for (const fn of this.listeners) fn(v); }
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('leader-gated scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetJobMetrics();
    delete process.env.JOBS_EXTERNAL;
  });
  afterEach(() => {
    unregisterAllJobs();
    jest.useRealTimers();
  });

  it('runs only while leader and stops the timer on leadership loss', async () => {
    const leader = new ManualLeader();
    const run = jest.fn().mockResolvedValue(undefined);
    registerLeaderJob({ name: 'job-a', intervalMs: 1_000, initialDelayMs: 100, run }, leader as any);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    expect(isJobTimerActive('job-a')).toBe(false);

    leader.set(true);
    expect(isJobTimerActive('job-a')).toBe(true);
    await jest.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(4);

    leader.set(false);
    expect(isJobTimerActive('job-a')).toBe(false);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('with two replicas, each interval runs once cluster-wide', async () => {
    // Shared "Lease": exactly one of the two replicas is leader at a time.
    const replicas = [new ManualLeader(), new ManualLeader()];
    const runs: number[] = [];
    replicas.forEach((l, i) => {
      // Separate registries per replica are simulated by distinct job names.
      registerLeaderJob({ name: `decay-replica-${i}`, intervalMs: 1_000, initialDelayMs: 1_000, run: async () => { runs.push(i); } }, l as any);
    });
    replicas[0].set(true);
    await jest.advanceTimersByTimeAsync(3_000);
    // Leader moves to replica 1 (e.g. replica 0 was killed).
    replicas[0].set(false);
    replicas[1].set(true);
    await jest.advanceTimersByTimeAsync(3_000);
    // One run per interval: 3 on replica 0, then 3 on replica 1, never both.
    expect(runs).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('never overlaps runs of the same job', async () => {
    const leader = new ManualLeader();
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const run = jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      release = () => { active--; resolve(); };
    }));
    registerLeaderJob({ name: 'slow', intervalMs: 100, initialDelayMs: 100, run }, leader as any);
    leader.set(true);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
    release();
    await flush();
    await jest.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('records platform_job_runs_total and last success', async () => {
    const leader = new StaticLeader();
    let fail = false;
    registerLeaderJob({ name: 'metric-job', intervalMs: 1_000, initialDelayMs: 1_000, run: async () => { if (fail) throw new Error('boom'); } }, leader);
    leader.start();
    await jest.advanceTimersByTimeAsync(1_000);
    fail = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await jest.advanceTimersByTimeAsync(1_000);
    const text = renderJobMetrics();
    expect(text).toContain('platform_job_runs_total{job="metric-job",result="success"} 1');
    expect(text).toContain('platform_job_runs_total{job="metric-job",result="failure"} 1');
    expect(text).toMatch(/platform_job_last_success_timestamp_seconds\{job="metric-job"\} \d+/);
    await leader.stop();
  });

  it('JOBS_EXTERNAL disables the in-process timer (CronJob path)', () => {
    process.env.JOBS_EXTERNAL = 'token-cleanup, other';
    const leader = new ManualLeader();
    leader.set(true);
    const ok = registerLeaderJob({ name: 'token-cleanup', intervalMs: 1_000, run: jest.fn() }, leader as any);
    expect(ok).toBe(false);
    expect(isJobTimerActive('token-cleanup')).toBe(false);
  });
});
