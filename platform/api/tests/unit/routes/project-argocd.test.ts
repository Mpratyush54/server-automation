jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({ loadFromDefault: jest.fn(), makeApiClient: () => client })), CustomObjectsApi: jest.fn(),
}));
jest.mock('../../../src/lib/k8s', () => ({ argoAppName: () => 'fallback-app' }));
jest.mock('../../../src/config/database', () => ({ getDb: jest.fn(async () => ({ getRepository: (e: any) => repos[e.name] })) }));

const client = { getNamespacedCustomObject: jest.fn(), patchNamespacedCustomObject: jest.fn() };
const auditSave = jest.fn(async (d: any) => d);
const repos: any = {
  User: { findOne: jest.fn(async ({ where }: any) => ({ id: where.id, role: where.id === 'admin' ? 'admin' : 'developer', isActive: true })) },
  Role: { findOne: jest.fn(async () => null) },
  ProjectMember: { findOne: jest.fn(async ({ where }: any) => where.projectId === 'p' && ['dev', 'viewer'].includes(where.userId) ? { role: where.userId === 'dev' ? 'developer' : 'viewer' } : null) },
  Project: { findOne: jest.fn(async () => ({ id: 'p', name: 'demo', environments: [{ name: 'development', namespace: 'owned-dev' }, { name: 'production', namespace: 'owned-prod' }] })) },
  AuditLog: { create: (d: any) => d, save: auditSave },
};
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import router from '../../../src/routes/project-argocd';
const secret = 'argocd-test-secret-long-enough-0123456789';
const app = express(); app.use(express.json()); app.use(router);
const token = (id: string) => `Bearer ${jwt.sign({ id }, secret)}`;
beforeEach(() => {
  process.env.JWT_SECRET = secret;
  jest.clearAllMocks();
  client.getNamespacedCustomObject.mockResolvedValue({ metadata: { resourceVersion: '5' }, spec: { source: { targetRevision: 'master' } } });
  client.patchNamespacedCustomObject.mockResolvedValue({});
});
it.each(['refresh', 'sync'])('allows project developers to %s and audits the accepted action', async action => {
  const result = await request(app).post(`/projects/p/argocd/${action}`).set('Authorization', token('dev')).send({ env: 'production', appName: 'attacker-selected' });
  expect(result.status).toBe(202);
  expect(client.patchNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ name: 'owned-prod' }));
  expect(auditSave).toHaveBeenCalledWith(expect.objectContaining({ userId: 'dev', action: `argocd.${action}`, targetId: 'p', metadata: { appName: 'owned-prod', environment: 'production' } }));
});
it.each(['viewer', 'outsider'])('denies %s without patching or auditing success', async user => {
  const result = await request(app).post('/projects/p/argocd/sync').set('Authorization', token(user)).send({});
  expect(result.status).toBe(403);
  expect(client.patchNamespacedCustomObject).not.toHaveBeenCalled(); expect(auditSave).not.toHaveBeenCalled();
});
it('requires authentication', async () => {
  expect((await request(app).post('/projects/p/argocd/refresh').send({})).status).toBe(401);
  expect(client.getNamespacedCustomObject).not.toHaveBeenCalled();
});
it('does not accept an environment outside the project', async () => {
  expect((await request(app).post('/projects/p/argocd/refresh').set('Authorization', token('dev')).send({ env: 'other' })).status).toBe(404);
  expect(client.getNamespacedCustomObject).not.toHaveBeenCalled();
});
it('returns conflict for an in-progress sync and writes no success audit', async () => {
  client.getNamespacedCustomObject.mockResolvedValue({ operation: { sync: {} } });
  expect((await request(app).post('/projects/p/argocd/sync').set('Authorization', token('dev')).send({})).status).toBe(409);
  expect(auditSave).not.toHaveBeenCalled();
});
it('surfaces Kubernetes failures without reporting success', async () => {
  client.patchNamespacedCustomObject.mockRejectedValue(new Error('cluster unavailable'));
  expect((await request(app).post('/projects/p/argocd/refresh').set('Authorization', token('dev')).send({})).status).toBe(502);
  expect(auditSave).not.toHaveBeenCalled();
});
