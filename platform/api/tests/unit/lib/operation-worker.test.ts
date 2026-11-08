/**
 * The operation worker (#23) runs on the platform-api-leader Lease (#19) through the shared
 * leader-job scheduler: no separate `lock:leader:*` key, timers only while leader.
 */
const resumeOperations = jest.fn().mockResolvedValue({ resumed: [], busy: [] });
const cleanup = jest.fn().mockResolvedValue(undefined);
const dispatchOutbox = jest.fn().mockResolvedValue(0);
const acquireLock = jest.fn();

jest.mock('../../../src/lib/operations', () => ({
  resumeOperations: (...a: unknown[]) => resumeOperations(...a),
  resolveOperationStore: async () => ({ cleanup }),
}));
jest.mock('../../../src/lib/outbox', () => ({ dispatchOutbox: (...a: unknown[]) => dispatchOutbox(...a) }));
jest.mock('../../../src/lib/locks', () => ({ acquireLock: (...a: unknown[]) => acquireLock(...a) }));

import { LeadershipListener, setLeadershipForTests } from '../../../src/lib/leader';
import { isJobTimerActive, unregisterAllJobs } from '../../../src/lib/scheduler';
import {
  OPERATION_CLEANUP_JOB, OPERATION_RESUME_JOB, OUTBOX_DISPATCH_JOB,
  isOperationLeader, startOperationWorker, stopOperationWorker,
} from '../../../src/lib/operation-worker';

class ManualLeader {
  private leader = false;
  private listeners = new Set<LeadershipListener>();
  isLeader() { return this.leader; }
  onLeadershipChange(fn: LeadershipListener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  start() {}
  async stop() {}
  set(v: boolean) { this.leader = v; for (const fn of this.listeners) fn(v); }
}

describe('operation worker on the leader lease', () => {
  let leader: ManualLeader;
  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.JOBS_EXTERNAL;
    leader = new ManualLeader();
    setLeadershipForTests(leader as any);
    resumeOperations.mockClear();
    cleanup.mockClear();
    dispatchOutbox.mockClear();
    acquireLock.mockClear();
  });
  afterEach(() => {
    stopOperationWorker();
    unregisterAllJobs();
    setLeadershipForTests(null);
    jest.useRealTimers();
  });

  it('does nothing on a follower', async () => {
    startOperationWorker();
    await jest.advanceTimersByTimeAsync(2 * 3600_000);
    expect(isOperationLeader()).toBe(false);
    expect(resumeOperations).not.toHaveBeenCalled();
    expect(dispatchOutbox).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('resumes right after takeover, dispatches the outbox and prunes while leader', async () => {
    startOperationWorker();
    leader.set(true);
    expect(isOperationLeader()).toBe(true);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(resumeOperations).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(resumeOperations).toHaveBeenCalledTimes(2);
    expect(dispatchOutbox.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('stops every timer when leadership is lost', async () => {
    startOperationWorker();
    leader.set(true);
    await jest.advanceTimersByTimeAsync(61_000);
    leader.set(false);
    for (const job of [OPERATION_RESUME_JOB, OUTBOX_DISPATCH_JOB, OPERATION_CLEANUP_JOB]) {
      expect(isJobTimerActive(job)).toBe(false);
    }
    const calls = [resumeOperations.mock.calls.length, dispatchOutbox.mock.calls.length];
    await jest.advanceTimersByTimeAsync(3600_000);
    expect([resumeOperations.mock.calls.length, dispatchOutbox.mock.calls.length]).toEqual(calls);
  });

  it('never takes a lock of its own for leadership', async () => {
    startOperationWorker();
    leader.set(true);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(acquireLock).not.toHaveBeenCalled();
  });
});
