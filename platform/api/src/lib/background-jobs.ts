import os from 'os';
import { BackgroundJob, BackgroundJobStatus } from '../entities/BackgroundJob';
import { recordJobRun } from './job-metrics';

/**
 * Durable, resumable background work.
 *
 * - `enqueueAndRun` persists a job row, then the accepting replica claims it
 *   (atomic conditional UPDATE) and runs it, renewing a lock while it works.
 * - `recoverStaleJobs` runs on the leader: jobs whose lock lapsed (their
 *   replica died or restarted) are claimed and re-run, or failed once
 *   `maxAttempts` is reached. Handlers must therefore be idempotent.
 */

export const JOB_LOCK_MS = 60_000;
/** Queued jobs nobody claimed within this window are picked up by recovery. */
export const QUEUED_GRACE_MS = 30_000;

export interface JobStore {
  create(input: { type: string; targetId: string; payload?: Record<string, unknown> | null; maxAttempts?: number }): Promise<BackgroundJob>;
  /** Atomically take ownership (queued, or running with a lapsed lock). Increments attempts. */
  claim(id: string, owner: string, lockMs: number): Promise<BackgroundJob | null>;
  heartbeat(id: string, owner: string, lockMs: number, step?: string): Promise<boolean>;
  finish(id: string, owner: string, status: Extract<BackgroundJobStatus, 'succeeded' | 'failed'>, error?: string | null): Promise<void>;
  /** Non-terminal jobs whose lock lapsed (or that were never claimed within the grace window). */
  findStale(): Promise<BackgroundJob[]>;
  /** Fail a non-terminal job that nobody holds. Returns true when this call failed it. */
  failUnowned(id: string, error: string): Promise<boolean>;
}

export interface JobContext {
  /** Record progress; also renews the lock. */
  setStep(step: string): Promise<void>;
  attempt: number;
}

export interface JobHandler {
  run(job: BackgroundJob, ctx: JobContext): Promise<void>;
  /** True when the target already reached a terminal state (skip re-running on resume). */
  isComplete?(job: BackgroundJob): Promise<boolean>;
  /** Called once when the job is failed for good; must leave the target in a terminal state. */
  onGiveUp(job: BackgroundJob, reason: string): Promise<void>;
}

export function workerIdentity(): string {
  return `${process.env.POD_NAME || process.env.HOSTNAME || os.hostname()}:${process.pid}`;
}

/** Claim and run one job. Returns false when another replica owns it. */
export async function runJob(
  store: JobStore,
  handlers: Record<string, JobHandler>,
  jobId: string,
  owner: string = workerIdentity(),
  lockMs: number = JOB_LOCK_MS,
): Promise<boolean> {
  const job = await store.claim(jobId, owner, lockMs);
  if (!job) return false;
  const handler = handlers[job.type];
  const metric = `job-${job.type}`;
  if (!handler) {
    await store.finish(job.id, owner, 'failed', `no handler for job type ${job.type}`);
    recordJobRun(metric, 'failure');
    return true;
  }

  const beat = setInterval(() => {
    store.heartbeat(job.id, owner, lockMs).catch(() => {});
  }, Math.max(1_000, Math.floor(lockMs / 3)));
  beat.unref?.();

  try {
    if (job.attempts > 1 && handler.isComplete && (await handler.isComplete(job))) {
      await store.finish(job.id, owner, 'succeeded', null);
      recordJobRun(metric, 'skipped');
      return true;
    }
    if (job.attempts > 1) console.log(`[jobs] resuming ${job.type} job ${job.id} (attempt ${job.attempts}/${job.maxAttempts})`);
    await handler.run(job, {
      attempt: job.attempts,
      setStep: async (step) => {
        await store.heartbeat(job.id, owner, lockMs, step);
      },
    });
    await store.finish(job.id, owner, 'succeeded', null);
    recordJobRun(metric, 'success');
  } catch (err: any) {
    const reason = err?.message || String(err);
    console.error(`[jobs] ${job.type} job ${job.id} failed: ${reason}`);
    try {
      await handler.onGiveUp(job, reason);
    } finally {
      await store.finish(job.id, owner, 'failed', reason);
      recordJobRun(metric, 'failure');
    }
  } finally {
    clearInterval(beat);
  }
  return true;
}

/** Persist a job and start it in this process without blocking the caller. */
export async function enqueueAndRun(
  store: JobStore,
  handlers: Record<string, JobHandler>,
  input: { type: string; targetId: string; payload?: Record<string, unknown> | null; maxAttempts?: number },
): Promise<BackgroundJob> {
  const job = await store.create(input);
  setImmediate(() => {
    runJob(store, handlers, job.id).catch((err) => {
      console.error(`[jobs] could not start ${job.type} job ${job.id}: ${err?.message || err}`);
    });
  });
  return job;
}

/**
 * Leader-only: resume or fail jobs abandoned by a dead replica. Re-running is
 * started concurrently and not awaited, so one long rollout does not delay
 * the next sweep. Returns the number of jobs acted on.
 */
export async function recoverStaleJobs(
  store: JobStore,
  handlers: Record<string, JobHandler>,
  owner: string = workerIdentity(),
  lockMs: number = JOB_LOCK_MS,
): Promise<{ resumed: string[]; failed: string[] }> {
  const resumed: string[] = [];
  const failed: string[] = [];
  for (const job of await store.findStale()) {
    if (job.attempts >= job.maxAttempts) {
      const reason = `interrupted: API restarted during ${job.step} after ${job.attempts} attempt(s)`;
      if (await store.failUnowned(job.id, reason)) {
        failed.push(job.id);
        const handler = handlers[job.type];
        if (handler) {
          await handler.onGiveUp(job, reason).catch((err) => {
            console.error(`[jobs] give-up hook for ${job.id} failed: ${err?.message || err}`);
          });
        }
        recordJobRun(`job-${job.type}`, 'failure');
        console.warn(`[jobs] ${job.type} job ${job.id} failed: ${reason}`);
      }
      continue;
    }
    resumed.push(job.id);
    runJob(store, handlers, job.id, owner, lockMs).catch((err) => {
      console.error(`[jobs] resume of ${job.id} failed: ${err?.message || err}`);
    });
  }
  return { resumed, failed };
}

/** TypeORM-backed store. Lock times use the database clock so replicas agree. */
export function typeormJobStore(getRepo: () => Promise<import('typeorm').Repository<BackgroundJob>>): JobStore {
  const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
  const lockExpr = (ms: number) => () => `now() + make_interval(secs => ${secs(ms)})`;
  return {
    async create(input) {
      const repo = await getRepo();
      return repo.save(repo.create({
        type: input.type,
        targetId: input.targetId,
        payload: input.payload ?? null,
        maxAttempts: input.maxAttempts ?? 2,
        status: 'queued',
        step: 'queued',
        attempts: 0,
      }));
    },
    async claim(id, owner, lockMs) {
      const repo = await getRepo();
      const res = await repo.createQueryBuilder()
        .update(BackgroundJob)
        .set({ status: 'running', lockedBy: owner, lockedUntil: lockExpr(lockMs) as any, attempts: (() => 'attempts + 1') as any })
        .where('id = :id', { id })
        .andWhere(`(status = 'queued' OR (status = 'running' AND (locked_until IS NULL OR locked_until < now())))`)
        .andWhere('attempts < max_attempts')
        .execute();
      if (!res.affected) return null;
      return repo.findOne({ where: { id } });
    },
    async heartbeat(id, owner, lockMs, step) {
      const repo = await getRepo();
      const set: Record<string, unknown> = { lockedUntil: lockExpr(lockMs) };
      if (step) set.step = step;
      const res = await repo.createQueryBuilder()
        .update(BackgroundJob)
        .set(set as any)
        .where('id = :id AND locked_by = :owner AND status = :running', { id, owner, running: 'running' })
        .execute();
      return !!res.affected;
    },
    async finish(id, owner, status, error) {
      const repo = await getRepo();
      await repo.createQueryBuilder()
        .update(BackgroundJob)
        .set({ status, lastError: error ?? null, lockedUntil: null, finishedAt: (() => 'now()') as any })
        .where('id = :id AND locked_by = :owner', { id, owner })
        .execute();
    },
    async findStale() {
      const repo = await getRepo();
      return repo.createQueryBuilder('j')
        .where(`j.status IN ('queued', 'running')`)
        .andWhere(`((j.lockedUntil IS NULL AND j.createdAt < now() - make_interval(secs => ${secs(QUEUED_GRACE_MS)})) OR j.lockedUntil < now())`)
        .orderBy('j.createdAt', 'ASC')
        .limit(50)
        .getMany();
    },
    async failUnowned(id, error) {
      const repo = await getRepo();
      const res = await repo.createQueryBuilder()
        .update(BackgroundJob)
        .set({ status: 'failed', lastError: error, lockedUntil: null, finishedAt: (() => 'now()') as any })
        .where('id = :id', { id })
        .andWhere(`status IN ('queued', 'running')`)
        .andWhere('(locked_until IS NULL OR locked_until < now())')
        .execute();
      return !!res.affected;
    },
  };
}
