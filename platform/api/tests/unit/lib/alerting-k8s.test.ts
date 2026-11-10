/**
 * Full-profile integration (#43): PrometheusRule / AlertmanagerConfig / webhook Secret sync,
 * orphan cleanup, Loki ruler push, Alertmanager silence mirroring, webhook token check.
 */
import { MemoryRepo } from '../../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}
jest.mock('../../../src/config/database', () => ({
  getDb: async () => ({ getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name) }),
}));

import {
  alertmanagerMatchers, alertmanagerWebhookToken, CustomObjects, expireMirroredSilence, mirrorSilence, syncAllRules,
  syncProjectRules, verifyAlertmanagerToken, WEBHOOK_TOKEN_SECRET,
} from '../../../src/lib/alerting-k8s';

process.env.SECRETS_ENCRYPTION_KEY = 'test-key-for-alerting-k8s';
const PID = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';

function fakeObjects() {
  const store: Record<string, any> = {};
  const secrets: Record<string, Record<string, string>> = {};
  const objects: CustomObjects = {
    async get(plural, _v, name) { return store[`${plural}/${name}`] || null; },
    async list(plural) { return Object.entries(store).filter(([k]) => k.startsWith(`${plural}/`)).map(([, v]) => v); },
    async upsert(plural, _v, body) { store[`${plural}/${body.metadata.name}`] = body; },
    async remove(plural, _v, name) { delete store[`${plural}/${name}`]; },
    async ensureSecret(name, data) { secrets[name] = data; },
  };
  return { objects, store, secrets };
}

beforeEach(() => {
  for (const k of Object.keys(mockRepos)) delete mockRepos[k];
  process.env.ALERTING_MODE = 'ruler';
  delete process.env.ALERTING_LOKI_RULER;
  mockRepo('Environment').rows.push({ id: 'e1', projectId: PID, namespace: 'shop-production-abc' });
});
afterAll(() => { delete process.env.ALERTING_MODE; });

const monitor = (over: any = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001', projectId: PID, name: 'CPU', kind: 'resource', query: null, params: { resource: 'cpu' },
  operator: '>', threshold: 80, forSeconds: 300, severity: 'warning', labels: {}, enabled: true, ...over,
});

describe('rule sync', () => {
  it('applies PrometheusRule + AlertmanagerConfig + webhook token Secret; removes them when empty', async () => {
    mockRepo('AlertMonitor').rows.push(monitor());
    const { objects, store, secrets } = fakeObjects();
    const loki = jest.fn(async () => {});
    const r = await syncProjectRules(PID, objects, loki);
    expect(r).toMatchObject({ groups: 1, errors: [] });
    const rule = store[`prometheusrules/platform-alerts-${PID}`];
    expect(rule.spec.groups[0].rules[0].expr).toContain('namespace=~"shop-production-abc"');
    const am = store[`alertmanagerconfigs/platform-alerts-${PID}`];
    expect(am.spec.receivers[0].webhookConfigs[0].url).toBe('http://platform-api.platform.svc.cluster.local:3000/api/alerting/alertmanager/webhook');
    expect(secrets[WEBHOOK_TOKEN_SECRET]).toEqual({ token: alertmanagerWebhookToken() });
    expect(loki).not.toHaveBeenCalled();

    mockRepo('AlertMonitor').rows = [];
    await syncProjectRules(PID, objects, loki);
    expect(Object.keys(store)).toEqual([]);
  });

  it('pushes log monitors to the Loki ruler when enabled', async () => {
    process.env.ALERTING_LOKI_RULER = 'enabled';
    mockRepo('AlertMonitor').rows.push(monitor({ id: 'aaaaaaaa-0000-4000-8000-000000000002', kind: 'log', query: 'sum(rate({a="b"}[5m]))', params: {} }));
    const { objects, store } = fakeObjects();
    const loki = jest.fn(async (..._a: any[]) => {});
    const r = await syncProjectRules(PID, objects, loki);
    expect(r).toMatchObject({ groups: 0, lokiRules: 1 });
    expect(loki).toHaveBeenCalledWith('post', '/loki/api/v1/rules/platform', expect.stringContaining('sum(rate({a="b"}[5m]))'));
    expect(store[`alertmanagerconfigs/platform-alerts-${PID}`]).toBeDefined();
    expect(store[`prometheusrules/platform-alerts-${PID}`]).toBeUndefined();
  });

  it('full reconcile deletes objects of projects without rules', async () => {
    mockRepo('AlertMonitor').rows.push(monitor());
    const { objects, store } = fakeObjects();
    store[`prometheusrules/platform-alerts-${OLD}`] = { metadata: { name: `platform-alerts-${OLD}` } };
    store['prometheusrules/telemetry'] = { metadata: { name: 'telemetry' } };
    await syncAllRules(objects, jest.fn(async () => {}));
    expect(Object.keys(store).sort()).toEqual([
      `alertmanagerconfigs/platform-alerts-${PID}`, `prometheusrules/platform-alerts-${PID}`, 'prometheusrules/telemetry',
    ]);
  });

  it('does nothing outside ruler mode', async () => {
    process.env.ALERTING_MODE = 'api';
    mockRepo('AlertMonitor').rows.push(monitor());
    const { objects, store } = fakeObjects();
    expect(await syncAllRules(objects)).toEqual([]);
    expect(store).toEqual({});
  });
});

describe('Alertmanager silences + webhook token', () => {
  const silence = (matchers: any[]) => ({ id: 's1', projectId: PID, kind: 'silence', matchers, startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-01-01T01:00:00Z'), comment: 'c', createdBy: null, alertmanagerId: null, createdAt: new Date() });

  it('always scopes to the project; dedupeKey-only silences stay API-side', () => {
    expect(alertmanagerMatchers(silence([{ name: 'source', value: 'monitor' }]) as any)).toEqual([
      { name: 'project', value: PID, isRegex: false, isEqual: true },
      { name: 'platform_source', value: 'monitor', isRegex: false, isEqual: true },
    ]);
    expect(alertmanagerMatchers(silence([{ name: 'project', value: OLD }]) as any)).toBeNull();
    expect(alertmanagerMatchers(silence([{ name: 'dedupeKey', value: 'x' }]) as any)).toBeNull();
  });

  it('mirrors and expires through the v2 API', async () => {
    const http = jest.fn(async (..._a: any[]) => ({ silenceID: 'abcdef12-3456-7890-abcd-ef1234567890' }));
    expect(await mirrorSilence(silence([]) as any, http)).toBe('abcdef12-3456-7890-abcd-ef1234567890');
    expect(http).toHaveBeenCalledWith('post', '/api/v2/silences', expect.objectContaining({ matchers: [{ name: 'project', value: PID, isRegex: false, isEqual: true }], endsAt: '2026-01-01T01:00:00.000Z' }));
    await expireMirroredSilence('abcdef12-3456-7890-abcd-ef1234567890', http);
    expect(http).toHaveBeenLastCalledWith('delete', '/api/v2/silence/abcdef12-3456-7890-abcd-ef1234567890');
    await expireMirroredSilence('../../etc', http);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('webhook token: constant-time bearer check', () => {
    expect(verifyAlertmanagerToken(`Bearer ${alertmanagerWebhookToken()}`)).toBe(true);
    expect(verifyAlertmanagerToken('Bearer nope')).toBe(false);
    expect(verifyAlertmanagerToken(undefined)).toBe(false);
  });
});
