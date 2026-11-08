/**
 * Step runner (lib/operations): ordered execution, failure injection at every step with
 * reverse compensation, resume after an interruption, skip-on-resume steps, fencing, outbox.
 */
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue({ getRepository: () => ({}) }),
}));

import {
  createOperation,
  defineOperation,
  publicOperation,
  resumeOperations,
  runOperation,
  setOperationStore,
  waitForActiveRuns,
  executeOperation,
} from '../../../src/lib/operations';
import { FencedError, MemoryOperationStore } from '../../../src/lib/operation-store';
import { acquireLock, resetMemoryLocksForTests } from '../../../src/lib/locks';
import { setCoordinationRedisForTests } from '../../../src/lib/coord-redis';
import { registerOutboxHandler } from '../../../src/lib/outbox';

let store: MemoryOperationStore;
const calls: string[] = [];
let failAt: string | null = null;
let failCompensationAt: string | null = null;

function step(name: string, opts: { compensate?: boolean; onResume?: 'rerun' | 'skip' } = {}) {
  return {
    name,
    onResume: opts.onResume,
    async run(ctx: any) {
      calls.push(`run:${name}:${ctx.attempt}${ctx.resumed ? ':resumed' : ''}`);
      ctx.state.done = [...(ctx.state.done || []), name];
      ctx.setOutput({ ran: true });
      ctx.emit('test.side-effect', { step: name });
      if (failAt === name) throw new Error(`boom at ${name}`);
    },
    compensate: opts.compensate === false ? undefined : async (ctx: any) => {
      calls.push(`undo:${name}`);
      if (failCompensationAt === name) throw new Error(`undo failed at ${name}`);
      ctx.state.undone = [...(ctx.state.undone || []), name];
    },
  };
}

defineOperation({
  type: 'test.three-steps',
  steps: [step('a'), step('b'), step('c')],
  summarize: (s: any) => ({ done: s.done || [], undone: s.undone || [] }),
});

defineOperation({
  type: 'test.skip-on-resume',
  steps: [step('a'), step('restart', { onResume: 'skip', compensate: false }), step('c')],
});

defineOperation({
  type: 'test.compensate-on-resume',
  resume: 'compensate',
  steps: [step('a'), step('b')],
});

let failedHook: string[] = [];
defineOperation({
  type: 'test.no-compensation',
  steps: [step('x', { compensate: false }), step('y', { compensate: false })],
  async onFailed(ctx, error) {
    failedHook.push(error);
    ctx.emit('test.failed', { error });
  },
});

defineOperation({
  type: 'test.sensitive',
  sensitive: true,
  steps: [step('only', { compensate: false })],
});

const delivered: Array<Record<string, unknown>> = [];
registerOutboxHandler('test.side-effect', async (p) => { delivered.push(p); });
registerOutboxHandler('test.failed', async (p) => { delivered.push(p); });

beforeEach(() => {
  store = new MemoryOperationStore();
  setOperationStore(store);
  setCoordinationRedisForTests(null);
  resetMemoryLocksForTests();
  calls.length = 0;
  delivered.length = 0;
  failedHook = [];
  failAt = null;
  failCompensationAt = null;
});

describe('happy path', () => {
  it('runs steps in order, persists each, and delivers the outbox after commit', async () => {
    const { operation, state } = await executeOperation('test.three-steps', { input: { x: 1 }, projectId: 'p1' });
    expect(calls).toEqual(['run:a:1', 'run:b:1', 'run:c:1']);
    expect(operation.status).toBe('succeeded');
    expect(operation.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(operation.currentStep).toBe(3);
    expect(operation.attempts).toBe(1);
    expect(operation.result).toEqual({ done: ['a', 'b', 'c'], undone: [] });
    expect(operation.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.done).toEqual(['a', 'b', 'c']);
    expect(delivered.map((d) => d.step)).toEqual(['a', 'b', 'c']);
    expect(store.outboxSnapshot().every((m) => m.status === 'sent')).toBe(true);
    const pub: any = publicOperation(operation);
    expect(pub.progress).toBe(100);
    expect(pub.steps[0].output).toEqual({ ran: true });
  });

  it('releases the operation lock when done', async () => {
    await executeOperation('test.three-steps', { lockKey: 'lock:project:p1:deploy:e1' });
    const again = await acquireLock('lock:project:p1:deploy:e1', { holder: 'next' });
    expect(again).not.toBeNull();
    await again!.release();
  });
});

describe('failure injection at each step', () => {
  it.each([
    ['a', ['run:a:1'], []],
    ['b', ['run:a:1', 'run:b:1', 'undo:a'], ['a']],
    ['c', ['run:a:1', 'run:b:1', 'run:c:1', 'undo:b', 'undo:a'], ['b', 'a']],
  ])('failure at %s compensates completed steps in reverse', async (at, expectedCalls, undone) => {
    failAt = at as string;
    const { operation } = await executeOperation('test.three-steps', {});
    expect(calls).toEqual(expectedCalls);
    expect(operation.status).toBe(at === 'a' ? 'failed' : 'compensated');
    expect(operation.error).toContain(`boom at ${at}`);
    const failed = operation.steps.find((s) => s.name === at)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain(`boom at ${at}`);
    for (const u of undone as string[]) {
      expect(operation.steps.find((s) => s.name === u)!.status).toBe('compensated');
    }
    // side effects of the failed step are never committed
    expect(delivered.map((d) => d.step)).not.toContain(at);
  });

  it('a failing compensation leaves the operation failed with both errors', async () => {
    failAt = 'c';
    failCompensationAt = 'b';
    const { operation } = await executeOperation('test.three-steps', {});
    expect(calls).toEqual(['run:a:1', 'run:b:1', 'run:c:1', 'undo:b']);
    expect(operation.status).toBe('failed');
    expect(operation.error).toContain('boom at c');
    expect(operation.error).toContain('undo failed at b');
  });

  it('calls onFailed once and dispatches its outbox messages', async () => {
    failAt = 'y';
    const { operation } = await executeOperation('test.no-compensation', {});
    expect(operation.status).toBe('failed');
    expect(failedHook).toHaveLength(1);
    expect(delivered.some((d) => String(d.error).includes('boom at y'))).toBe(true);
  });
});

describe('resume after an interruption', () => {
  /** Simulate a crash: the step at `index` was in flight when the process died. */
  async function crashedAt(type: string, index: number) {
    const rec = await createOperation(type, { lockKey: `lock:test:${type}` });
    await store.claim(rec.id, 'm:dead-runner');
    const cur = (await store.get(rec.id))!;
    cur.status = 'running';
    cur.currentStep = index;
    for (let i = 0; i < index; i++) cur.steps[i].status = 'succeeded';
    cur.steps[index].status = 'running';
    cur.steps[index].attempts = 1;
    cur.state = { done: cur.steps.slice(0, index).map((s) => s.name) };
    await store.save(cur, 'm:dead-runner');
    return rec.id;
  }

  it('re-runs the in-flight step and continues', async () => {
    const id = await crashedAt('test.three-steps', 1);
    const { resumed } = await resumeOperations();
    expect(resumed).toEqual([id]);
    await waitForActiveRuns();
    const op = (await store.get(id))!;
    expect(calls).toEqual(['run:b:2:resumed', 'run:c:1:resumed']);
    expect(op.status).toBe('succeeded');
    expect(op.attempts).toBe(2);
    expect(op.result).toEqual({ done: ['a', 'b', 'c'], undone: [] });
  });

  it('does not resume an operation whose lock is still held by a live runner', async () => {
    const id = await crashedAt('test.three-steps', 1);
    const live = await acquireLock('lock:test:test.three-steps', { holder: id });
    const { resumed, busy } = await resumeOperations();
    expect(resumed).toEqual([]);
    expect(busy).toEqual([id]);
    expect(calls).toEqual([]);
    await live!.release();
  });

  it("marks an in-flight 'skip' step as skipped instead of repeating it", async () => {
    const id = await crashedAt('test.skip-on-resume', 1);
    await runOperation(id);
    const op = (await store.get(id))!;
    expect(calls).toEqual(['run:c:1:resumed']);
    expect(op.steps[1].status).toBe('skipped');
    expect(op.status).toBe('succeeded');
  });

  it("compensates completed steps when the definition's resume policy is 'compensate'", async () => {
    const id = await crashedAt('test.compensate-on-resume', 1);
    await runOperation(id);
    const op = (await store.get(id))!;
    expect(calls).toEqual(['undo:a']);
    expect(op.status).toBe('compensated');
  });

  it('continues an interrupted compensation', async () => {
    const id = await crashedAt('test.three-steps', 2);
    const cur = (await store.get(id))!;
    cur.status = 'compensating';
    cur.steps[2].status = 'failed';
    cur.steps[1].status = 'compensated';
    cur.error = 'boom at c';
    await store.save(cur, 'm:dead-runner');
    await runOperation(id);
    const op = (await store.get(id))!;
    expect(calls).toEqual(['undo:a']);
    expect(op.status).toBe('compensated');
  });
});

describe('fencing', () => {
  it('a stale runner cannot write after another runner claimed the operation', async () => {
    const rec = await createOperation('test.three-steps', {});
    await store.claim(rec.id, 'm:old');
    await store.claim(rec.id, 'm:new');
    const cur = (await store.get(rec.id))!;
    cur.status = 'failed';
    await expect(store.save(cur, 'm:old')).rejects.toBeInstanceOf(FencedError);
    expect((await store.get(rec.id))!.status).toBe('pending');
  });
});

describe('sensitive state', () => {
  it('is wiped once the operation is terminal', async () => {
    const { operation, state } = await executeOperation('test.sensitive', { state: { password: 's3cret' } as any });
    expect(state.password).toBe('s3cret'); // returned to the caller in memory
    expect(operation.state).toEqual({});
    expect(publicOperation(operation).input).toBeNull();
  });
});
