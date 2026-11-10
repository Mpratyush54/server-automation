/**
 * Redis Streams telemetry queue (#49): producer backpressure, consumer forwarding + ack,
 * retries, drop counting, metrics. Redis is a small in-memory streams fake.
 */
const mockProcessLogs = jest.fn(async (_docs: any[]) => {});
const mockProcessApiMetrics = jest.fn(async (_docs: any[]) => {});
const mockProcessEvent = jest.fn(async (_kind: string, _payload: any) => {});
jest.mock('../../../src/lib/telemetry-processors', () => ({
  processLogs: (d: any[]) => mockProcessLogs(d),
  processApiMetrics: (d: any[]) => mockProcessApiMetrics(d),
  processTelemetryEvent: (k: string, p: any) => mockProcessEvent(k, p),
}));

import type Redis from 'ioredis';
import { setRedisClientForTests } from '../../../src/lib/redis';
import {
  drainTelemetryQueue,
  ingestTelemetry,
  queueActive,
  renderTelemetryMetrics,
  resetTelemetryCountersForTests,
  telemetryCounters,
  telemetryQueueStats,
  TelemetryBackpressureError,
  TelemetryPayloadTooLargeError,
  TELEMETRY_GROUP,
} from '../../../src/lib/telemetry-queue';
import { queueSettings } from '../../../src/lib/telemetry-config';
import { FakeStreamRedis } from '../../helpers/fake-stream-redis';

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let fake: FakeStreamRedis;

const settings = (over: Partial<ReturnType<typeof queueSettings>> = {}) => ({ ...queueSettings(), ...over });

beforeEach(() => {
  fake = new FakeStreamRedis();
  setRedisClientForTests(fake as unknown as Redis);
  resetTelemetryCountersForTests();
  mockProcessLogs.mockReset().mockResolvedValue(undefined);
  mockProcessApiMetrics.mockReset().mockResolvedValue(undefined);
  mockProcessEvent.mockReset().mockResolvedValue(undefined);
  delete process.env.TELEMETRY_QUEUE;
  delete process.env.TELEMETRY_QUEUE_MAX_BACKLOG;
  delete process.env.TELEMETRY_QUEUE_MAX_EVENT_BYTES;
});
afterAll(() => setRedisClientForTests(null));

const log = (message: string) => ({ projectId: PID, environment: 'dev', branch: 'main', commitSha: 'x', hostname: 'h', level: 'INFO', message, fields: {}, timestamp: new Date().toISOString() });

describe('producer', () => {
  it('XADDs with MAXLEN ~ and reports queued (no processing on the request path)', async () => {
    const xadd = jest.spyOn(fake, 'xadd');
    await expect(ingestTelemetry('logs', PID, [log('a'), log('b')], 2)).resolves.toBe('queued');
    expect(xadd).toHaveBeenCalledWith(expect.stringMatching(/^plat:api:telemetry:ingest$/), 'MAXLEN', '~', '200000', '*',
      'k', 'logs', 'p', PID, 'n', '2', 'd', expect.any(String));
    expect(mockProcessLogs).not.toHaveBeenCalled();
    expect(mockProcessEvent).not.toHaveBeenCalled();
    expect(telemetryCounters().enqueued).toBe(1);
  });

  it('429-style backpressure above the backlog threshold, counted as rejected', async () => {
    process.env.TELEMETRY_QUEUE_MAX_BACKLOG = '3';
    for (let i = 0; i < 3; i++) await ingestTelemetry('logs', PID, [log(String(i))]);
    const err = await ingestTelemetry('logs', PID, [log('x')]).catch((e) => e);
    expect(err).toBeInstanceOf(TelemetryBackpressureError);
    expect(err.retryAfterSeconds).toBe(5);
    expect(fake.entries).toHaveLength(3);
    expect(telemetryCounters().rejected).toBe(1);
  });

  it('refuses oversized payloads (413) and counts them as dropped', async () => {
    process.env.TELEMETRY_QUEUE_MAX_EVENT_BYTES = '2048';
    const err = await ingestTelemetry('logs', PID, [log('x'.repeat(5000))], 1).catch((e) => e);
    expect(err).toBeInstanceOf(TelemetryPayloadTooLargeError);
    expect(telemetryCounters().dropped).toEqual({ too_large: 1 });
  });

  it('falls back to inline processing when Redis is unavailable (no loss)', async () => {
    fake.failWith = new Error('ECONNREFUSED');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ingestTelemetry('heartbeat', PID, { projectId: PID, body: {}, receivedAt: new Date().toISOString() })).resolves.toBe('processed');
    expect(mockProcessEvent).toHaveBeenCalledWith('heartbeat', expect.objectContaining({ projectId: PID }));
    expect(telemetryCounters().inline).toBe(1);
    warn.mockRestore();
  });

  it('processes inline without Redis (memory state mode) or with TELEMETRY_QUEUE=off', async () => {
    setRedisClientForTests(null); // NODE_ENV=test → memory backend
    expect(queueActive()).toBe(false);
    await expect(ingestTelemetry('api-metrics', PID, [{ route: '/' }])).resolves.toBe('processed');
    setRedisClientForTests(fake as unknown as Redis);
    process.env.TELEMETRY_QUEUE = 'off';
    await expect(ingestTelemetry('logs', PID, [log('a')])).resolves.toBe('processed');
    expect(mockProcessEvent).toHaveBeenCalledTimes(2);
    expect(fake.entries).toHaveLength(0);
  });
});

describe('consumer', () => {
  it('forwards batches per destination, then XACKs and XDELs them', async () => {
    await ingestTelemetry('logs', PID, [log('a'), log('b')], 2);
    await ingestTelemetry('logs', PID, [log('c')], 1);
    await ingestTelemetry('api-metrics', PID, [{ route: '/x' }], 1);
    await ingestTelemetry('heartbeat', PID, { projectId: PID, body: { cpuPct: 3 }, receivedAt: 'now' });

    const r = await drainTelemetryQueue('leader-1', settings());
    expect(mockProcessLogs).toHaveBeenCalledTimes(1); // both log requests in one insert
    expect(mockProcessLogs.mock.calls[0][0].map((d: any) => d.message)).toEqual(['a', 'b', 'c']);
    expect(mockProcessApiMetrics).toHaveBeenCalledWith([{ route: '/x' }]);
    expect(mockProcessEvent).toHaveBeenCalledWith('heartbeat', expect.objectContaining({ body: { cpuPct: 3 } }));
    expect(r).toEqual({ processed: 5, failed: 0, dropped: 0, reclaimed: 0 });
    expect(fake.entries).toHaveLength(0);
    expect(fake.groups.get(TELEMETRY_GROUP)!.pel.size).toBe(0);
    expect(telemetryCounters().processed).toBe(5);
  });

  it('isolates a failing event: the others are acked, the bad one stays pending and is retried', async () => {
    await ingestTelemetry('logs', PID, [log('good')], 1);
    await ingestTelemetry('logs', PID, [log('bad')], 1);
    mockProcessLogs.mockImplementationOnce(async () => { throw new Error('mongo down'); });
    mockProcessEvent.mockImplementation(async (_k, p) => { if (p[0].message === 'bad') throw new Error('still bad'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const r1 = await drainTelemetryQueue('leader-1', settings());
    expect(r1).toMatchObject({ processed: 1, failed: 1 });
    expect(fake.entries).toHaveLength(1);
    expect(fake.groups.get(TELEMETRY_GROUP)!.pel.size).toBe(1);

    // Not re-claimed before the idle threshold …
    fake.clock += 1_000;
    expect((await drainTelemetryQueue('leader-1', settings({ reclaimIdleMs: 30_000 }))).reclaimed).toBe(0);
    // … then retried; now it succeeds and is acked.
    mockProcessEvent.mockResolvedValue(undefined);
    fake.clock += 30_000;
    const r2 = await drainTelemetryQueue('leader-1', settings({ reclaimIdleMs: 30_000 }));
    expect(r2).toMatchObject({ reclaimed: 1, processed: 1 });
    expect(fake.entries).toHaveLength(0);
    expect(telemetryCounters().failedAttempts).toBe(1);
    warn.mockRestore();
  });

  it('a new leader re-claims entries a dead leader left pending', async () => {
    await ingestTelemetry('heartbeat', PID, { projectId: PID, body: {}, receivedAt: 'x' });
    // Old leader read the entry and died before acking.
    await fake.xgroup('CREATE', 'k', TELEMETRY_GROUP, '0');
    await fake.xreadgroup('GROUP', TELEMETRY_GROUP, 'old-leader', 'COUNT', 10, 'STREAMS', 'k', '>');
    fake.clock += 60_000;
    const r = await drainTelemetryQueue('new-leader', settings({ reclaimIdleMs: 30_000 }));
    expect(r).toMatchObject({ reclaimed: 1, processed: 1 });
    expect(fake.entries).toHaveLength(0);
  });

  it('drops (and counts) events that keep failing after max attempts', async () => {
    await ingestTelemetry('logs', PID, [log('poison'), log('poison2')], 2);
    mockProcessLogs.mockRejectedValue(new Error('validation'));
    mockProcessEvent.mockRejectedValue(new Error('validation'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = settings({ reclaimIdleMs: 0, maxAttempts: 3 });
    let dropped = 0;
    for (let i = 0; i < 5 && fake.entries.length > 0; i++) {
      fake.clock += 1;
      dropped += (await drainTelemetryQueue('leader-1', s)).dropped;
    }
    expect(dropped).toBe(2);
    expect(fake.entries).toHaveLength(0);
    expect(telemetryCounters().dropped).toEqual({ max_attempts: 2 });
    warn.mockRestore();
  });

  it('drops malformed entries and counts entries trimmed by MAXLEN while pending', async () => {
    await fake.xadd('k', '*', 'k', 'logs', 'p', PID, 'n', '1', 'd', '{not json');
    await fake.xadd('k', '*', 'k', 'mystery', 'p', PID, 'n', '1', 'd', '{}');
    const r = await drainTelemetryQueue('leader-1', settings());
    expect(r.processed).toBe(0);
    expect(telemetryCounters().dropped).toEqual({ malformed: 2 });

    // Pending entry trimmed away before it was acked.
    await ingestTelemetry('heartbeat', PID, { projectId: PID, body: {}, receivedAt: 'x' });
    await fake.xreadgroup('GROUP', TELEMETRY_GROUP, 'old', 'COUNT', 10, 'STREAMS', 'k', '>');
    fake.entries = [];
    fake.clock += 60_000;
    const r2 = await drainTelemetryQueue('leader-1', settings({ reclaimIdleMs: 30_000 }));
    expect(r2.dropped).toBe(1);
    expect(telemetryCounters().dropped).toEqual({ malformed: 2, trimmed: 1 });
  });

  it('stops at the time budget', async () => {
    for (let i = 0; i < 5; i++) await ingestTelemetry('heartbeat', PID, { projectId: PID, body: {}, receivedAt: 'x' });
    let t = 0;
    const r = await drainTelemetryQueue('leader-1', settings({ batchSize: 1, drainBudgetMs: 10 }), () => (t += 4));
    expect(r.processed).toBeLessThan(5);
    expect(fake.entries.length).toBeGreaterThan(0);
  });
});

describe('metrics', () => {
  it('reports depth, pending, lag and counters in Prometheus text', async () => {
    process.env.TELEMETRY_QUEUE_MAX_BACKLOG = '1';
    await ingestTelemetry('logs', PID, [log('a')]);
    await ingestTelemetry('logs', PID, [log('b')]).catch(() => {});
    const stats = await telemetryQueueStats(fake.clock + 2_500);
    expect(stats).toEqual({ depth: 1, pending: 0, lagSeconds: 2.5 });
    const text = await renderTelemetryMetrics();
    expect(text).toContain('platform_telemetry_queue_depth 1');
    expect(text).toContain('platform_telemetry_events_enqueued_total 1');
    expect(text).toContain('platform_telemetry_events_rejected_total 1');
    expect(text).toMatch(/platform_telemetry_queue_lag_seconds \d/);
  });

  it('omits the queue gauges without Redis', async () => {
    setRedisClientForTests(null);
    expect(await telemetryQueueStats()).toBeNull();
    const text = await renderTelemetryMetrics();
    expect(text).not.toContain('platform_telemetry_queue_depth');
    expect(text).toContain('platform_telemetry_events_dropped_total');
  });
});
