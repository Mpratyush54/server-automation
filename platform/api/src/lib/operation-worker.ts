import { isLeader } from './leader';
import { registerLeaderJob, unregisterLeaderJob } from './scheduler';
import { resolveOperationStore, resumeOperations } from './operations';
import { dispatchOutbox } from './outbox';

/**
 * Background work for operations (issue #23), run only by the replica holding the
 * `platform-api-leader` Lease (issue #19, lib/leader.ts) through the shared leader-job
 * scheduler — there is no second leader mechanism. Each job's timer exists only while this
 * replica is the leader and is cleared on loss; each can move to a CronJob via JOBS_EXTERNAL.
 *
 *  - operation-resume   right after takeover and every minute: resume non-terminal operations
 *                       whose lock is free (their runner died; live runs hold their own lock)
 *  - outbox-dispatch    every 5 s: deliver due outbox messages (at least once, with backoff)
 *  - operation-cleanup  hourly: prune expired idempotency keys, webhook deliveries, outbox rows
 */
export const OPERATION_RESUME_JOB = 'operation-resume';
export const OUTBOX_DISPATCH_JOB = 'outbox-dispatch';
export const OPERATION_CLEANUP_JOB = 'operation-cleanup';

const RESUME_EVERY_MS = 60_000;
const OUTBOX_EVERY_MS = 5_000;
const CLEANUP_EVERY_MS = 3600_000;

/** True on the lease leader (the replica that runs the operation worker). */
export function isOperationLeader(): boolean {
  return isLeader();
}

export async function runOperationResume(): Promise<void> {
  await resumeOperations();
}

export async function runOutboxDispatch(): Promise<void> {
  await dispatchOutbox();
}

export async function runOperationCleanup(): Promise<void> {
  await (await resolveOperationStore()).cleanup();
}

export function startOperationWorker(): void {
  registerLeaderJob({
    name: OPERATION_RESUME_JOB,
    intervalMs: RESUME_EVERY_MS,
    initialDelayMs: 1_000, // pick up interrupted operations right after takeover
    run: runOperationResume,
  });
  registerLeaderJob({
    name: OUTBOX_DISPATCH_JOB,
    intervalMs: OUTBOX_EVERY_MS,
    initialDelayMs: OUTBOX_EVERY_MS,
    run: runOutboxDispatch,
  });
  registerLeaderJob({
    name: OPERATION_CLEANUP_JOB,
    intervalMs: CLEANUP_EVERY_MS,
    initialDelayMs: 60_000,
    run: runOperationCleanup,
  });
}

export function stopOperationWorker(): void {
  for (const name of [OPERATION_RESUME_JOB, OUTBOX_DISPATCH_JOB, OPERATION_CLEANUP_JOB]) unregisterLeaderJob(name);
}
