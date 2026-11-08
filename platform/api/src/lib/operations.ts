import crypto from 'crypto';
import { acquireLock, LockBusyError, LockHandle, getLockHolder, setLockHolderResolver } from './locks';
import {
  FencedError,
  MemoryOperationStore,
  OperationRecord,
  OperationStore,
  OutboxDraft,
  StepRecord,
  TERMINAL_STATUSES,
  TypeormOperationStore,
} from './operation-store';
import { stableHash } from './stable-hash';

/**
 * Small persisted step runner (issue #23).
 *
 * An operation is a list of named steps, each with `run` and an optional `compensate`.
 * Progress (status, current step, attempts, per-step output, working state) is written to
 * Postgres after every transition, under the operation's resource lock and fencing token.
 *
 *  - A step that throws fails the operation: completed steps are compensated in reverse order.
 *  - If the API dies, the leader worker finds the non-terminal operation on start (and every
 *    minute afterwards), takes its lock once it is free, and resumes it: steps are re-run from
 *    the one that was in flight (steps must therefore be idempotent), or compensated, depending
 *    on the definition's `resume` policy.
 *  - Side effects that must not happen before a step committed (notifications, e-mails) are
 *    emitted to the outbox with `ctx.emit()`; they are inserted in the same transaction as the
 *    step result and dispatched afterwards.
 */

export interface StepContext<S extends Record<string, unknown> = Record<string, unknown>> {
  readonly operationId: string;
  readonly projectId: string | null;
  readonly input: Record<string, unknown>;
  /** Mutable working state; persisted after each step (encrypted when the definition is sensitive). */
  readonly state: S;
  /** 1 on the first try of this step, >1 when it is re-run after a crash. */
  readonly attempt: number;
  /** True when this run picked the operation up after an interruption. */
  readonly resumed: boolean;
  /** Merge non-secret output into this step's log entry (shown in the portal). */
  setOutput(output: Record<string, unknown>): void;
  /** Queue a side effect; it is committed together with this step and dispatched afterwards. */
  emit(kind: string, payload: Record<string, unknown>): void;
}

export interface StepDefinition<S extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  run(ctx: StepContext<S>): Promise<void>;
  compensate?(ctx: StepContext<S>): Promise<void>;
  /**
   * What to do when this step was in flight when the API died:
   *  - 'rerun' (default): run it again (it must be idempotent)
   *  - 'skip': treat it as done (e.g. "restart the API" — re-running would loop forever)
   */
  onResume?: 'rerun' | 'skip';
}

export interface OperationDefinition<S extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  steps: StepDefinition<S>[];
  /** Working state holds credentials: encrypt at rest, wipe when terminal. */
  sensitive?: boolean;
  /** After an interruption: continue forward (default) or compensate completed steps. */
  resume?: 'continue' | 'compensate';
  /** Non-secret summary stored on the operation when it finishes (any outcome). */
  summarize?(state: S): Record<string, unknown> | null;
  /** Called after a failed operation was compensated (or could not be). */
  onFailed?(ctx: StepContext<S>, error: string): Promise<void>;
  /**
   * Give up (fail + compensate) when a step was already started this many times and the
   * runner died each time, so a step that crashes the API is not resumed forever (#19).
   */
  maxAttempts?: number;
}

const registry = new Map<string, OperationDefinition<any>>();

export function defineOperation<S extends Record<string, unknown>>(def: OperationDefinition<S>): OperationDefinition<S> {
  registry.set(def.type, def as OperationDefinition<any>);
  return def;
}

export function getOperationDefinition(type: string): OperationDefinition<any> | undefined {
  return registry.get(type);
}

// ── store selection ──────────────────────────────────────────────────────────
let storeOverride: OperationStore | null = null;
const memoryStore = new MemoryOperationStore();
let warnedMemoryStore = false;

/** Test hook: force a store (null restores automatic selection). */
export function setOperationStore(store: OperationStore | null): void {
  storeOverride = store;
}

/**
 * The Postgres-backed store when the platform database is usable, else the in-memory
 * fallback (progress is then not durable; a warning is logged once).
 */
export async function resolveOperationStore(): Promise<OperationStore> {
  if (storeOverride) return storeOverride;
  try {
    const { getDb } = await import('../config/database');
    const ds: any = await getDb();
    if (ds && typeof ds.transaction === 'function' && typeof ds.query === 'function' && typeof ds.createQueryBuilder === 'function') {
      return new TypeormOperationStore(async () => getDb());
    }
  } catch {}
  if (!warnedMemoryStore && process.env.NODE_ENV !== 'test') {
    warnedMemoryStore = true;
    console.warn('[operations] Postgres unavailable — operation step log kept in memory (not resumable)');
  }
  return memoryStore;
}

setLockHolderResolver(async (key) => (await resolveOperationStore()).activeIdByLockKey(key));

// ── create / run ─────────────────────────────────────────────────────────────
export interface CreateOperationOptions<S extends Record<string, unknown>> {
  /** Pre-generated id (so a lock taken before creation can name its holder). */
  id?: string;
  projectId?: string | null;
  lockKey?: string | null;
  input?: Record<string, unknown>;
  state?: S;
  createdById?: string | null;
}

export function newOperationId(): string {
  return crypto.randomUUID();
}

export async function createOperation<S extends Record<string, unknown>>(
  type: string,
  opts: CreateOperationOptions<S> = {},
): Promise<OperationRecord> {
  const def = registry.get(type);
  if (!def) throw new Error(`unknown operation type ${type}`);
  const now = new Date();
  const input = opts.input || {};
  const rec: OperationRecord = {
    id: opts.id || newOperationId(),
    type,
    projectId: opts.projectId ?? null,
    lockKey: opts.lockKey ?? null,
    lockFence: null,
    status: 'pending',
    currentStep: 0,
    inputHash: stableHash({ type, input }),
    input,
    state: (opts.state || {}) as Record<string, unknown>,
    sensitive: !!def.sensitive,
    result: null,
    error: null,
    attempts: 0,
    createdById: opts.createdById ?? null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    steps: def.steps.map((s, index): StepRecord => ({
      index, name: s.name, status: 'pending', attempts: 0, output: null, error: null, startedAt: null, finishedAt: null,
    })),
  };
  const store = await resolveOperationStore();
  await store.create(rec);
  return rec;
}

/** Operations currently being run by this process (id → promise). */
const activeRuns = new Map<string, Promise<RunResult>>();

export interface RunResult {
  operation: OperationRecord;
  /** In-memory working state at the end of this run (may contain secrets — never persist/log). */
  state: Record<string, unknown>;
}

export interface RunOptions {
  /** Lock already held by the caller (ownership passes to the runner, which releases it). */
  lock?: LockHandle;
  /** Lock TTL when the runner acquires the lock itself. */
  lockTtlMs?: number;
}

function errMessage(err: unknown): string {
  return String((err as any)?.message || err || 'unknown error').slice(0, 2000);
}

async function persist(store: OperationStore, rec: OperationRecord, fence: string, outbox: OutboxDraft[] = []): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await store.save(rec, fence, outbox);
      return;
    } catch (err) {
      if (err instanceof FencedError) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  if (outbox.length) {
    // The side effects would be lost with the step record; surface the failure.
    throw lastErr;
  }
  // Progress writes are best-effort (e.g. the platform DB is reconnecting mid secret rotation);
  // the run continues and the next successful write records the latest state.
  console.warn(`[operations] could not persist progress of ${rec.id}: ${errMessage(lastErr)}`);
}

class OperationAbort extends Error {}

/**
 * Run (or resume) an operation to a terminal state. Acquires the operation's lock unless one
 * is passed in; throws LockBusyError when another runner holds it.
 */
export async function runOperation(id: string, opts: RunOptions = {}): Promise<RunResult> {
  const existing = activeRuns.get(id);
  if (existing) {
    await opts.lock?.release();
    return existing;
  }
  const p = runOperationInner(id, opts).finally(() => activeRuns.delete(id));
  activeRuns.set(id, p);
  return p;
}

async function runOperationInner(id: string, opts: RunOptions): Promise<RunResult> {
  const store = await resolveOperationStore();
  const initial = await store.get(id);
  if (!initial) {
    await opts.lock?.release();
    throw new Error(`operation ${id} not found`);
  }
  const def = registry.get(initial.type);
  if (!def) {
    await opts.lock?.release();
    throw new Error(`unknown operation type ${initial.type}`);
  }
  if (TERMINAL_STATUSES.has(initial.status)) {
    await opts.lock?.release();
    return { operation: initial, state: initial.state };
  }

  const lockKey = initial.lockKey || `lock:operation:${id}`;
  let lock = opts.lock;
  if (!lock) {
    lock = (await acquireLock(lockKey, { holder: id, ttlMs: opts.lockTtlMs })) || undefined;
    if (!lock) throw new LockBusyError(lockKey, await getLockHolder(lockKey));
  }

  try {
    const claimed = await store.claim(id, lock.fence);
    if (!claimed) throw new Error(`operation ${id} disappeared`);
    const rec = claimed;
    const fence = lock.fence;
    const resumed = rec.attempts > 1;
    const state = rec.state as Record<string, unknown>;

    const makeCtx = (step: StepRecord, outbox: OutboxDraft[]): StepContext<any> => ({
      operationId: rec.id,
      projectId: rec.projectId,
      input: rec.input || {},
      state,
      attempt: step.attempts,
      resumed,
      setOutput(output) { step.output = { ...(step.output || {}), ...output }; },
      emit(kind, payload) { outbox.push({ kind, payload }); },
    });

    const finish = async (status: OperationRecord['status'], error: string | null) => {
      rec.status = status;
      rec.error = error;
      rec.finishedAt = new Date();
      try { rec.result = def.summarize ? def.summarize(state as any) : null; } catch { rec.result = null; }
      rec.state = state;
      await persist(store, rec, fence);
    };

    const compensate = async (failure: string) => {
      rec.status = 'compensating';
      await persist(store, rec, fence);
      let compensationError: string | null = null;
      let compensated = false;
      for (let j = rec.steps.length - 1; j >= 0; j--) {
        const sr = rec.steps[j];
        const step = def.steps[j];
        if (!step?.compensate || (sr.status !== 'succeeded' && sr.status !== 'compensating')) continue;
        if (lock!.lost) throw new OperationAbort('lock lost during compensation');
        sr.status = 'compensating';
        await persist(store, rec, fence);
        const outbox: OutboxDraft[] = [];
        try {
          await step.compensate(makeCtx(sr, outbox));
          sr.status = 'compensated';
          compensated = true;
          rec.state = state;
          await persist(store, rec, fence, outbox);
        } catch (err) {
          if (err instanceof FencedError) throw err;
          compensationError = `compensation of ${sr.name} failed: ${errMessage(err)}`;
          sr.status = 'failed';
          sr.error = compensationError;
          await persist(store, rec, fence);
          break;
        }
      }
      const summary = compensationError ? `${failure}; ${compensationError}` : failure;
      await finish(compensationError || !compensated ? 'failed' : 'compensated', summary);
      if (def.onFailed) {
        try {
          const dummy: StepRecord = { index: -1, name: 'on-failed', status: 'running', attempts: 1, output: null, error: null, startedAt: null, finishedAt: null };
          const outbox: OutboxDraft[] = [];
          await def.onFailed(makeCtx(dummy, outbox), summary);
          if (outbox.length) await store.enqueueOutbox(rec.id, outbox);
        } catch (err) {
          console.warn(`[operations] onFailed hook for ${rec.id} failed: ${errMessage(err)}`);
        }
      }
    };

    if (rec.status === 'compensating' || (resumed && def.resume === 'compensate')) {
      await compensate(rec.error || 'interrupted; compensating after restart');
    } else {
      rec.status = 'running';
      await persist(store, rec, fence);
      let failed: string | null = null;
      for (let i = rec.currentStep; i < def.steps.length; i++) {
        const step = def.steps[i];
        const sr = rec.steps[i];
        if (sr.status === 'succeeded' || sr.status === 'skipped') continue;
        if (lock.lost) throw new OperationAbort('lock lost');
        if (resumed && sr.status === 'running' && step.onResume === 'skip') {
          sr.status = 'skipped';
          sr.finishedAt = new Date();
          sr.output = { ...(sr.output || {}), note: 'started before an API restart; not repeated' };
          rec.currentStep = i + 1;
          await persist(store, rec, fence);
          continue;
        }
        if (resumed && def.maxAttempts && sr.attempts >= def.maxAttempts) {
          failed = `${step.name}: gave up after ${sr.attempts} interrupted attempt(s)`;
          sr.status = 'failed';
          sr.error = failed;
          sr.finishedAt = new Date();
          rec.state = state;
          await persist(store, rec, fence);
          break;
        }
        sr.status = 'running';
        sr.attempts += 1;
        sr.error = null;
        sr.startedAt = new Date();
        rec.currentStep = i;
        rec.state = state;
        await persist(store, rec, fence);

        const outbox: OutboxDraft[] = [];
        try {
          await step.run(makeCtx(sr, outbox));
        } catch (err) {
          if (err instanceof FencedError) throw err;
          failed = `${step.name}: ${errMessage(err)}`;
          sr.status = 'failed';
          sr.error = errMessage(err);
          sr.finishedAt = new Date();
          rec.state = state;
          await persist(store, rec, fence);
          break;
        }
        sr.status = 'succeeded';
        sr.finishedAt = new Date();
        rec.currentStep = i + 1;
        rec.state = state;
        await persist(store, rec, fence, outbox);
      }
      if (failed) await compensate(failed);
      else await finish('succeeded', null);
    }

    // Deliver this operation's side effects now (best effort; the leader retries leftovers).
    try {
      const { dispatchOutbox } = await import('./outbox');
      await dispatchOutbox({ operationId: rec.id });
    } catch {}

    return { operation: (await store.get(rec.id)) || rec, state };
  } catch (err) {
    if (err instanceof FencedError || err instanceof OperationAbort) {
      console.warn(`[operations] run of ${id} stopped: ${errMessage(err)}`);
      const current = await store.get(id);
      return { operation: current || initial, state: current?.state || {} };
    }
    throw err;
  } finally {
    await lock.release();
  }
}

/**
 * Create and run an operation in one go, holding `lock` (if given) for the whole run.
 */
export async function executeOperation<S extends Record<string, unknown>>(
  type: string,
  opts: CreateOperationOptions<S> & { lock?: LockHandle },
): Promise<RunResult> {
  let rec: OperationRecord;
  try {
    rec = await createOperation(type, opts);
  } catch (err) {
    await opts.lock?.release();
    throw err;
  }
  return runOperation(rec.id, { lock: opts.lock });
}

export async function getOperation(id: string): Promise<OperationRecord | null> {
  return (await resolveOperationStore()).get(id);
}

/** Public (non-secret) view of an operation for the API. */
export function publicOperation(rec: OperationRecord): Record<string, unknown> {
  const total = rec.steps.length;
  const done = rec.steps.filter((s) => ['succeeded', 'skipped', 'compensated'].includes(s.status)).length;
  return {
    id: rec.id,
    type: rec.type,
    projectId: rec.projectId,
    status: rec.status,
    currentStep: rec.currentStep,
    currentStepName: rec.steps[rec.currentStep]?.name ?? null,
    progress: total ? Math.round((done / total) * 100) : 100,
    attempts: rec.attempts,
    inputHash: rec.inputHash,
    input: rec.sensitive ? null : rec.input,
    result: rec.result,
    error: rec.error,
    createdById: rec.createdById,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    finishedAt: rec.finishedAt,
    steps: rec.steps.map((s) => ({
      index: s.index, name: s.name, status: s.status, attempts: s.attempts,
      output: s.output, error: s.error, startedAt: s.startedAt, finishedAt: s.finishedAt,
    })),
  };
}

// ── resume (leader only) ─────────────────────────────────────────────────────
/**
 * Resume every non-terminal operation whose lock is free (i.e. its runner died).
 * Safe to call from several replicas: each run takes the operation lock first.
 */
export async function resumeOperations(): Promise<{ resumed: string[]; busy: string[] }> {
  const store = await resolveOperationStore();
  const resumed: string[] = [];
  const busy: string[] = [];
  let pending: OperationRecord[] = [];
  try {
    pending = await store.listNonTerminal();
  } catch (err) {
    console.warn(`[operations] cannot list operations to resume: ${errMessage(err)}`);
    return { resumed, busy };
  }
  for (const op of pending) {
    if (activeRuns.has(op.id) || !registry.has(op.type)) continue;
    // A held lock means a live runner (here or on another replica) still owns the operation.
    const lock = await acquireLock(op.lockKey || `lock:operation:${op.id}`, { holder: op.id });
    if (!lock) {
      busy.push(op.id);
      continue;
    }
    resumed.push(op.id);
    void runOperation(op.id, { lock }).catch((err) => {
      console.warn(`[operations] resume of ${op.id} failed: ${errMessage(err)}`);
    });
  }
  if (resumed.length) console.log(`[operations] resuming ${resumed.length} interrupted operation(s)`);
  return { resumed, busy };
}

/** Test helper: wait for all in-process runs to settle. */
export async function waitForActiveRuns(): Promise<void> {
  await Promise.allSettled([...activeRuns.values()]);
}
