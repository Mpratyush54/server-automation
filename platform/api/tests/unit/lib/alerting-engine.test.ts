/**
 * Alerting engine (#43): incident lifecycle with dedupe/resolve, silences, routing and
 * escalation (incl. on-call), delivery retry, the ALERT_EVENTS_STREAM consumer (ack/retry),
 * the API evaluator, and the acceptance flows:
 *  - a firing monitor sends ONE deduplicated Slack + webhook notification, then a resolution
 *  - a silence suppresses notifications for its duration
 *  - an SLO burn alert fires on (synthetic) error injection
 */
import type Redis from 'ioredis';
import { MemoryRepo } from '../../helpers/memory-repo';
import { FakeStreamRedis } from '../../helpers/fake-stream-redis';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}
jest.mock('../../../src/config/database', () => ({
  getDb: async () => ({ getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name) }),
}));
const mockNotifyUser = jest.fn(async (_p: any) => {});
jest.mock('../../../src/lib/notify', () => ({ notifyUser: (p: any) => mockNotifyUser(p) }));

import { setRedisClientForTests } from '../../../src/lib/redis';
import { ALERT_EVENTS_STREAM, AlertEvent, publishAlertEvent } from '../../../src/lib/alert-events';
import {
  processAlertEvent, dispatchDeliveries, runEscalations, acknowledgeIncident, resolveIncident, currentOncall,
  silenceMatches, validateMatchers, validateSteps, normalizeEvent, retryDelayMs,
} from '../../../src/lib/alerting-engine';
import { drainAlertEvents, ALERT_EVENTS_GROUP } from '../../../src/lib/alerting-consumer';
import { evaluateMonitor, evaluateSlo, parseQueryResult, runEvaluation, QueryFn } from '../../../src/lib/alerting-evaluator';
import { encryptChannelSecrets, HttpRequest, verifyWebhookSignature } from '../../../src/lib/alerting-channels';
import { alertingSettings } from '../../../src/lib/alerting-config';

process.env.SECRETS_ENCRYPTION_KEY = 'test-key-for-alerting-engine';

const PID = '11111111-1111-4111-8111-111111111111';
const SLACK = '22222222-0000-4000-8000-000000000001';
const HOOK = '22222222-0000-4000-8000-000000000002';
const PAGER = '22222222-0000-4000-8000-000000000003';
const USER_A = '33333333-0000-4000-8000-00000000000a';
const USER_B = '33333333-0000-4000-8000-00000000000b';
const T0 = new Date('2026-03-01T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const publicResolver = async () => [{ address: '93.184.215.14', family: 4 }];
let sent: HttpRequest[];
let httpStatus: number;
const deps = () => ({ http: async (r: HttpRequest) => { sent.push(r); return { status: httpStatus, data: '' }; }, resolve: publicResolver });

function channel(id: string, type: string, secrets: Record<string, string>, extra: any = {}) {
  mockRepo('AlertChannel').rows.push({
    id, projectId: PID, name: type, type, config: {}, secretEnc: encryptChannelSecrets(secrets), minSeverity: 'info',
    allowPrivateNetwork: false, enabled: true, lastDeliveryAt: null, lastError: null, ...extra,
  });
}

const ev = (over: Partial<AlertEvent> = {}): AlertEvent => ({
  projectId: PID, source: 'monitor', severity: 'critical', dedupeKey: 'monitor:m1', title: 'High error rate', body: 'Value 12 > 5', ...over,
});

const incidents = () => mockRepo('AlertIncident').rows;
const deliveries = () => mockRepo('AlertDelivery').rows;

beforeEach(() => {
  for (const k of Object.keys(mockRepos)) delete mockRepos[k];
  mockRepo('Project').rows.push({ id: PID, name: 'shop' });
  sent = [];
  httpStatus = 200;
  mockNotifyUser.mockClear();
  setRedisClientForTests(null);
});

describe('event validation', () => {
  it('normalizes and rejects bad events', () => {
    expect(normalizeEvent(ev({ severity: 'bogus' as any, url: 'https://evil.example/x' }))).toMatchObject({ severity: 'warning', status: 'firing', url: undefined });
    expect(() => normalizeEvent(ev({ projectId: 'nope' }))).toThrow(/projectId/);
    expect(() => normalizeEvent(ev({ source: 'x' as any }))).toThrow(/source/);
    expect(() => normalizeEvent(ev({ dedupeKey: '' }))).toThrow(/dedupeKey/);
  });
});

describe('acceptance: monitor firing -> one deduplicated Slack + webhook notification, then resolution', () => {
  it('end to end through the stream consumer', async () => {
    channel(SLACK, 'slack', { webhookUrl: 'https://hooks.slack.example.test/T/B/x' });
    channel(HOOK, 'webhook', { url: 'https://receiver.example.test/hook', signingSecret: 'sign-me-please-123' });
    const fake = new FakeStreamRedis();
    setRedisClientForTests(fake as unknown as Redis);

    // The monitor keeps firing: Alertmanager / the evaluator repeat the event.
    for (let i = 0; i < 3; i++) await publishAlertEvent(ev());
    expect(fake.entries).toHaveLength(3);
    const drained = await drainAlertEvents('leader-1', alertingSettings(), Date.now, (e) => processAlertEvent(e, T0));
    expect(drained).toMatchObject({ processed: 3, failed: 0 });
    expect(fake.entries).toHaveLength(0); // acked + deleted

    expect(incidents()).toHaveLength(1);
    expect(incidents()[0]).toMatchObject({ status: 'firing', eventCount: 3 });
    await dispatchDeliveries(T0, deps());
    expect(sent.map((s) => s.url)).toEqual(['https://hooks.slack.example.test/T/B/x', 'https://receiver.example.test/hook']);
    const hook = sent[1];
    expect(JSON.parse(hook.body).event).toBe('incident.firing');
    expect(verifyWebhookSignature('sign-me-please-123', hook.body, hook.headers['X-Platform-Signature'], Math.floor(T0.getTime() / 1000))).toBe(true);

    // Nothing new to send while it keeps firing.
    await publishAlertEvent(ev());
    await drainAlertEvents('leader-1', alertingSettings(), Date.now, (e) => processAlertEvent(e, at(1)));
    await dispatchDeliveries(at(1), deps());
    expect(sent).toHaveLength(2);

    await publishAlertEvent(ev({ status: 'resolved' }));
    await drainAlertEvents('leader-1', alertingSettings(), Date.now, (e) => processAlertEvent(e, at(5)));
    await dispatchDeliveries(at(5), deps());
    expect(sent).toHaveLength(4);
    expect(JSON.parse(sent[2].body).text).toMatch(/^\[RESOLVED\]/);
    expect(JSON.parse(sent[3].body)).toMatchObject({ event: 'incident.resolved', incident: { status: 'resolved' } });
    expect(incidents()[0]).toMatchObject({ status: 'resolved' });

    // A later firing opens a NEW incident.
    await processAlertEvent(ev(), at(30));
    expect(incidents()).toHaveLength(2);
  });
});

describe('dedupe / resolve', () => {
  it('raises severity on repeats without re-notifying; unknown resolves are ignored', async () => {
    channel(SLACK, 'slack', { webhookUrl: 'https://hooks.example.test/s' });
    expect(await processAlertEvent(ev({ status: 'resolved' }), T0)).toEqual({ action: 'ignored' });
    expect((await processAlertEvent(ev({ severity: 'warning' }), T0)).action).toBe('opened');
    expect((await processAlertEvent(ev({ severity: 'critical' }), at(1))).action).toBe('deduplicated');
    expect(incidents()[0].severity).toBe('critical');
    expect(deliveries()).toHaveLength(1);
  });

  it('different dedupeKeys and projects are separate incidents', async () => {
    await processAlertEvent(ev(), T0);
    await processAlertEvent(ev({ dedupeKey: 'monitor:m2' }), T0);
    await processAlertEvent(ev({ projectId: '99999999-9999-4999-8999-999999999999' }), T0);
    expect(incidents()).toHaveLength(3);
  });
});

describe('acceptance: silences', () => {
  it('suppress notifications for their duration; notify if still firing after it ends', async () => {
    channel(SLACK, 'slack', { webhookUrl: 'https://hooks.example.test/s' });
    mockRepo('AlertSilence').rows.push({ id: 'sil-1', projectId: PID, kind: 'maintenance', matchers: [{ name: 'source', value: 'monitor', isEqual: true }], startsAt: T0, endsAt: at(60), comment: 'deploy window' });

    expect((await processAlertEvent(ev(), at(1))).action).toBe('silenced');
    await processAlertEvent(ev({ dedupeKey: 'synthetic:c1', source: 'synthetics' }), at(1)); // not matched -> notified
    await dispatchDeliveries(at(1), deps());
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body).attachments[0].fields.find((f: any) => f.title === 'Source').value).toBe('synthetics');

    // Still silenced at 30 min; the silenced incident resolving notifies nobody.
    await runEscalations(at(30));
    await processAlertEvent(ev({ dedupeKey: 'monitor:m9' }), at(30));
    await processAlertEvent(ev({ dedupeKey: 'monitor:m9', status: 'resolved' }), at(31));
    await dispatchDeliveries(at(31), deps());
    expect(sent).toHaveLength(1);

    // Silence over, m1 still firing -> notified once.
    expect(await runEscalations(at(61))).toMatchObject({ unsilenced: 1 });
    await dispatchDeliveries(at(61), deps());
    expect(sent).toHaveLength(2);
  });

  it('matcher semantics (equal, not-equal, regex; empty = whole project; time bounds)', () => {
    const s: any = { startsAt: T0, endsAt: at(10), matchers: [] };
    expect(silenceMatches(s, {}, at(5))).toBe(true);
    expect(silenceMatches(s, {}, at(10))).toBe(false);
    expect(silenceMatches(s, {}, at(-1))).toBe(false);
    s.matchers = [{ name: 'severity', value: 'warn.*', isRegex: true, isEqual: true }, { name: 'environment', value: 'staging', isEqual: false }];
    expect(silenceMatches(s, { severity: 'warning', environment: 'production' }, at(1))).toBe(true);
    expect(silenceMatches(s, { severity: 'warning', environment: 'staging' }, at(1))).toBe(false);
    expect(silenceMatches(s, { severity: 'critical' }, at(1))).toBe(false);
    expect(() => validateMatchers([{ name: 'x', value: '(', isRegex: true }])).toThrow(/regex/);
    expect(() => validateMatchers([{ name: '1bad', value: 'x' }])).toThrow(/name/);
  });
});

describe('routing / escalation / on-call', () => {
  it('rotation and overrides', () => {
    const s: any = { userIds: [USER_A, USER_B], rotationHours: 24, startsAt: T0, overrides: [] };
    expect(currentOncall(s, at(60))).toBe(USER_A);
    expect(currentOncall(s, at(25 * 60))).toBe(USER_B);
    expect(currentOncall(s, at(49 * 60))).toBe(USER_A);
    expect(currentOncall(s, at(-60))).toBe(USER_A);
    s.overrides = [{ userId: USER_B, startsAt: at(0).toISOString(), endsAt: at(120).toISOString() }];
    expect(currentOncall(s, at(60))).toBe(USER_B);
    expect(currentOncall({ ...s, userIds: [], overrides: [] }, at(1))).toBeNull();
  });

  it('validates steps', () => {
    expect(() => validateSteps([])).toThrow();
    expect(() => validateSteps([{ channelIds: [SLACK] }, { delayMinutes: -1, channelIds: [SLACK] }])).toThrow(/delayMinutes/);
    expect(() => validateSteps([{ channelIds: [SLACK] }, { delayMinutes: 10, channelIds: [SLACK] }, { delayMinutes: 5, channelIds: [SLACK] }])).toThrow(/decrease/);
    expect(() => validateSteps([{}])).toThrow(/at least one/);
    expect(validateSteps([{ delayMinutes: 99, channelIds: [SLACK] }])[0].delayMinutes).toBe(0);
  });

  it('notify A now, B (on-call) after N minutes; acknowledging stops escalation', async () => {
    channel(SLACK, 'slack', { webhookUrl: 'https://hooks.example.test/s' });
    channel(PAGER, 'pagerduty', { routingKey: 'R'.repeat(32) });
    mockRepo('AlertOncallSchedule').rows.push({ id: 'sch-1', projectId: PID, userIds: [USER_B], rotationHours: 168, startsAt: T0, overrides: [] });
    mockRepo('AlertEscalationPolicy').rows.push({
      id: 'pol-1', projectId: PID, name: 'default', isDefault: true,
      steps: [{ delayMinutes: 0, channelIds: [SLACK] }, { delayMinutes: 15, channelIds: [PAGER], scheduleIds: ['sch-1'] }, { delayMinutes: 30, userIds: [USER_A] }],
    });
    await processAlertEvent(ev(), T0);
    expect(incidents()[0].nextEscalationAt).toEqual(at(15));
    await dispatchDeliveries(T0, deps());
    expect(sent.map((s) => s.url)).toEqual(['https://hooks.example.test/s']);

    expect(await runEscalations(at(14))).toMatchObject({ escalated: 0 });
    expect(await runEscalations(at(15))).toMatchObject({ escalated: 1 });
    await dispatchDeliveries(at(15), deps());
    expect(sent.map((s) => s.url)).toContain('https://events.pagerduty.com/v2/enqueue');
    expect(mockNotifyUser).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_B, title: 'On-call: High error rate' }));
    expect(incidents()[0]).toMatchObject({ escalationStep: 1, nextEscalationAt: at(30) });

    const inc = await mockRepo('AlertIncident').findOne({ where: { id: incidents()[0].id } });
    await acknowledgeIncident(inc, USER_A, at(20));
    expect(await runEscalations(at(31))).toMatchObject({ escalated: 0 });
    await dispatchDeliveries(at(31), deps());
    // Ack goes to the notified channels: Slack note + PagerDuty acknowledge.
    const pdAck = sent.filter((s) => s.url.includes('pagerduty')).map((s) => JSON.parse(s.body).event_action);
    expect(pdAck).toEqual(['trigger', 'acknowledge']);
    expect(mockNotifyUser).not.toHaveBeenCalledWith(expect.objectContaining({ userId: USER_A }));

    await resolveIncident(await mockRepo('AlertIncident').findOne({ where: { id: inc.id } }), USER_A, at(40));
    await dispatchDeliveries(at(40), deps());
    expect(sent.filter((s) => s.url.includes('pagerduty')).map((s) => JSON.parse(s.body).event_action)).toEqual(['trigger', 'acknowledge', 'resolve']);
  });

  it('a monitor policy wins over the project default; channel severity filter', async () => {
    channel(SLACK, 'slack', { webhookUrl: 'https://hooks.example.test/s' }, { minSeverity: 'critical' });
    channel(HOOK, 'webhook', { url: 'https://hooks.example.test/w', signingSecret: 'x'.repeat(20) });
    mockRepo('AlertEscalationPolicy').rows.push(
      { id: 'pol-default', projectId: PID, isDefault: true, steps: [{ delayMinutes: 0, channelIds: [HOOK] }] },
      { id: 'pol-mon', projectId: PID, isDefault: false, steps: [{ delayMinutes: 0, channelIds: [SLACK] }] },
    );
    mockRepo('AlertMonitor').rows.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', projectId: PID, policyId: 'pol-mon' });
    await processAlertEvent(ev({ severity: 'warning', labels: { platform_monitor_id: 'aaaaaaaa-0000-4000-8000-000000000001' } }), T0);
    await dispatchDeliveries(T0, deps());
    expect(sent).toHaveLength(0);
    expect(deliveries()[0]).toMatchObject({ channelId: SLACK, status: 'skipped' });
  });
});

describe('delivery retry', () => {
  it('retries 5xx with backoff, gives up after max attempts; 4xx fails at once', async () => {
    channel(SLACK, 'slack', { webhookUrl: 'https://hooks.example.test/s' });
    await processAlertEvent(ev(), T0);
    httpStatus = 503;
    expect(await dispatchDeliveries(T0, deps())).toMatchObject({ retried: 1 });
    expect(deliveries()[0]).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: new Date(T0.getTime() + retryDelayMs(1)) });
    expect(await dispatchDeliveries(T0, deps())).toMatchObject({ sent: 0, retried: 0 }); // not due yet
    let now = T0;
    for (let i = 0; i < 10 && deliveries()[0].status === 'pending'; i++) {
      now = new Date(deliveries()[0].nextAttemptAt);
      await dispatchDeliveries(now, deps());
    }
    expect(deliveries()[0]).toMatchObject({ status: 'failed', attempts: alertingSettings().maxDeliveryAttempts });
    expect(mockRepo('AlertChannel').rows[0].lastError).toMatch(/HTTP 503/);

    await processAlertEvent(ev({ dedupeKey: 'monitor:m2' }), T0);
    httpStatus = 404;
    expect(await dispatchDeliveries(T0, deps())).toMatchObject({ failed: 1 });
  });
});

describe('consumer ack / retry', () => {
  let fake: FakeStreamRedis;
  beforeEach(() => {
    fake = new FakeStreamRedis();
    setRedisClientForTests(fake as unknown as Redis);
  });
  afterAll(() => setRedisClientForTests(null));

  it('a failing event stays pending and is re-claimed; malformed/invalid events are dropped', async () => {
    await publishAlertEvent(ev());
    await fake.xadd(ALERT_EVENTS_STREAM, '*', 'event', '{not json');
    await publishAlertEvent(ev({ projectId: 'not-a-uuid' }));
    let fail = true;
    const apply = jest.fn(async (e: AlertEvent) => { if (fail) throw new Error('db down'); return processAlertEvent(e, T0); });
    const settings = { ...alertingSettings(), consumerReclaimIdleMs: 1000 };
    const r1 = await drainAlertEvents('leader-1', settings, Date.now, async (e) => {
      if (e.projectId === 'not-a-uuid') return processAlertEvent(e, T0);
      return apply(e);
    });
    expect(r1).toMatchObject({ processed: 0, failed: 1, dropped: 2 });
    expect(fake.entries).toHaveLength(1);
    expect(fake.groups.get(ALERT_EVENTS_GROUP)!.pel.size).toBe(1);

    fail = false;
    fake.clock += 5_000; // idle long enough: a new leader re-claims it
    const r2 = await drainAlertEvents('leader-2', settings, Date.now, apply);
    expect(r2).toMatchObject({ processed: 1, reclaimed: 1 });
    expect(fake.entries).toHaveLength(0);
    expect(incidents()).toHaveLength(1);
  });

  it('drops an event after max attempts', async () => {
    await publishAlertEvent(ev());
    const settings = { ...alertingSettings(), consumerReclaimIdleMs: 1, consumerMaxAttempts: 2 };
    const boom = async () => { throw new Error('always'); };
    await drainAlertEvents('l', settings, Date.now, boom);
    for (let i = 0; i < 3; i++) { fake.clock += 10; await drainAlertEvents('l', settings, Date.now, boom); }
    expect(fake.entries).toHaveLength(0);
  });
});

describe('API evaluator', () => {
  const monitorRow = (over: any = {}) => ({
    id: 'aaaaaaaa-0000-4000-8000-000000000001', projectId: PID, name: 'Errors', kind: 'metric', query: 'sum(rate(x[5m]))', params: {},
    operator: '>', threshold: 5, forSeconds: 60, severity: 'critical', labels: {}, enabled: true, state: 'ok', pendingSince: null, policyId: null, ...over,
  });

  it('parses Prometheus results', () => {
    expect(parseQueryResult({ data: { resultType: 'vector', result: [{ value: [1, '3.5'] }] } })).toEqual([3.5]);
    expect(parseQueryResult({ data: { resultType: 'scalar', result: [1, '2'] } })).toEqual([2]);
    expect(() => parseQueryResult({ data: { resultType: 'matrix', result: [] } })).toThrow(/instant/);
  });

  it('fires after `for`, resolves, and keeps state on query errors', async () => {
    mockRepo('AlertMonitor').rows.push(monitorRow());
    let value = 12;
    let broken = false;
    const query: QueryFn = jest.fn(async (engine, expr) => { if (broken) throw new Error('prometheus down'); expect(engine).toBe('prometheus'); expect(expr).toBe('(sum(rate(x[5m])))'); return [value]; });
    const emitted: AlertEvent[] = [];
    const emit = async (e: AlertEvent) => { emitted.push(e); };
    const m = () => mockRepo('AlertMonitor').rows[0];
    expect(await evaluateMonitor(m(), query, T0, emit)).toBeNull();
    expect(m().state).toBe('pending');
    expect(await evaluateMonitor(m(), query, at(1), emit)).toBe('firing');
    broken = true;
    expect(await evaluateMonitor(m(), query, at(2), emit)).toBeNull();
    expect(m()).toMatchObject({ state: 'firing', lastError: 'prometheus down' });
    broken = false;
    value = 1;
    expect(await evaluateMonitor(m(), query, at(3), emit)).toBe('resolved');
    expect(emitted.map((e) => [e.dedupeKey, e.status, e.labels?.platform_monitor_id])).toEqual([
      ['monitor:aaaaaaaa-0000-4000-8000-000000000001', 'firing', 'aaaaaaaa-0000-4000-8000-000000000001'],
      ['monitor:aaaaaaaa-0000-4000-8000-000000000001', 'resolved', 'aaaaaaaa-0000-4000-8000-000000000001'],
    ]);
  });

  it('log monitors query Loki; ruler mode leaves Prometheus monitors to the ruler', async () => {
    process.env.ALERTING_MODE = 'ruler';
    mockRepo('AlertMonitor').rows.push(monitorRow(), monitorRow({ id: 'aaaaaaaa-0000-4000-8000-000000000002', kind: 'log', query: 'sum(count_over_time({a="b"}[5m]))' }));
    const engines: string[] = [];
    await runEvaluation(async (engine) => { engines.push(engine); return [0]; }, T0);
    expect(engines).toEqual(['loki']);
    delete process.env.ALERTING_MODE;
  });

  it('acceptance: SLO burn alert fires on error injection, and resolves after recovery', async () => {
    channel(PAGER, 'pagerduty', { routingKey: 'R'.repeat(32) });
    const sloRow = { id: 'bbbbbbbb-0000-4000-8000-000000000001', projectId: PID, name: 'Checkout availability', sliType: 'availability', params: { service: 'checkout' }, target: 99.9, windowDays: 30, enabled: true, status: null, alertState: {}, policyId: null };
    mockRepo('AlertSlo').rows.push(sloRow);
    // Prometheus answers with the error ratio of the queried window: healthy, then 5% errors injected.
    let errorRatio = 0.0001;
    const query: QueryFn = async (_e, expr) => {
      expect(expr).toContain(`platform_project_id="${PID}"`);
      return [/\[(30d)\]/.test(expr) ? 0.0002 : errorRatio];
    };
    const s = () => mockRepo('AlertSlo').rows[0];
    await evaluateSlo(s(), query, T0);
    expect(incidents()).toHaveLength(0);
    expect(s().status).toMatchObject({ errorRatio: 0.0002, alerts: { page: false, ticket: false } });
    expect(s().status!.errorBudgetRemaining).toBeCloseTo(0.8);

    errorRatio = 0.05; // injected errors
    await evaluateSlo(s(), query, at(1));
    expect(incidents().map((i) => [i.dedupeKey, i.severity, i.status])).toEqual([
      ['slo:bbbbbbbb-0000-4000-8000-000000000001:page', 'critical', 'firing'],
      ['slo:bbbbbbbb-0000-4000-8000-000000000001:ticket', 'warning', 'firing'],
    ]);
    // emitAlertEvent processes inline (no Redis) with the real clock.
    await dispatchDeliveries(new Date(Date.now() + 1000), deps());
    expect(sent.map((r) => JSON.parse(r.body).event_action)).toEqual(['trigger', 'trigger']);

    await evaluateSlo(s(), query, at(2)); // still burning: no duplicates
    expect(incidents()).toHaveLength(2);

    errorRatio = 0;
    await evaluateSlo(s(), query, at(3));
    expect(incidents().every((i) => i.status === 'resolved')).toBe(true);
  });
});
