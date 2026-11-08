import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

const mockRepos: Record<string, any> = {};
jest.mock('../../src/config/database', () => ({ getDb: async () => ({ getRepository: (entity: any) => mockRepos[entity.name] }) }));
jest.mock('../../src/middleware/auth', () => ({
  expressAuthenticate: (req: any, res: any, next: any) => { if (req.path.startsWith('/webhooks/') && !req.get('authorization')) return res.status(401).json({ error: 'Bearer token required' }); req.user = { id: 'caller', role: req.get('x-role') || 'developer' }; next(); },
  expressRequireRole: () => (_req: any, _res: any, next: any) => next(),
  requireAgentScopeOrRole: () => (_req: any, _res: any, next: any) => next(),
  logAudit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@kubernetes/client-node', () => ({ KubeConfig: class {} }));
jest.mock('../../src/lib/k8s', () => ({ operateProjectWorkloads: jest.fn().mockResolvedValue(undefined), previewResourceName: () => 'preview-owned' }));
jest.mock('../../src/lib/gitlab', () => ({ triggerPipeline: jest.fn() }));
jest.mock('../../src/lib/clickup', () => ({ extractTaskId: () => null }));
jest.mock('../../src/config/mongoose', () => ({ connectMongo: jest.fn() }));
const mockLogChain: any = { sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) };
jest.mock('../../src/schemas/MetricsRaw', () => ({ MetricsRawModel: { find: (...args: any[]) => mockLogFind(...args) } }));
const mockLogFind = jest.fn((..._args: any[]) => mockLogChain);
jest.mock('../../src/schemas/Log', () => ({ LogModel: { find: (...args: any[]) => mockLogFind(...args), countDocuments: jest.fn().mockResolvedValue(0) } }));

import deployments from '../../src/routes/deployments';
import projects from '../../src/routes/projects';
import connections from '../../src/routes/db-connections';
import alerts from '../../src/routes/alerts';
import logs from '../../src/routes/audit-logs';
import webhooks from '../../src/routes/webhooks';
import bootstrap from '../../src/routes/bootstrap';
import metrics from '../../src/routes/metrics';
import dbProvision from '../../src/routes/db-provision';
import cicd from '../../src/routes/cicd';
import notifications from '../../src/routes/notifications';
import { operateProjectWorkloads } from '../../src/lib/k8s';

const own = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
function repo(rows: any[] = []): any {
  return { findOne: jest.fn(async ({ where }: any) => rows.find(row => Object.entries(where).every(([key, value]) => row[key] === value)) || null),
    find: jest.fn(async () => rows), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x), remove: jest.fn() };
}
function app(raw = true) {
  const result = express();
  result.use(express.json({ verify: (req: any, _res, buffer) => { if (raw) req.rawBody = buffer; } }));
  for (const router of [deployments, projects, connections, alerts, logs, webhooks, bootstrap, metrics, dbProvision, cicd, notifications]) result.use(router);
  return result;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockRepos.ProjectMember = repo([{ projectId: own, userId: 'caller', role: 'devops' }]);
  mockRepos.Project = repo([{ id: own, name: 'own' }, { id: foreign, name: 'foreign' }]);
  mockRepos.Environment = repo([{ id: 'own-env', projectId: own, name: 'production', namespace: 'own-ns' }, { id: 'foreign-env', projectId: foreign }]);
  mockRepos.Deployment = repo([{ id: 'own-dep', projectId: own, environmentId: 'own-env' }, { id: 'foreign-dep', projectId: foreign, environmentId: 'foreign-env' }]);
  mockRepos.DbConnection = repo([{ id: 'connection', projectId: foreign }]);
  mockRepos.Alert = repo([{ id: 'alert', projectId: foreign }]);
  mockRepos.SdkCredential = repo([]);
  mockRepos.Notification = repo([{ id: 'foreign-notification', userId: 'caller', metadata: { projectId: foreign } }, { id: 'own-notification', userId: 'caller', metadata: { projectId: own } }]);
  mockRepos.AuditLog = repo([{ targetType: 'Project', targetId: foreign }, { targetType: 'Project', targetId: own }]);
  (operateProjectWorkloads as jest.Mock).mockResolvedValue(undefined);
  process.env.GITHUB_WEBHOOK_SECRET = 'github-test-secret';
  process.env.GITLAB_WEBHOOK_SECRET = 'gitlab-test-secret';
  process.env.CLICKUP_WEBHOOK_SECRET = 'clickup-test-secret';
});

describe('project isolation', () => {
  it.each([
    ['get', `/deployments/${foreign}`, undefined],
    ['get', `/metrics?projectId=${foreign}`, undefined],
    ['get', `/alerts?projectId=${foreign}`, undefined],
    ['get', `/db-connections?projectId=${foreign}`, undefined],
    ['post', `/projects/${foreign}/databases/provision`, { environment: 'production' }],
    ['post', `/cicd/register-webhook/${foreign}`, {}],
    ['post', '/notifications/foreign-notification/read', {}],
    ['post', '/deploy', { projectId: foreign, environmentId: 'foreign-env' }],
    ['post', '/rollback', { deploymentId: 'foreign-dep' }],
    ['post', '/deployments/foreign-dep/restart', {}],
    ['patch', '/deployments/foreign-dep/scale', { replicas: 2 }],
    ['post', '/deployments/foreign-dep/terminate', {}],
    ['get', `/projects/${foreign}/tokens`, undefined],
    ['put', `/projects/${foreign}`, { description: 'unauthorized' }],
    ['post', '/db-connections/connection/test', {}],
    ['delete', '/db-connections/connection', undefined],
    ['put', '/alerts/alert', { enabled: false }],
    ['delete', '/alerts/alert', undefined],
  ])('denies foreign resource: %s %s', async (method, url, body) => {
    const response = await (request(app()) as any)[method as string](url).send(body);
    expect(response.status).toBe(403);
    expect(operateProjectWorkloads).not.toHaveBeenCalled();
  });
  it('filters project notifications and audit records after membership is revoked', async () => {
    const notificationResponse = await request(app()).get('/notifications');
    expect(notificationResponse.status).toBe(200);
    expect(notificationResponse.body.items.map((item: any) => item.id)).toEqual(['own-notification']);
    const auditResponse = await request(app()).get('/audit-logs');
    expect(auditResponse.status).toBe(200);
    expect(auditResponse.body).toEqual([{ targetType: 'Project', targetId: own }]);
  });
  it('does not rename an existing namespace when the project domain changes', async () => {
    mockRepos.Environment.find.mockResolvedValue([{ id: 'own-env', projectId: own, name: 'production', namespace: 'legacy-owned-namespace' }]);
    const response = await request(app()).put(`/projects/${own}`).send({ domain: 'new.example.com' });
    expect(response.status).toBe(200);
    expect(mockRepos.Environment.save).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'legacy-owned-namespace', domain: 'legacy-owned-namespace.new.example.com' }));
  });
  it('rejects an environment from another project before saving a deployment', async () => {
    const response = await request(app()).post('/deploy').send({ projectId: own, environmentId: 'foreign-env' });
    expect(response.status).toBe(404);
    expect(mockRepos.Environment.findOne).toHaveBeenCalledWith({ where: { id: 'foreign-env', projectId: own } });
    expect(mockRepos.Deployment.save).not.toHaveBeenCalled();
  });
  it.each([['restart', 'post'], ['scale', 'patch'], ['terminate', 'post']])('calls infrastructure before %s succeeds', async (operation, method) => {
    const response = await (request(app()) as any)[method](`/deployments/own-dep/${operation}`).send({ replicas: 3 });
    expect(response.status).toBe(200);
    expect(operateProjectWorkloads).toHaveBeenCalledWith('own-ns', 'own-ns', operation, operation === 'scale' ? 3 : undefined);
  });
  it('rejects legacy namespaces shared by multiple projects before mutating infrastructure', async () => {
    mockRepos.Environment.find.mockResolvedValue([{ namespace: 'own-ns', projectId: own }, { namespace: 'own-ns', projectId: foreign }]);
    const response = await request(app()).post('/deployments/own-dep/terminate');
    expect(response.status).toBe(400);
    expect(operateProjectWorkloads).not.toHaveBeenCalled();
    expect(mockRepos.Deployment.save).not.toHaveBeenCalled();
  });
  it('does not persist success when Kubernetes rejects the operation', async () => {
    (operateProjectWorkloads as jest.Mock).mockRejectedValueOnce(new Error('cluster unavailable'));
    const response = await request(app()).post('/deployments/own-dep/terminate');
    expect(response.status).toBe(400);
    expect(mockRepos.Deployment.save).not.toHaveBeenCalled();
  });
  it('escapes log search patterns, caps limits, and constrains accessible projects', async () => {
    const response = await request(app()).get('/logs/search').query({ search: '(a+)+$', limit: 999999 });
    expect(response.status).toBe(200);
    const filter = mockLogFind.mock.calls[0][0];
    expect(filter.$or).toEqual([{ projectId: { $in: [own, 'own'] } }]);
    expect(filter.message.$regex).toBe('\\(a\\+\\)\\+\\$');
    expect(mockLogChain.limit).toHaveBeenCalledWith(500);
  });
  it('coerces Mongo query operators to strings', async () => {
    const response = await request(app()).get('/logs/search?level[$ne]=INFO&serviceName[$ne]=other');
    expect(response.status).toBe(200);
    expect(mockLogFind.mock.calls[0][0].level).toBe('[object Object]');
    expect(mockLogFind.mock.calls[0][0].serviceName).toBe('[object Object]');
  });
});

describe('provider-only webhook authentication', () => {
  const payload = '{  "event" : "ignored" }';
  it('accepts exact GitHub raw bytes without a bearer token', async () => {
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(payload).digest('hex');
    expect((await request(app()).post('/webhooks/github').set('Content-Type', 'application/json').set('x-hub-signature-256', signature).send(payload)).status).toBe(200);
    expect((await request(app(false)).post('/webhooks/github').set('Content-Type', 'application/json').set('x-hub-signature-256', signature).send(payload)).status).toBe(401);
    expect((await request(app()).post('/webhooks/github').set('x-hub-signature-256', 'short').send({})).status).toBe(401);
  });
  it('requires a configured GitLab token and compares it exactly', async () => {
    expect((await request(app()).post('/webhooks/gitlab').set('x-gitlab-token', process.env.GITLAB_WEBHOOK_SECRET!).send({})).status).toBe(200);
    delete process.env.GITLAB_WEBHOOK_SECRET;
    delete process.env.GITLAB_WEBHOOK_TOKEN;
    expect((await request(app()).post('/webhooks/gitlab').send({})).status).toBe(401);
  });
  it('requires ClickUp raw bytes and its HMAC', async () => {
    const signature = crypto.createHmac('sha256', process.env.CLICKUP_WEBHOOK_SECRET!).update(payload).digest('hex');
    expect((await request(app()).post('/integrations/clickup/webhook').set('Content-Type', 'application/json').set('x-signature', signature).send(payload)).status).toBe(200);
    expect((await request(app()).post('/integrations/clickup/webhook').send({})).status).toBe(401);
    delete process.env.CLICKUP_WEBHOOK_SECRET;
    expect((await request(app()).post('/integrations/clickup/webhook').set('x-signature', signature).send({})).status).toBe(401);
  });
});
