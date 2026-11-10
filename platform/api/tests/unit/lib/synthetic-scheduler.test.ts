import { AlertEvent } from '../../../src/lib/alert-events';
import { LeadershipListener } from '../../../src/lib/leader';
import { isJobTimerActive, registerLeaderJob, unregisterAllJobs } from '../../../src/lib/scheduler';
import {
  buildAlertEvent, executeCheck, initialNextRun, nextState, pruneSyntheticResults, recordResult, runDueChecks,
  SyntheticStore, SYNTHETICS_JOB,
} from '../../../src/lib/synthetic-scheduler';
import type { RunOutcome } from '../../../src/lib/synthetic-runner';
import { renderSyntheticMetricsText, resetSyntheticMetricsForTests } from '../../../src/lib/synthetic-metrics';

class MemStore implements SyntheticStore {
  checks: any[] = [];
  results: any[] = [];
  async listDue(now: Date, limit: number) {
    return this.checks
      .filter((c) => c.enabled && c.type !== 'browser' && (c.nextRunAt === null || c.nextRunAt <= now))
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }
  async claim(id: string, expected: Date | null, next: Date) {
    const c = this.checks.find((x) => x.id === id);
    if (!c || (c.nextRunAt?.getTime() ?? null) !== (expected?.getTime() ?? null)) return false;
    c.nextRunAt = next;
    return true;
  }
  async updateCheck(id: string, patch: any) { Object.assign(this.checks.find((x) => x.id === id), patch); }
  async saveResult(r: any) { const row = { id: `r${this.results.length + 1}`, ...r }; this.results.push(row); return row; }
  async ingressHosts() { return ['app.example.com']; }
  async pruneResults(before: Date) {
    const old = this.results.filter((r) => r.startedAt < before);
    this.results = this.results.filter((r) => r.startedAt >= before);
    return old.map((r) => r.screenshotKey).filter(Boolean);
  }
}

const outcome = (status: RunOutcome['status'], error: string | null = null): RunOutcome => ({
  status, latencyMs: 12, statusCode: status === 'fail' ? 503 : 200, error, assertions: [], steps: null, sslExpiresAt: null, sslDaysRemaining: null,
});

function check(over: Record<string, any> = {}) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001', projectId: 'pppppppp-0000-4000-8000-000000000001', environmentId: null,
    name: 'Home page', type: 'http', enabled: true, intervalSeconds: 60, timeoutMs: 5000,
    config: { url: 'https://app.example.com/', method: 'GET', assertions: [] }, secretsEncrypted: null,
    alertPolicy: {}, nextRunAt: null, lastStatus: 'unknown', consecutiveFailures: 0, alertState: 'ok',
    ...over,
  } as any;
}

describe('alert state machine', () => {
  it('fires after N consecutive failures, once, and resolves on recovery', () => {
    let s: any = { consecutiveFailures: 0, alertState: 'ok' };
    const steps: any[] = [];
    for (const r of ['fail', 'fail', 'fail', 'pass'] as const) {
      const t = nextState(s, r, { failureThreshold: 2 });
      steps.push(t.event);
      s = t;
    }
    expect(steps).toEqual([null, { status: 'firing', severity: 'critical' }, null, { status: 'resolved', severity: 'info' }]);
  });

  it('a pass between failures resets the counter', () => {
    let s: any = { consecutiveFailures: 0, alertState: 'ok' };
    for (const r of ['fail', 'pass', 'fail'] as const) s = nextState(s, r, {});
    expect(s).toMatchObject({ consecutiveFailures: 1, alertState: 'ok', event: null });
  });

  it('degraded (SSL warning) fires a warning immediately; recovery resolves it', () => {
    const w = nextState({ consecutiveFailures: 0, alertState: 'ok' }, 'degraded', {});
    expect(w).toMatchObject({ alertState: 'warning', lastStatus: 'degraded', event: { status: 'firing', severity: 'warning' } });
    expect(nextState(w, 'degraded', {}).event).toBeNull();
    expect(nextState(w, 'pass', {}).event).toEqual({ status: 'resolved', severity: 'info' });
  });

  it('disabled policy never fires and resolves anything open', () => {
    expect(nextState({ consecutiveFailures: 5, alertState: 'ok' }, 'fail', { enabled: false }).event).toBeNull();
    expect(nextState({ consecutiveFailures: 5, alertState: 'firing' }, 'fail', { enabled: false }).event).toEqual({ status: 'resolved', severity: 'info' });
  });

  it('event contract: source synthetics, dedupeKey synthetic:<checkId>, portal link', () => {
    const e = buildAlertEvent(check(), { status: 'firing', severity: 'critical' }, { error: '503', consecutiveFailures: 2, result: 'fail' });
    expect(e).toMatchObject({
      source: 'synthetics', severity: 'critical', status: 'firing', dedupeKey: 'synthetic:aaaaaaaa-0000-4000-8000-000000000001',
      projectId: 'pppppppp-0000-4000-8000-000000000001', body: '503', labels: { checkType: 'http' },
    });
    expect(e.url).toBe('/projects/pppppppp-0000-4000-8000-000000000001/synthetics?check=aaaaaaaa-0000-4000-8000-000000000001');
  });
});

describe('scheduler tick', () => {
  beforeEach(() => resetSyntheticMetricsForTests());

  it('HTTP check failing for 2 consecutive runs triggers an alert; recovery resolves it', async () => {
    const store = new MemStore();
    store.checks.push(check());
    const events: AlertEvent[] = [];
    const publish = async (e: AlertEvent) => { events.push(e); };
    let t = new Date('2026-11-10T10:00:00Z').getTime();
    const now = () => new Date(t);
    let next: RunOutcome = outcome('fail', 'HTTP 503');
    const run = jest.fn(async (_c: any, deps: any) => {
      expect(deps.guard.allowedIngressHosts).toEqual(['app.example.com']);
      return next;
    });

    expect(await runDueChecks({ store, now, run, publish })).toBe(1);
    expect(events).toHaveLength(0);
    // Not due again until the interval has passed.
    t += 30_000;
    expect(await runDueChecks({ store, now, run, publish })).toBe(0);
    t += 30_000;
    expect(await runDueChecks({ store, now, run, publish })).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'firing', source: 'synthetics', dedupeKey: `synthetic:${store.checks[0].id}` });
    expect(store.checks[0]).toMatchObject({ consecutiveFailures: 2, alertState: 'firing', lastStatus: 'down' });

    t += 60_000;
    await runDueChecks({ store, now, run, publish });
    expect(events).toHaveLength(1); // still failing: no duplicate

    next = outcome('pass');
    t += 60_000;
    await runDueChecks({ store, now, run, publish });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ status: 'resolved', dedupeKey: events[0].dedupeKey });
    expect(store.checks[0]).toMatchObject({ consecutiveFailures: 0, alertState: 'ok', lastStatus: 'up' });
    expect(store.results.map((r) => r.status)).toEqual(['fail', 'fail', 'fail', 'pass']);

    const metrics = renderSyntheticMetricsText([{ ...store.checks[0], lastRunAt: now(), lastLatencyMs: 12 }], true);
    expect(metrics).toContain('platform_synthetic_runs_total{type="http",result="fail"} 3');
    expect(metrics).toContain(`platform_synthetic_check_up{project_id="${store.checks[0].projectId}",check_id="${store.checks[0].id}",type="http"} 1`);
    expect(metrics).toContain('platform_synthetic_check_latency_seconds');
  });

  it('claims each due check once (a concurrent claimer loses) and skips browser / disabled checks', async () => {
    const store = new MemStore();
    store.checks.push(check(), check({ id: 'b', type: 'browser' }), check({ id: 'd', enabled: false }));
    const realClaim = store.claim.bind(store);
    // Another runner claims the first check between listDue and claim.
    store.claim = async (id, expected, nextAt) => {
      await realClaim(id, expected, new Date(0));
      return realClaim(id, expected, nextAt);
    };
    const run = jest.fn(async () => outcome('pass'));
    expect(await runDueChecks({ store, run, publish: async () => {} })).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('respects the concurrency cap', async () => {
    const store = new MemStore();
    for (let i = 0; i < 6; i++) store.checks.push(check({ id: `c${i}` }));
    const run = jest.fn(async () => outcome('pass'));
    expect(await runDueChecks({ store, run, publish: async () => {}, concurrency: 4 })).toBe(4);
    expect(await runDueChecks({ store, run, publish: async () => {}, concurrency: 4 })).toBe(2);
  });

  it('a runner exception is recorded as a failed run, not thrown', async () => {
    const store = new MemStore();
    store.checks.push(check());
    const r = await executeCheck(store.checks[0], { store, run: async () => { throw new Error('boom'); }, publish: async () => {} });
    expect(r).toMatchObject({ status: 'fail', error: 'Runner error: boom' });
  });

  it('recordResult stores screenshot keys and the SSL expiry', async () => {
    const store = new MemStore();
    store.checks.push(check({ type: 'browser' }));
    const exp = new Date('2027-01-01T00:00:00Z');
    await recordResult(store, store.checks[0], { ...outcome('fail', 'selector not found'), sslExpiresAt: exp }, { startedAt: new Date(), screenshotKey: 'synthetics/p/c/1.png', publish: async () => {} });
    expect(store.results[0]).toMatchObject({ screenshotKey: 'synthetics/p/c/1.png', status: 'fail', location: 'local' });
    expect(store.checks[0].sslExpiresAt).toEqual(exp);
  });

  it('prunes old results', async () => {
    const store = new MemStore();
    const old = new Date(Date.now() - 40 * 86_400_000);
    store.results.push({ startedAt: old, screenshotKey: null }, { startedAt: new Date(), screenshotKey: null });
    await pruneSyntheticResults(store);
    expect(store.results).toHaveLength(1);
  });

  it('first run is jittered within a minute', () => {
    const n = 1_000_000;
    expect(initialNextRun(300, n, () => 0).getTime()).toBe(n + 5_000);
    expect(initialNextRun(300, n, () => 0.999).getTime()).toBe(n + 5_000 + 59_000);
  });
});

describe('leader execution', () => {
  class ManualLeader {
    private leader = false;
    private listeners = new Set<LeadershipListener>();
    isLeader() { return this.leader; }
    onLeadershipChange(fn: LeadershipListener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    start() {}
    async stop() {}
    set(v: boolean) { this.leader = v; for (const fn of this.listeners) fn(v); }
  }
  afterEach(() => { unregisterAllJobs(); jest.useRealTimers(); });

  it('the runner job only ticks on the leader', async () => {
    jest.useFakeTimers();
    const leader = new ManualLeader();
    const tick = jest.fn(async () => undefined);
    registerLeaderJob({ name: SYNTHETICS_JOB, intervalMs: 5_000, initialDelayMs: 10, run: tick }, leader as any);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(tick).not.toHaveBeenCalled();
    leader.set(true);
    expect(isJobTimerActive(SYNTHETICS_JOB)).toBe(true);
    await jest.advanceTimersByTimeAsync(10_100);
    expect(tick).toHaveBeenCalledTimes(3);
    leader.set(false);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
