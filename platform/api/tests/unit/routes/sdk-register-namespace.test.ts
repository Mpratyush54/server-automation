/**
 * SDK register resolves the environment namespace by the immutable project id, never by the
 * project name: a project created later with the name of a deleted one must get its own
 * namespace. An environment that already has a namespace keeps it.
 */
const mockApps = { createNamespacedDeployment: jest.fn(), replaceNamespacedDeployment: jest.fn() };
const mockCore = { createNamespacedService: jest.fn(), replaceNamespacedService: jest.fn() };
const mockNet = { createNamespacedIngress: jest.fn(), replaceNamespacedIngress: jest.fn() };
const mockCustom = { getNamespacedCustomObject: jest.fn(), createNamespacedCustomObject: jest.fn(), replaceNamespacedCustomObject: jest.fn() };
jest.mock('@kubernetes/client-node', () => {
  const AppsV1Api = function AppsV1Api() {};
  const CoreV1Api = function CoreV1Api() {};
  const NetworkingV1Api = function NetworkingV1Api() {};
  const CustomObjectsApi = function CustomObjectsApi() {};
  const clients = new Map<any, any>([[AppsV1Api, mockApps], [CoreV1Api, mockCore], [NetworkingV1Api, mockNet], [CustomObjectsApi, mockCustom]]);
  return {
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromCluster: jest.fn(), loadFromDefault: jest.fn(), makeApiClient: (api: any) => clients.get(api) || {},
    })),
    AppsV1Api, CoreV1Api, NetworkingV1Api, CustomObjectsApi,
  };
});
const mockEnsureNamespace = jest.fn(async () => {});
jest.mock('../../../src/lib/namespace-baseline', () => ({ ensureProjectNamespace: mockEnsureNamespace }));
jest.mock('../../../src/lib/project-revision', () => ({ projectRevision: jest.fn(async () => 'main') }));
jest.mock('../../../src/config/mongoose', () => ({ connectMongo: jest.fn(async () => true) }));
jest.mock('../../../src/schemas/SdkEvent', () => ({ SdkEventModel: { create: jest.fn(async () => ({})) } }));
jest.mock('../../../src/lib/telemetry-processors', () => ({
  processLogs: jest.fn(async () => {}), processApiMetrics: jest.fn(async () => {}), processTelemetryEvent: jest.fn(async () => {}),
}));


const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKENS: Record<string, string> = {
  sdk_live_oldprojecttoken0000000000000000: OLD,
  sdk_live_newprojecttoken0000000000000000: NEW,
};
let existingEnv: any = null;
const savedEnvs: any[] = [];
const repos: Record<string, any> = {
  SdkCredential: { findOne: jest.fn(async ({ where }: any) => (TOKENS[where.token] ? { id: 's', token: where.token, projectId: TOKENS[where.token], status: 'active', kind: 'server' } : null)) },
  Project: { findOne: jest.fn(async ({ where }: any) => ({ id: where.id, name: 'shop', stack: 'nodejs', repositoryUrl: null, isActive: true, deletedAt: null })), save: jest.fn(async (p: any) => p) },
  Environment: {
    findOne: jest.fn(async () => existingEnv),
    create: jest.fn((e: any) => e),
    save: jest.fn(async (e: any) => { savedEnvs.push({ ...e }); return { id: `env-${savedEnvs.length}`, ...e }; }),
  },
  ServiceRegistration: { findOne: jest.fn(async () => null), create: jest.fn((r: any) => r), save: jest.fn(async (r: any) => ({ id: 'reg-1', ...r })) },
};
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({
    getRepository: (e: any) => repos[typeof e === 'string' ? e : e.name] || { findOne: jest.fn(async () => null) },
  })),
}));

import express from 'express';
import request from 'supertest';
import sdkRouter from '../../../src/routes/sdk';
import { setRedisClientForTests } from '../../../src/lib/redis';
import { assignedNamespace } from '../../../src/lib/project-namespace';

let app: express.Express;
beforeAll(() => {
  setRedisClientForTests(null);
  app = express();
  app.use(express.json());
  app.use('/api', sdkRouter);
});
beforeEach(() => { existingEnv = null; savedEnvs.length = 0; });

const register = (token: string) => request(app).post('/api/sdk/register').set({ Authorization: `Bearer ${token}` })
  .send({ projectName: 'shop', environmentName: 'staging', serviceName: 'api', namespace: 'shop-staging' });

it('gives two projects with the same name different, id-scoped namespaces', async () => {
  const a = await register('sdk_live_oldprojecttoken0000000000000000');
  const b = await register('sdk_live_newprojecttoken0000000000000000');
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  expect(a.body.namespace).toBe(assignedNamespace('shop', 'staging', OLD));
  expect(b.body.namespace).toBe(assignedNamespace('shop', 'staging', NEW));
  expect(a.body.namespace).not.toBe(b.body.namespace);
  // Never the name-only namespace a deleted project of the same name may have left behind.
  expect([a.body.namespace, b.body.namespace]).not.toContain('shop-staging');
  expect(savedEnvs.map((e) => e.domain)).toEqual([
    `${a.body.namespace}.sslip.io`, `${b.body.namespace}.sslip.io`,
  ]);
});

it('keeps the namespace an existing environment already has', async () => {
  existingEnv = { id: 'env-old', name: 'staging', namespace: 'shop-staging', domain: 'shop-staging.sslip.io', projectId: OLD };
  const res = await register('sdk_live_oldprojecttoken0000000000000000');
  expect(res.status).toBe(201);
  expect(res.body.namespace).toBe('shop-staging');
  expect(savedEnvs).toEqual([]);
});

it('refuses tokens of a project that is deleted or being deleted', async () => {
  repos.Project.findOne.mockImplementationOnce(async ({ where }: any) => ({ id: where.id, name: 'shop', isActive: false, deletedAt: null }));
  const res = await register('sdk_live_oldprojecttoken0000000000000000');
  expect(res.status).toBe(401);
});
