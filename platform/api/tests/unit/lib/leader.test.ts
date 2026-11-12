import { LeaderElector, LeaseApi } from '../../../src/lib/leader';
import { renderJobMetrics, resetJobMetrics } from '../../../src/lib/job-metrics';

/** In-memory coordination.k8s.io Lease API with resourceVersion compare-and-swap. */
class FakeLeaseApi implements LeaseApi {
  lease: any = null;
  rv = 0;
  down = false;
  calls: string[] = [];

  private check() {
    if (this.down) throw Object.assign(new Error('apiserver unreachable'), { code: 503 });
  }
  async readNamespacedLease() {
    this.check();
    this.calls.push('read');
    if (!this.lease) throw Object.assign(new Error('not found'), { code: 404 });
    return JSON.parse(JSON.stringify(this.lease));
  }
  async createNamespacedLease({ body }: any) {
    this.check();
    this.calls.push('create');
    if (this.lease) throw Object.assign(new Error('exists'), { code: 409 });
    this.lease = JSON.parse(JSON.stringify({ ...body, metadata: { ...body.metadata, resourceVersion: String(++this.rv) } }));
    return this.lease;
  }
  async replaceNamespacedLease({ body }: any) {
    this.check();
    this.calls.push('replace');
    if (!this.lease) throw Object.assign(new Error('not found'), { code: 404 });
    if (body.metadata?.resourceVersion !== this.lease.metadata.resourceVersion) {
      throw Object.assign(new Error('conflict'), { code: 409 });
    }
    this.lease = JSON.parse(JSON.stringify({ ...body, metadata: { ...body.metadata, resourceVersion: String(++this.rv) } }));
    return this.lease;
  }
}

function makeElector(api: LeaseApi, identity: string, clock: { t: number }) {
  return new LeaderElector({
    api,
    namespace: 'platform',
    identity,
    leaseDurationMs: 10_000,
    retryPeriodMs: 2_000,
    now: () => clock.t,
    log: () => {},
  });
}

describe('LeaderElector (coordination.k8s.io Lease)', () => {
  beforeEach(() => resetJobMetrics());

  it('acquires by creating the Lease when none exists', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const a = makeElector(api, 'pod-a', clock);
    const changes: boolean[] = [];
    a.onLeadershipChange((v) => changes.push(v));

    expect(await a.tick()).toBe(true);
    expect(a.isLeader()).toBe(true);
    expect(changes).toEqual([true]);
    expect(api.lease.metadata.name).toBe('platform-api-leader');
    expect(api.lease.spec.holderIdentity).toBe('pod-a');
    expect(api.lease.spec.leaseDurationSeconds).toBe(10);
    // MicroTime wire format: six fractional digits.
    expect(api.lease.spec.renewTime).toMatch(/\.\d{6}Z$/);
    expect(renderJobMetrics()).toContain('platform_api_leader 1');
  });

  it('renews its own Lease and keeps leadership', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const a = makeElector(api, 'pod-a', clock);
    await a.tick();
    const firstRenew = api.lease.spec.renewTime;
    clock.t += 2_000;
    expect(await a.tick()).toBe(true);
    expect(api.lease.spec.renewTime).not.toBe(firstRenew);
    expect(api.lease.spec.leaseTransitions).toBe(0);
  });

  it('a second replica cannot acquire while the holder keeps renewing', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const a = makeElector(api, 'pod-a', clock);
    const b = makeElector(api, 'pod-b', clock);
    await a.tick();
    for (let i = 0; i < 20; i++) {
      clock.t += 2_000;
      await a.tick();
      await b.tick();
      expect(a.isLeader()).toBe(true);
      expect(b.isLeader()).toBe(false);
    }
  });

  it('takes over within the lease duration (+ one retry) after the leader dies', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const a = makeElector(api, 'pod-a', clock);
    const b = makeElector(api, 'pod-b', clock);
    await a.tick();
    await b.tick(); // b observes a's record
    const killedAt = clock.t; // pod-a is killed here: no more renewals
    while (!b.isLeader()) {
      clock.t += 2_000;
      await b.tick();
      expect(clock.t - killedAt).toBeLessThanOrEqual(15_000);
    }
    expect(clock.t - killedAt).toBeLessThanOrEqual(12_000);
    expect(api.lease.spec.holderIdentity).toBe('pod-b');
    expect(api.lease.spec.leaseTransitions).toBe(1);
  });

  it('a released Lease is taken over immediately', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const a = makeElector(api, 'pod-a', clock);
    const b = makeElector(api, 'pod-b', clock);
    await a.tick();
    await b.tick();
    await a.stop();
    expect(a.isLeader()).toBe(false);
    expect(api.lease.spec.holderIdentity).toBe('');
    clock.t += 2_000;
    expect(await b.tick()).toBe(true);
  });

  it('loses leadership when a peer holds the Lease, then re-acquires after it lapses', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const a = makeElector(api, 'pod-a', clock);
    const changes: boolean[] = [];
    a.onLeadershipChange((v) => changes.push(v));
    await a.tick();

    // Simulate a partition: a peer force-acquired the Lease.
    api.lease.spec.holderIdentity = 'pod-b';
    api.lease.metadata.resourceVersion = String(++api.rv);
    clock.t += 2_000;
    expect(await a.tick()).toBe(false);
    expect(changes).toEqual([true, false]);

    // pod-b never renews; after a full lease duration pod-a re-acquires.
    for (let i = 0; i < 6 && !a.isLeader(); i++) {
      clock.t += 2_000;
      await a.tick();
    }
    expect(a.isLeader()).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });

  it('a concurrent update (409 Conflict) means only one candidate wins', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const a = makeElector(api, 'pod-a', clock);
    const b = makeElector(api, 'pod-b', clock);
    // Free Lease that both see at the same time.
    api.lease = { metadata: { name: 'platform-api-leader', resourceVersion: String(++api.rv) }, spec: { holderIdentity: '' } };
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    expect([ra, rb].filter(Boolean)).toHaveLength(1);
  });

  it('steps down before the lease expires when it cannot renew', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const a = makeElector(api, 'pod-a', clock);
    await a.tick();
    api.down = true;
    let steppedDownAfter = 0;
    for (let i = 1; i <= 10 && a.isLeader(); i++) {
      clock.t += 2_000;
      await a.tick();
      steppedDownAfter = i * 2_000;
    }
    expect(a.isLeader()).toBe(false);
    // Must give up strictly before a peer is allowed to take over (10 s).
    expect(steppedDownAfter).toBeLessThan(10_000);
    expect(renderJobMetrics()).toContain('platform_api_leader 0');
  });

  it('two electors never both lead across a long randomised run', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const a = makeElector(api, 'pod-a', clock);
    const b = makeElector(api, 'pod-b', clock);
    let aliveA = true;
    for (let i = 0; i < 200; i++) {
      clock.t += 1_000;
      if (i === 50) aliveA = false; // pod-a hangs
      if (i === 120) aliveA = true; // and comes back
      if (aliveA) await a.tick();
      await b.tick();
      expect(a.isLeader() && b.isLeader()).toBe(false);
    }
    expect(a.isLeader() || b.isLeader()).toBe(true);
  });

  it('times out a hung Lease call so a follower can still take over', async () => {
    const api = new FakeLeaseApi();
    const clock = { t: 1_000_000 };
    const hung = { ...api, readNamespacedLease: () => new Promise<any>(() => {}) } as unknown as LeaseApi;
    const a = new LeaderElector({ api: hung, namespace: 'platform', identity: 'pod-a', leaseDurationMs: 10_000, retryPeriodMs: 2_000, requestTimeoutMs: 50, now: () => clock.t, log: () => {} });
    const started = Date.now();
    expect(await a.tick()).toBe(false); // fails fast instead of hanging
    expect(Date.now() - started).toBeLessThan(2_000);
    // The next attempt on a healthy connection acquires normally.
    const b = makeElector(api, 'pod-b', clock);
    expect(await b.tick()).toBe(true);
  });
});
