/**
 * Observability proxy routes (#48): permissions, server-side project scoping of
 * every upstream query, caps, timeouts, error mapping and the fleet view.
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { MemoryRepo } from '../../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}
jest.mock('../../../src/config/database', () => ({
  getDb: async () => ({ getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name) }),
}));
jest.mock('../../../src/middleware/auth', () => ({
  expressAuthenticate: (req: any, res: any, next: any) => {
    if (!req.get('x-user')) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: req.get('x-user'), role: req.get('x-role') || 'developer' };
    next();
  },
}));
const mockFeed = jest.fn(async (_id: string) => ({ status: 'operational' }));
jest.mock('../../../src/lib/synthetic-status', () => ({ getProjectStatusFeed: (id: string) => mockFeed(id) }));

import observability from '../../../src/routes/observability';
import { ObsRequest, setObservabilityTransport } from '../../../src/lib/observability-backends';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DEV_A = '33333333-0000-4000-8000-000000000001';
const DEV_B = '33333333-0000-4000-8000-000000000002';
const ADMIN = '33333333-0000-4000-8000-000000000003';
const OWN = `platform_project_id="${A}"`;

interface Call { url: string; req: ObsRequest; timeoutMs: number }
let calls: Call[] = [];
let responder: (url: string, req: ObsRequest) => any = () => ({ status: 200, data: { status: 'success', data: { resultType: 'vector', result: [] } } });

function app() {
  const a = express();
  a.use(express.json());
  a.use(observability);
  return a;
}
const as = (r: request.Test, user: string, role = 'developer') => r.set('x-user', user).set('x-role', role);
const base = `/projects/${A}/observability`;

beforeEach(() => {
  for (const k of Object.keys(mockRepos)) delete mockRepos[k];
  process.env.PLATFORM_OBSERVABILITY = 'enabled';
  process.env.OBSERVABILITY_RATE_LIMIT = '10000';
  delete process.env.OBSERVABILITY_MAX_RANGE_HOURS;
  delete process.env.OBSERVABILITY_LOKI_SCOPE;
  calls = [];
  responder = () => ({ status: 200, data: { status: 'success', data: { resultType: 'vector', result: [] } } });
  setObservabilityTransport(async (url, req, limits) => {
    calls.push({ url, req, timeoutMs: limits.timeoutMs });
    const r = responder(url, req);
    if (r instanceof Error) throw r;
    return r;
  });
  mockRepo('Project').rows.push({ id: A, name: 'shop' }, { id: B, name: 'bank' });
  mockRepo('ProjectMember').rows.push(
    { id: 'm1', projectId: A, userId: DEV_A, role: 'developer' },
    { id: 'm2', projectId: B, userId: DEV_B, role: 'developer' },
  );
  mockRepo('Environment').rows.push(
    { id: 'e1', projectId: A, name: 'production', namespace: 'shop-production-abc' },
    { id: 'e2', projectId: A, name: 'staging', namespace: 'shop-staging-def' },
    { id: 'e3', projectId: B, name: 'production', namespace: 'bank-production-xyz' },
  );
});

afterAll(() => setObservabilityTransport(null));

function upstreamQueries(): string[] {
  return calls.map((c) => String(c.req.params?.query ?? c.req.params?.q ?? JSON.stringify(c.req.body ?? '')));
}

describe('permissions', () => {
  it('requires authentication and project membership', async () => {
    expect((await request(app()).get(`${base}/query/prom?query=up`)).status).toBe(401);
    const routes = [
      'summary', 'services', 'endpoints', 'red', 'service-graph', 'infra', 'query/prom?query=up', 'query/loki?query={a="1"}',
      'query/tempo?q={}', 'traces/0123456789abcdef0123456789abcdef', 'profiles/meta', 'query/pyroscope',
    ];
    for (const r of routes) {
      const res = await as(request(app()).get(`/projects/${A}/observability/${r}`), DEV_B);
      expect([r, res.status]).toEqual([r, 403]);
    }
    expect(calls).toHaveLength(0);
    expect((await as(request(app()).get(`${base}/query/prom?query=up`), DEV_A)).status).toBe(200);
    expect((await as(request(app()).get(`${base}/query/prom?query=up`), ADMIN, 'admin')).status).toBe(200);
  });

  it('rejects malformed and unknown projects', async () => {
    expect((await as(request(app()).get('/projects/not-a-uuid/observability/query/prom?query=up'), ADMIN, 'admin')).status).toBe(400);
    expect((await as(request(app()).get('/projects/44444444-4444-4444-8444-444444444444/observability/query/prom?query=up'), ADMIN, 'admin')).status).toBe(404);
  });
});

describe('telemetry disabled', () => {
  it('query routes answer 503 observability_disabled; summary and status still work', async () => {
    delete process.env.PLATFORM_OBSERVABILITY;
    const res = await as(request(app()).get(`${base}/query/prom?query=up`), DEV_A);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('observability_disabled');
    const status = await as(request(app()).get('/observability/status'), DEV_A);
    expect(status.body.enabled).toBe(false);
    const summary = await as(request(app()).get(`${base}/summary`), DEV_A);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ telemetryEnabled: false, red: null });
    expect(calls).toHaveLength(0);
  });
});

describe('Prometheus proxy', () => {
  it('injects the project matcher into every selector', async () => {
    const res = await as(request(app()).get(`${base}/query/prom`).query({ query: 'rate(http_requests_total[5m]) or secret_metric', since: '1h' }), DEV_A);
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('http://kube-prometheus-kube-prome-prometheus.monitoring.svc:9090/api/v1/query_range');
    expect(calls[0].req.params?.query).toBe(`rate(http_requests_total{${OWN}}[5m]) or secret_metric{${OWN}}`);
  });

  it.each([
    [`up{platform_project_id="${B}"}`],
    [`up{platform_project_id=~".+"}`],
    [`up or up{platform_project_id!="${A}"}`],
    ['up{job="a" or job="b"}'],
    [`{"platform_project_id"="${B}"}`],
  ])('refuses %s without calling Prometheus', async (query) => {
    const res = await as(request(app()).get(`${base}/query/prom`).query({ query }), DEV_A);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_query');
    expect(calls).toHaveLength(0);
  });

  it('caps the time range, points per series and series count', async () => {
    process.env.OBSERVABILITY_MAX_RANGE_HOURS = '24';
    responder = () => ({ status: 200, data: { data: { resultType: 'matrix', result: Array.from({ length: 900 }, (_, i) => ({ metric: { i: String(i) }, values: [] })) } } });
    const res = await as(request(app()).get(`${base}/query/prom`).query({ query: 'up', since: '30d', step: '1' }), DEV_A);
    expect(res.status).toBe(200);
    const p = calls[0].req.params as any;
    expect(p.end - p.start).toBeLessThanOrEqual(24 * 3600 + 1);
    expect((p.end - p.start) / p.step).toBeLessThanOrEqual(1100);
    expect(res.body.result).toHaveLength(500);
    expect(res.body.truncated).toBe(true);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('does not leak upstream error bodies', async () => {
    responder = () => ({ status: 400, data: { status: 'error', error: 'parse error near internal-host:9090 secret' } });
    const res = await as(request(app()).get(`${base}/query/prom?query=up`), DEV_A);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/internal-host|secret/);
  });

  it('maps timeouts to 504 and connection failures to 502', async () => {
    responder = () => Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
    expect((await as(request(app()).get(`${base}/query/prom?query=up`), DEV_A)).status).toBe(504);
    responder = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:9090'), { code: 'ECONNREFUSED' });
    const res = await as(request(app()).get(`${base}/query/prom?query=up`), DEV_A);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.1');
  });
});

describe('Loki proxy', () => {
  it('scopes raw LogQL and structured filters', async () => {
    responder = () => ({
      status: 200,
      data: { data: { resultType: 'streams', result: [{ stream: { service_name: 'api', trace_id: 'abcdefabcdefabcdefabcdefabcdefab' }, values: [['1700000000000000001', 'hello'], ['1700000000000000002', '{"msg":"x","traceId":"0123456789abcdef0123456789abcdef"}']] }] } },
    });
    const raw = await as(request(app()).get(`${base}/query/loki`).query({ query: 'sum(rate({service_name="api"}[5m])) or {job="other"}' }), DEV_A);
    expect(raw.status).toBe(200);
    expect(calls[0].req.params?.query).toBe(`sum(rate({service_name="api",${OWN}}[5m])) or {job="other",${OWN}}`);

    const structured = await as(request(app()).get(`${base}/query/loki`).query({ service: 'api"}', search: 'timeout', limit: '99999' }), DEV_A);
    expect(structured.status).toBe(200);
    expect(calls[1].req.params?.query).toBe(`{service_name="api\\"}",${OWN}} |= "timeout"`);
    expect(calls[1].req.params?.limit).toBe(1000);
    expect(structured.body.entries[0]).toMatchObject({ ts: '1700000000000000002', traceId: '0123456789abcdef0123456789abcdef' });
    expect(structured.body.entries[1].traceId).toBe('abcdefabcdefabcdefabcdefabcdefab');
  });

  it('refuses project label overrides', async () => {
    for (const query of [`{platform_project_id="${B}"}`, `{platform_project_id=~".*"}`, `{a="1", platform_project_id!="${A}"}`]) {
      expect((await as(request(app()).get(`${base}/query/loki`).query({ query }), DEV_A)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('metadata mode filters on the project right after the selector', async () => {
    process.env.OBSERVABILITY_LOKI_SCOPE = 'metadata';
    responder = () => ({ status: 200, data: { data: { resultType: 'streams', result: [] } } });
    await as(request(app()).get(`${base}/query/loki`).query({ query: '{service_name="api"} | json' }), DEV_A);
    expect(calls[0].req.params?.query).toBe(`{service_name="api"} | ${OWN} | json`);
  });

  it('live tail cursor starts strictly after the last entry', async () => {
    responder = () => ({ status: 200, data: { data: { resultType: 'streams', result: [] } } });
    const after = `${Math.floor(Date.now() / 1000) - 10}000000000`;
    await as(request(app()).get(`${base}/query/loki`).query({ query: '{a="1"}', since: '5m', after }), DEV_A);
    expect(calls[0].req.params?.start).toBe((BigInt(after) + 1n).toString());
    expect((await as(request(app()).get(`${base}/query/loki`).query({ query: '{a="1"}', after: '1e9' }), DEV_A)).status).toBe(400);
  });
});

describe('Tempo proxy', () => {
  it('wraps TraceQL in the project condition and hides foreign root services', async () => {
    responder = (url) => {
      if (url.endsWith('/api/v1/query')) return { status: 200, data: { data: { resultType: 'vector', result: [{ metric: { service: 'checkout' }, value: [0, '1'] }] } } };
      return {
        status: 200,
        data: {
          traces: [
            { traceID: 'aa', rootServiceName: 'checkout', rootTraceName: 'GET /', durationMs: 5, spanSets: [{ matched: 1, spans: [{ spanID: 's1', durationNanos: '1000000', attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] }] }] },
            { traceID: 'bb', rootServiceName: 'bank-gateway', rootTraceName: 'POST /transfer', durationMs: 9, spanSets: [] },
          ],
        },
      };
    };
    const res = await as(request(app()).get(`${base}/query/tempo`).query({ q: '{ true ) || ( true }' }), DEV_A);
    expect(res.status).toBe(400);
    const ok = await as(request(app()).get(`${base}/query/tempo`).query({ q: `{ resource.platform.project_id = "${B}" || span.x = 1 }`, limit: '5000' }), DEV_A);
    expect(ok.status).toBe(200);
    const search = calls.find((c) => c.url.endsWith('/api/search'))!;
    expect(search.req.params?.q).toBe(`{ resource.platform.project_id = "${A}" && ( resource.platform.project_id = "${B}" || span.x = 1 ) }`);
    expect(search.req.params?.limit).toBe(100);
    expect(ok.body.traces[0]).toMatchObject({ traceId: 'aa', rootServiceName: 'checkout' });
    expect(ok.body.traces[1].rootServiceName).toBeNull();
    expect(JSON.stringify(ok.body)).not.toContain('POST /transfer');
  });

  it('structured search builds a scoped query', async () => {
    responder = (url) => (url.endsWith('/api/search') ? { status: 200, data: { traces: [] } } : { status: 200, data: { data: { result: [] } } });
    await as(request(app()).get(`${base}/query/tempo`).query({ service: 'api', minDuration: '250ms', status: 'error' }), DEV_A);
    const search = calls.find((c) => c.url.endsWith('/api/search'))!;
    expect(search.req.params?.q).toBe(`{ resource.platform.project_id = "${A}" && ( resource.service.name = "api" && duration >= 250ms && status = error ) }`);
    expect((await as(request(app()).get(`${base}/query/tempo`).query({ minDuration: '1s } || {' }), DEV_A)).status).toBe(400);
  });

  it('trace by id returns only the caller project spans; foreign-only traces are 404', async () => {
    const res = (project: string, service: string, spanId: string, parent?: string) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'platform.project_id', value: { stringValue: project } }] },
      scopeSpans: [{ spans: [{ traceId: 'q83vEjRWeJCrze8SNFZ4kA==', spanId, parentSpanId: parent, name: `${service} op`, startTimeUnixNano: '1000000', endTimeUnixNano: '3000000', status: { code: 2 }, kind: 2 }] }],
    });
    responder = () => ({ status: 200, data: { batches: [res(A, 'checkout', 'AAAAAAAAAAE=', ''), res(B, 'bank-gateway', 'AAAAAAAAAAI=', 'AAAAAAAAAAE='), { resource: { attributes: [] }, scopeSpans: [{ spans: [{ spanId: 'x' }] }] }] } });
    const ok = await as(request(app()).get(`${base}/traces/ABCDEF0123456789abcdef0123456789`), DEV_A);
    expect(ok.status).toBe(200);
    expect(ok.body.spans).toHaveLength(1);
    expect(ok.body.spans[0]).toMatchObject({ serviceName: 'checkout', spanId: '0000000000000001', traceId: 'abcdef1234567890abcdef1234567890', durationMs: 2, status: { code: 'ERROR' }, kind: 'SERVER' });
    expect(ok.body.hiddenSpans).toBe(2);
    expect(JSON.stringify(ok.body)).not.toContain('bank-gateway');
    expect(calls[0].url).toBe('http://tempo.monitoring.svc:3200/api/traces/abcdef0123456789abcdef0123456789');

    responder = () => ({ status: 200, data: { batches: [res(B, 'bank-gateway', 'AAAAAAAAAAI=')] } });
    const foreign = await as(request(app()).get(`${base}/traces/abcdef0123456789abcdef0123456789`), DEV_A);
    expect(foreign.status).toBe(404);
    responder = () => ({ status: 404, data: 'trace not found' });
    expect((await as(request(app()).get(`${base}/traces/abcdef0123456789abcdef0123456789`), DEV_A)).status).toBe(404);
    expect((await as(request(app()).get(`${base}/traces/..%2F..%2Fapi%2Fsearch`), DEV_A)).status).toBe(400);
  });
});

describe('Pyroscope proxy', () => {
  it('builds the selector server-side and validates the profile type', async () => {
    responder = () => ({ status: 200, data: { flamebearer: { names: ['total', 'main'], levels: [[0, 10, 0, 0], [0, 10, 10, 1]], numTicks: 10, maxSelf: 10 }, metadata: { units: 'samples' } } });
    const res = await as(request(app()).get(`${base}/query/pyroscope`).query({ service: 'api"}', environment: 'production' }), DEV_A);
    expect(res.status).toBe(200);
    expect(calls[0].req.params?.query).toBe(`process_cpu:cpu:nanoseconds:cpu:nanoseconds{${OWN},platform_service="api\\"}",deployment_environment="production"}`);
    expect(res.body.flamebearer.names).toEqual(['total', 'main']);
    expect((await as(request(app()).get(`${base}/query/pyroscope`).query({ profileType: `cpu{platform_project_id="${B}"}` }), DEV_A)).status).toBe(400);
  });

  it('profile metadata uses scoped matchers', async () => {
    responder = (_u, req) => ({ status: 200, data: { names: (req.body as any).name === 'platform_service' ? ['api'] : ['process_cpu:cpu:nanoseconds:cpu:nanoseconds', 'bad{x}'] } });
    const res = await as(request(app()).get(`${base}/profiles/meta`), DEV_A);
    expect(res.body).toMatchObject({ services: ['api'], profileTypes: ['process_cpu:cpu:nanoseconds:cpu:nanoseconds'] });
    for (const c of calls) expect((c.req.body as any).matchers).toEqual([`{${OWN}}`]);
    // Pyroscope's max_query_length is 1d: the default 24h window must stay under it.
    for (const c of calls) {
      const body = c.req.body as any;
      expect(body.end - body.start).toBeLessThan(86_400_000);
    }
  });

  it('clamps flamegraph ranges longer than a day under the Pyroscope limit', async () => {
    responder = () => ({ status: 200, data: { flamebearer: null, metadata: null } });
    const res = await as(request(app()).get(`${base}/query/pyroscope`).query({ since: '7d' }), DEV_A);
    expect(res.status).toBe(200);
    expect(res.body.range.clamped).toBe(true);
    const p = calls[0].req.params as any;
    expect(Number(p.until) - Number(p.from)).toBeLessThan(86_400);
  });
});

describe('server-built views', () => {
  it('every RED / services / endpoints query is scoped', async () => {
    for (const r of ['summary', 'services', 'endpoints?service=api', 'red?since=6h']) {
      expect((await as(request(app()).get(`${base}/${r}`), DEV_A)).status).toBe(200);
    }
    const qs = upstreamQueries();
    expect(qs.length).toBeGreaterThan(10);
    for (const query of qs) {
      for (const sel of query.match(/\{[^{}]*\}/g) || []) expect(sel).toContain(OWN);
    }
  });

  it('service graph masks services of other projects', async () => {
    responder = (_u, req) => {
      const query = String(req.params?.query);
      if (query.startsWith('group by (service)')) return { status: 200, data: { data: { result: [{ metric: { service: 'checkout' } }, { metric: { service: 'cart' } }] } } };
      if (query.includes('traces_service_graph_request_total')) {
        return {
          status: 200,
          data: { data: { result: [
            { metric: { client: 'checkout', server: 'cart' }, value: [0, '2'] },
            { metric: { client: 'checkout', server: 'bank-gateway' }, value: [0, '1'] },
            { metric: { client: 'cart', server: 'postgres', connection_type: 'database' }, value: [0, '3'] },
          ] } },
        };
      }
      return { status: 200, data: { data: { result: [] } } };
    };
    const res = await as(request(app()).get(`${base}/service-graph`), DEV_A);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('bank-gateway');
    expect(res.body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'checkout', target: 'cart', requestRate: 2 }),
      expect.objectContaining({ source: 'checkout', target: '(other project)' }),
      expect.objectContaining({ source: 'cart', target: 'postgres' }),
    ]));
    const graphQuery = calls.map((c) => String(c.req.params?.query)).find((q) => q.includes('traces_service_graph_request_total'))!;
    for (const sel of graphQuery.match(/\{[^{}]*\}/g) || []) expect(sel).toMatch(new RegExp(`platform_project_id="${A}"`));
  });

  it('infra queries use the project namespaces from the database only', async () => {
    await as(request(app()).get(`${base}/infra?environment=production`), DEV_A);
    const qs = upstreamQueries();
    expect(qs.length).toBe(3);
    for (const query of qs) {
      expect(query).toContain('namespace=~"shop-production-abc"');
      expect(query).not.toContain('bank');
    }
    calls = [];
    await as(request(app()).get(`${base}/infra`), DEV_A);
    expect(upstreamQueries()[0]).toContain('namespace=~"shop-production-abc|shop-staging-def"');
  });
});

describe('fleet', () => {
  beforeEach(() => {
    responder = (_u, req) => {
      const query = String(req.params?.query);
      const v = (a: string, b: string) => ({ status: 200, data: { data: { result: [{ metric: { platform_project_id: A }, value: [0, a] }, { metric: { platform_project_id: B }, value: [0, b] }] } } });
      if (query.startsWith('100 *')) return v('7', '0.1');
      if (query.startsWith('1000 *')) return v('120', '80');
      return v('5', '9');
    };
  });

  it('members only see their own projects and queries are restricted to them', async () => {
    const res = await as(request(app()).get('/observability/fleet'), DEV_A);
    expect(res.status).toBe(200);
    expect(res.body.projects.map((p: any) => p.projectId)).toEqual([A]);
    expect(res.body.projects[0]).toMatchObject({ errorRate: 7, p95Ms: 120, requestRate: 5, health: 'critical' });
    for (const query of upstreamQueries()) {
      expect(query).toContain(`platform_project_id=~"${A}"`);
      expect(query).not.toContain(B);
    }
  });

  it('platform admins see every project', async () => {
    mockRepo('AlertIncident').rows.push({ id: 'i1', projectId: B, status: 'firing', severity: 'warning' });
    const res = await as(request(app()).get('/observability/fleet'), ADMIN, 'admin');
    expect(res.body.scope).toBe('all');
    const bank = res.body.projects.find((p: any) => p.projectId === B);
    expect(bank).toMatchObject({ activeAlerts: 1, health: 'degraded', errorRate: 0.1 });
  });

  it('a user without projects gets an empty fleet and no queries', async () => {
    const res = await as(request(app()).get('/observability/fleet'), '33333333-0000-4000-8000-00000000000f');
    expect(res.body.projects).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
