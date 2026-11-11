import { AlertEvent } from '../../../src/lib/alert-events';
import { LeadershipListener } from '../../../src/lib/leader';
import { isJobTimerActive, registerLeaderJob, unregisterAllJobs } from '../../../src/lib/scheduler';
import {
  browserCheckStale, browserStaleAfterMs, buildAlertEvent, detectStaleBrowserChecks, executeCheck, initialNextRun, nextState,
  pruneSyntheticResults, recordResult, runDueChecks,
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
  async listEnabledBrowserChecks(limit: number) {
    return this.checks.filter((c) => c.enabled && c.type === 'browser').slice(0, limit).map((c) => ({ ...c }));
  }
  async pruneResultsWithoutScreenshot(before: Date) {
    const n = this.results.length;
    this.results = this.results.filter((r) => !(r.startedAt < before && !r.screenshotKey));
    return n - this.results.length;
  }
  async listExpiredScreenshots(before: Date, limit: number) {
    return this.results.filter((r) => r.startedAt < before && r.screenshotKey)
      .sort((a, b) => a.startedAt - b.startedAt).slice(0, limit).map((r) => ({ id: r.id, screenshotKey: r.screenshotKey }));
  }
  async deleteResults(ids: string[]) {
    this.results = this.results.filter((r) => !ids.includes(r.id));
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

  it('executeCheck hands the platform CA to the guard for API-side checks (#152)', async () => {
    const store = new MemStore();
    store.checks.push(check());
    let seen: any = null;
    await executeCheck(store.checks[0], {
      store, platformCa: async () => 'PEM', publish: async () => {},
      run: async (_c, deps) => { seen = deps.guard; return outcome('pass'); },
    });
    expect(seen).toMatchObject({ platformCa: 'PEM' });
    expect(Array.isArray(seen.allowedIngressHosts)).toBe(true);
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
    store.results.push({ id: 'a', startedAt: old, screenshotKey: null }, { id: 'b', startedAt: new Date(), screenshotKey: null });
    await pruneSyntheticResults(store, Date.now(), { deleteObject: async () => {} });
    expect(store.results).toHaveLength(1);
  });

  it('prunes screenshot rows in batches, only after their object is deleted', async () => {
    const store = new MemStore();
    const old = (i: number) => new Date(Date.now() - 40 * 86_400_000 + i);
    for (let i = 0; i < 25; i++) store.results.push({ id: `s${i}`, startedAt: old(i), screenshotKey: `shots/${i}.png` });
    store.results.push({ id: 'n1', startedAt: old(99), screenshotKey: null }, { id: 'fresh', startedAt: new Date(), screenshotKey: 'shots/fresh.png' });
    const objects = new Set(store.results.map((r) => r.screenshotKey).filter(Boolean));
    const failing = new Set(['shots/3.png', 'shots/17.png']);
    const removed = await pruneSyntheticResults(store, Date.now(), {
      batchSize: 10,
      deleteObject: async (key) => { if (failing.has(key)) throw new Error('store unavailable'); objects.delete(key); },
    });
    expect(removed).toBe(1 + 23);
    // Every remaining row still has its object; every deleted object's row is gone.
    expect(store.results.map((r) => r.id).sort()).toEqual(['fresh', 's17', 's3']);
    for (const r of store.results) expect(objects.has(r.screenshotKey)).toBe(true);
    expect([...objects].sort()).toEqual(['shots/17.png', 'shots/3.png', 'shots/fresh.png']);
  });

  it('stops when nothing in a batch can be deleted, and within its time budget', async () => {
    const store = new MemStore();
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (let i = 0; i < 30; i++) store.results.push({ id: `s${i}`, startedAt: old, screenshotKey: `k${i}` });
    let calls = 0;
    expect(await pruneSyntheticResults(store, Date.now(), { batchSize: 10, deleteObject: async () => { calls++; throw new Error('down'); } })).toBe(0);
    expect(calls).toBe(10);
    expect(store.results).toHaveLength(30);
    let t = 0;
    const removed = await pruneSyntheticResults(store, Date.now(), { batchSize: 10, budgetMs: 1000, clock: () => (t += 600), deleteObject: async () => {} });
    expect(removed).toBe(10);
    expect(store.results).toHaveLength(20);
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

describe('browser checks that stop reporting', () => {
  const MIN = 60_000;
  const t0 = new Date('2026-11-11T10:00:00Z').getTime();
  const browser = (over: Record<string, any> = {}) => check({
    type: 'browser', intervalSeconds: 300, timeoutMs: 60_000, config: { steps: [] },
    createdAt: new Date(t0), updatedAt: new Date(t0), lastRunAt: null, ...over,
  });

  it('window is max(2 x interval, interval + job deadline)', () => {
    expect(browserStaleAfterMs({ intervalSeconds: 300, timeoutMs: 60_000 })).toBe(10 * MIN); // 2x300 > 300+150
    expect(browserStaleAfterMs({ intervalSeconds: 300, timeoutMs: 120_000 })).toBe(10 * MIN); // 2x300 > 300+210
    expect(browserStaleAfterMs({ intervalSeconds: 86_400, timeoutMs: 60_000 })).toBe(2 * 86_400_000);
  });

  it('measures from the last result or the last change, whichever is later', () => {
    expect(browserCheckStale(browser(), t0 + 9 * MIN)).toBe(false);
    expect(browserCheckStale(browser(), t0 + 11 * MIN)).toBe(true);
    expect(browserCheckStale(browser({ lastRunAt: new Date(t0 + 5 * MIN) }), t0 + 11 * MIN)).toBe(false);
    // Re-enabled / edited recently: a full window again.
    expect(browserCheckStale(browser({ lastRunAt: new Date(t0 - 86_400_000), updatedAt: new Date(t0 + 5 * MIN) }), t0 + 11 * MIN)).toBe(false);
    expect(browserCheckStale(browser({ enabled: false }), t0 + 60 * MIN)).toBe(false);
    expect(browserCheckStale(browser({ type: 'http' }), t0 + 60 * MIN)).toBe(false);
  });

  it('records a failed result that counts toward consecutive failures and fires the alert', async () => {
    const store = new MemStore();
    store.checks.push(browser({ alertPolicy: { failureThreshold: 2 } }), browser({ id: 'aaaaaaaa-0000-4000-8000-000000000002', lastRunAt: new Date(t0 + 30 * MIN) }));
    const events: AlertEvent[] = [];
    let now = new Date(t0 + 11 * MIN);
    const deps = {
      store, now: () => now, publish: async (e: AlertEvent) => { events.push(e); },
      runtimeEnabled: async () => true, jobFailure: async () => 'runner pod: ImagePullBackOff',
    };
    expect(await detectStaleBrowserChecks(deps)).toBe(1);
    expect(store.results).toHaveLength(1);
    expect(store.results[0]).toMatchObject({ checkId: store.checks[0].id, status: 'fail', startedAt: now });
    expect(store.results[0].error).toBe('Runner did not report a result within 10 minutes (runner pod: ImagePullBackOff)');
    expect(store.checks[0]).toMatchObject({ lastStatus: 'down', consecutiveFailures: 1, lastRunAt: now });
    expect(events).toHaveLength(0);
    // Not again until another full window has passed.
    now = new Date(t0 + 15 * MIN);
    expect(await detectStaleBrowserChecks(deps)).toBe(0);
    now = new Date(t0 + 22 * MIN);
    expect(await detectStaleBrowserChecks(deps)).toBe(1);
    expect(store.checks[0]).toMatchObject({ consecutiveFailures: 2, alertState: 'firing' });
    expect(events).toEqual([expect.objectContaining({ status: 'firing', dedupeKey: `synthetic:${store.checks[0].id}` })]);
  });

  it('says so when browser checks are not enabled on the cluster', async () => {
    const store = new MemStore();
    store.checks.push(browser());
    await detectStaleBrowserChecks({ store, now: () => new Date(t0 + 11 * MIN), publish: async () => {}, runtimeEnabled: async () => false, jobFailure: async () => 'unused' });
    expect(store.results[0].error).toBe('Runner did not report a result within 10 minutes (browser checks are not enabled on this cluster)');
  });
});
