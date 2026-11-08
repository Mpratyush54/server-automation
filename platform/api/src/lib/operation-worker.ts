import { acquireLock, LockHandle } from './locks';
import { resolveOperationStore, resumeOperations } from './operations';
import { dispatchOutbox } from './outbox';

/**
 * Background worker for operations, run by exactly one API replica at a time: the holder of
 * `lock:leader:operation-worker` (a renewed Redis lease, or a Postgres advisory lock when Redis
 * is down). When issue #19's shared leader lease lands, this can delegate to it.
 *
 * The leader:
 *  - resumes interrupted operations right after it becomes leader and every minute after that
 *    (operations whose runner died; live runs hold their own lock and are skipped)
 *  - dispatches due outbox messages every 5 s
 *  - prunes expired coordination rows hourly
 * Footprint: three timers and at most one extra DB connection (advisory-lock fallback only).
 */
export const LEADER_LOCK_KEY = 'lock:leader:operation-worker';

const LEADER_POLL_MS = 15_000;
const RESUME_EVERY_MS = 60_000;
const OUTBOX_EVERY_MS = 5_000;
const CLEANUP_EVERY_MS = 3600_000;

let leader: LockHandle | null = null;
let timers: Array<ReturnType<typeof setInterval>> = [];
let lastResume = 0;
let lastCleanup = 0;
let ticking = false;
const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

export function isOperationLeader(): boolean {
  return !!leader && !leader.lost;
}

async function leaderTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (!leader || leader.lost) {
      leader = await acquireLock(LEADER_LOCK_KEY, { holder: workerId, ttlMs: 30_000 });
      if (leader) {
        console.log(`[operations] ${workerId} is the operation worker leader`);
        lastResume = 0;
      }
    }
    if (!isOperationLeader()) return;
    const now = Date.now();
    if (now - lastResume >= RESUME_EVERY_MS) {
      lastResume = now;
      await resumeOperations();
    }
    if (now - lastCleanup >= CLEANUP_EVERY_MS) {
      lastCleanup = now;
      try {
        await (await resolveOperationStore()).cleanup();
      } catch (err: any) {
        console.warn(`[operations] cleanup failed: ${err?.message || err}`);
      }
    }
  } catch (err: any) {
    console.warn(`[operations] leader tick failed: ${err?.message || err}`);
  } finally {
    ticking = false;
  }
}

async function outboxTick(): Promise<void> {
  if (!isOperationLeader()) return;
  try {
    await dispatchOutbox();
  } catch (err: any) {
    console.warn(`[operations] outbox dispatch failed: ${err?.message || err}`);
  }
}

export function startOperationWorker(): void {
  if (timers.length) return;
  void leaderTick();
  const a = setInterval(() => { void leaderTick(); }, LEADER_POLL_MS);
  const b = setInterval(() => { void outboxTick(); }, OUTBOX_EVERY_MS);
  for (const t of [a, b]) (t as any).unref?.();
  timers = [a, b];
}

export async function stopOperationWorker(): Promise<void> {
  for (const t of timers) clearInterval(t);
  timers = [];
  if (leader) {
    const l = leader;
    leader = null;
    await l.release();
  }
}
