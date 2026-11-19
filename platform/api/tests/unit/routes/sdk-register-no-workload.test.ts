/**
 * SDK register for a project without a linked repository records the service only. It used to
 * create a "<project>-app" Deployment for a "<project>:latest" image that never exists, which
 * stayed in ErrImagePull next to the real workload.
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

const PROJ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = 'sdk_live_servertoken000000000000000000000';
const repos: Record<string, any> = {
  SdkCredential: { findOne: jest.fn(async ({ where }: any) => (where.token === TOKEN ? { id: 's', token: TOKEN, projectId: PROJ, status: 'active', kind: 'server' } : null)) },
  Project: { findOne: jest.fn(async () => ({ id: PROJ, name: 'demo', stack: 'nodejs', repositoryUrl: null })), save: jest.fn(async (p: any) => p) },
  Environment: {
    findOne: jest.fn(async () => ({ id: 'env-1', name: 'development', namespace: 'demo-development', domain: 'demo-development.example.test', projectId: PROJ })),
    save: jest.fn(async (e: any) => e),
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

let app: express.Express;
beforeAll(() => {
  setRedisClientForTests(null);
  app = express();
  app.use(express.json());
  app.use('/api', sdkRouter);
});

it('registers a service without creating any workload when no repository is linked', async () => {
  const res = await request(app).post('/api/sdk/register').set({ Authorization: `Bearer ${TOKEN}` })
    .send({ projectName: 'demo', environmentName: 'development', serviceName: 'api' });
  expect(res.status).toBe(201);
  expect(res.body.repositoryUrl).toBeNull();
  expect(res.body.gitops).toBeNull();
  for (const fn of [...Object.values(mockApps), ...Object.values(mockCore), ...Object.values(mockNet), ...Object.values(mockCustom)]) {
    expect(fn).not.toHaveBeenCalled();
  }
  expect(mockEnsureNamespace).not.toHaveBeenCalled();
});
