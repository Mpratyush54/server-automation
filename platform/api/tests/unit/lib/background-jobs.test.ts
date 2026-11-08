import {
  JobStore, JobHandler, runJob, recoverStaleJobs, enqueueAndRun, QUEUED_GRACE_MS,
} from '../../../src/lib/background-jobs';
import { BackgroundJob } from '../../../src/entities/BackgroundJob';
import { renderJobMetrics, resetJobMetrics } from '../../../src/lib/job-metrics';

/** In-memory JobStore mirroring the SQL conditions of typeormJobStore. */
class MemoryStore implements JobStore {
  jobs = new Map<string, BackgroundJob>();
  t = 1_000_000;
  seq = 0;
  now() { return this.t; }

  async create(input: any) {
    const job = Object.assign(new BackgroundJob(), {
      id: `job-${++this.seq}`, type: input.type, targetId: input.targetId, payload: input.payload ?? null,
      maxAttempts: input.maxAttempts ?? 2, status: 'queued', step: 'queued', attempts: 0,
      lockedBy: null, lockedUntil: null, lastError: null, finishedAt: null,
      createdAt: new Date(this.t), updatedAt: new Date(this.t),
    });
    this.jobs.set(job.id, job);
    return { ...job };
  }
  private lapsed(j: BackgroundJob) { return !j.lockedUntil || j.lockedUntil.getTime() < this.t; }
  async claim(id: string, owner: string, lockMs: number) {
    const j = this.jobs.get(id);
    if (!j || j.attempts >= j.maxAttempts) return null;
    if (!(j.status === 'queued' || (j.status === 'running' && this.lapsed(j)))) return null;
    Object.assign(j, { status: 'running', lockedBy: owner, lockedUntil: new Date(this.t + lockMs), attempts: j.attempts + 1 });
    return { ...j };
  }
  async heartbeat(id: string, owner: string, lockMs: number, step?: string) {
    const j = this.jobs.get(id);
    if (!j || j.lockedBy !== owner || j.status !== 'running') return false;
    j.lockedUntil = new Date(this.t + lockMs);
    if (step) j.step = step;
    return true;
  }
  async finish(id: string, owner: string, status: 'succeeded' | 'failed', error?: string | null) {
    const j = this.jobs.get(id);
    if (!j || j.lockedBy !== owner) return;
    Object.assign(j, { status, lastError: error ?? null, lockedUntil: null, finishedAt: new Date(this.t) });
  }
  async findStale() {
    return [...this.jobs.values()]
      .filter((j) => (j.status === 'queued' || j.status === 'running'))
      .filter((j) => (j.lockedUntil === null ? j.createdAt.getTime() < this.t - QUEUED_GRACE_MS : j.lockedUntil.getTime() < this.t))
      .map((j) => ({ ...j }));
  }
  async failUnowned(id: string, error: string) {
    const j = this.jobs.get(id);
    if (!j || !(j.status === 'queued' || j.status === 'running') || !this.lapsed(j)) return false;
    Object.assign(j, { status: 'failed', lastError: error, lockedUntil: null, finishedAt: new Date(this.t) });
    return true;
  }
}

/** Simulated deployment rows + a deploy-like handler. */
function makeDeployHandler() {
  const deployments = new Map<string, string>(); // id -> status
  const runs: string[] = [];
  let behaviour: 'ok' | 'throw' | 'hang' = 'ok';
  const handler: JobHandler = {
    async run(job, ctx) {
      runs.push(job.targetId);
      deployments.set(job.targetId, 'deploying');
      await ctx.setStep('argo-sync');
      if (behaviour === 'throw') throw new Error('argo exploded');
      if (behaviour === 'hang') return new Promise<void>(() => {}); // process "dies" mid-run
      deployments.set(job.targetId, 'deployed');
    },
    async isComplete(job) {
      return ['deployed', 'failed'].includes(deployments.get(job.targetId) || '');
    },
    async onGiveUp(job, reason) {
      if (!['deployed', 'failed'].includes(deployments.get(job.targetId) || '')) {
        deployments.set(job.targetId, `failed:${reason}`);
      }
    },
  };
  return { handler, deployments, runs, set: (b: typeof behaviour) => { behaviour = b; } };
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

describe('durable background jobs', () => {
  beforeEach(() => {
    resetJobMetrics();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('enqueueAndRun persists the job and runs it to success', async () => {
    const store = new MemoryStore();
    const d = makeDeployHandler();
    const job = await enqueueAndRun(store, { deploy: d.handler }, { type: 'deploy', targetId: 'dep-1' });
    expect(store.jobs.get(job.id)!.status).toBe('queued');
    await flush();
    const saved = store.jobs.get(job.id)!;
    expect(saved.status).toBe('succeeded');
    expect(saved.step).toBe('argo-sync');
    expect(saved.attempts).toBe(1);
    expect(d.deployments.get('dep-1')).toBe('deployed');
    expect(renderJobMetrics()).toContain('platform_job_runs_total{job="job-deploy",result="success"} 1');
  });

  it('a job is claimed by only one worker', async () => {
    const store = new MemoryStore();
    const d = makeDeployHandler();
    const job = await store.create({ type: 'deploy', targetId: 'dep-1' });
    const [a, b] = await Promise.all([
      runJob(store, { deploy: d.handler }, job.id, 'pod-a'),
      runJob(store, { deploy: d.handler }, job.id, 'pod-b'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(d.runs).toEqual(['dep-1']);
  });

  it('a handler error fails the job and leaves the target terminal', async () => {
    const store = new MemoryStore();
    const d = makeDeployHandler();
    d.set('throw');
    const job = await store.create({ type: 'deploy', targetId: 'dep-1' });
    await runJob(store, { deploy: d.handler }, job.id, 'pod-a');
    expect(store.jobs.get(job.id)!.status).toBe('failed');
    expect(store.jobs.get(job.id)!.lastError).toBe('argo exploded');
    expect(d.deployments.get('dep-1')).toBe('failed:argo exploded');
  });

  it('resumes a rollout abandoned by a restarted replica', async () => {
    const store = new MemoryStore();
    const d = makeDeployHandler();
    const job = await store.create({ type: 'deploy', targetId: 'dep-1' });
    d.set('hang');
    void runJob(store, { deploy: d.handler }, job.id, 'pod-a', 60_000); // pod-a dies mid-run
    await flush();
    expect(store.jobs.get(job.id)!.status).toBe('running');

    // Lock still valid: the leader must not steal it.
    let r = await recoverStaleJobs(store, { deploy: d.handler }, 'pod-b');
    expect(r.resumed).toEqual([]);

    store.t += 61_000; // lock lapsed (no heartbeats from the dead pod)
    d.set('ok');
    r = await recoverStaleJobs(store, { deploy: d.handler }, 'pod-b');
    expect(r.resumed).toEqual([job.id]);
    await flush();
    const saved = store.jobs.get(job.id)!;
    expect(saved.status).toBe('succeeded');
    expect(saved.attempts).toBe(2);
    expect(saved.lockedBy).toBe('pod-b');
    expect(d.deployments.get('dep-1')).toBe('deployed');
  });

  it('marks the deployment failed when attempts are exhausted — never stuck in progress', async () => {
    const store = new MemoryStore();
    const d = makeDeployHandler();
    d.set('hang');
    const job = await store.create({ type: 'deploy', targetId: 'dep-1', maxAttempts: 2 });
    void runJob(store, { deploy: d.handler }, job.id, 'pod-a', 60_000);
    await flush();
    store.t += 61_000;
    await recoverStaleJobs(store, { deploy: d.handler }, 'pod-b', 60_000); // attempt 2 also dies
    await flush();
    expect(store.jobs.get(job.id)!.attempts).toBe(2);
    store.t += 61_000;
    const r = await recoverStaleJobs(store, { deploy: d.handler }, 'pod-c');
    expect(r.failed).toEqual([job.id]);
    expect(store.jobs.get(job.id)!.status).toBe('failed');
    expect(d.deployments.get('dep-1')).toMatch(/^failed:interrupted/);
    expect(renderJobMetrics()).toContain('platform_job_runs_total{job="job-deploy",result="failure"} 1');
  });

  it('does not re-run a job whose target already finished before the crash', async () => {
    const store = new MemoryStore();
    const d = makeDeployHandler();
    const job = await store.create({ type: 'deploy', targetId: 'dep-1' });
    // Simulate: attempt 1 saved the terminal state, then the pod died before finishing the job row.
    await store.claim(job.id, 'pod-a', 60_000);
    d.deployments.set('dep-1', 'deployed');
    store.t += 61_000;
    await recoverStaleJobs(store, { deploy: d.handler }, 'pod-b');
    await flush();
    expect(d.runs).toEqual([]);
    expect(store.jobs.get(job.id)!.status).toBe('succeeded');
  });

  it('picks up queued jobs nobody claimed after the grace window', async () => {
    const store = new MemoryStore();
    const d = makeDeployHandler();
    const job = await store.create({ type: 'deploy', targetId: 'dep-1' });
    expect((await recoverStaleJobs(store, { deploy: d.handler }, 'pod-b')).resumed).toEqual([]);
    store.t += QUEUED_GRACE_MS + 1_000;
    expect((await recoverStaleJobs(store, { deploy: d.handler }, 'pod-b')).resumed).toEqual([job.id]);
    await flush();
    expect(store.jobs.get(job.id)!.status).toBe('succeeded');
  });

  it('fails jobs of an unknown type instead of looping', async () => {
    const store = new MemoryStore();
    const job = await store.create({ type: 'mystery', targetId: 'x' });
    await runJob(store, {}, job.id, 'pod-a');
    expect(store.jobs.get(job.id)!.status).toBe('failed');
  });
});
