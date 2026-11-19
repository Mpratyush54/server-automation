import express from 'express';
import request from 'supertest';
const mockProjects: any[] = [];
const mockProjectRepo = {
  findOne: jest.fn(async ({ where }: any) => mockProjects.find(p => Object.entries(where).every(([k, v]: any) => {
    if (v && typeof v === 'object' && v._type === 'not') return p[k] !== v._value;
    return p[k] === v;
  })) || null),
  create: (d: any) => ({ ...d }),
  save: jest.fn(async (p: any) => {
    const i = mockProjects.findIndex(x => x.id === p.id);
    if (i >= 0) mockProjects[i] = { ...p }; else mockProjects.push({ ...p });
    return p;
  }),
};
const mockEnvRepo = { create: (d: any) => d, save: jest.fn(async (d: any) => d), find: jest.fn(async () => []) };
jest.mock('../../../src/config/database', () => ({ getDb: async () => ({ getRepository: (e: any) => e.name === 'Project' ? mockProjectRepo : mockEnvRepo }) }));
const mockUser = { id: 'u', role: 'devops' };
jest.mock('../../../src/middleware/auth', () => ({
  expressAuthenticate: (req: any, _res: any, next: any) => { req.user = { ...mockUser }; next(); },
  expressRequireRole: () => (_req: any, _res: any, next: any) => next(),
  requireRecentMfa: () => (_req: any, _res: any, next: any) => next(),
  logAudit: jest.fn(async () => undefined),
}));
jest.mock('../../../src/lib/project-access', () => ({
  requireProjectAccess: async () => ({ ok: true, membership: null }), ensureProjectOwner: jest.fn(), listAccessibleProjectIds: jest.fn(), isGlobalProjectAdmin: jest.fn(),
}));
jest.mock('@kubernetes/client-node', () => ({ KubeConfig: class {}, CustomObjectsApi: class {} }));
jest.mock('../../../src/lib/argocd', () => ({ mapArgoStatus: jest.fn() }));
jest.mock('../../../src/lib/project-revision', () => ({ explicitRevision: (v: any) => v, projectRevision: jest.fn() }));
jest.mock('../../../src/lib/k8s', () => ({ argoAppName: () => 'app' }));
jest.mock('../../../src/lib/kube-config', () => ({ loadKubeConfig: jest.fn() }));
jest.mock('../../../src/lib/telemetry-origins', () => ({ requestTelemetryOriginsSync: jest.fn() }));
jest.mock('../../../src/lib/namespace-baseline', () => ({ namespaceBaselineStatus: jest.fn() }));
import router from '../../../src/routes/projects';
const app = express(); app.use(express.json(), router);

beforeEach(() => {
  jest.clearAllMocks(); mockProjects.length = 0; mockUser.role = 'devops';
  mockProjects.push({ id: 'a', name: 'a', isActive: true, repositoryUrl: 'https://github.com/acme/app.git', repositoryKey: 'github.com/acme/app', environments: [] });
});

it('refuses to link a repository that another active project already links', async () => {
  const created = await request(app).post('/projects').send({ name: 'b', stack: 'nodejs', repositoryUrl: 'https://GitHub.com/Acme/App/' });
  expect(created.status).toBe(409); expect(created.body.error).toBe('This repository is already linked to another project');
  expect(created.body.code).toBe('repository_in_use');
  mockProjects.push({ id: 'b', name: 'b', isActive: true, repositoryUrl: null, repositoryKey: null, environments: [] });
  const updated = await request(app).put('/projects/b').send({ repositoryUrl: 'git@github.com:acme/app.git' });
  expect(updated.status).toBe(409);
});

it('allows a repository previously linked only by an inactive project', async () => {
  mockProjects[0].isActive = false;
  const created = await request(app).post('/projects').send({ name: 'b', stack: 'nodejs', repositoryUrl: 'https://github.com/acme/app' });
  expect(created.status).toBe(201);
  expect(mockProjects.find(p => p.name === 'b')).toMatchObject({ repositoryKey: 'github.com/acme/app', repositoryApprovedAt: null });
});

it('maps a concurrent unique-index violation to the same conflict', async () => {
  mockProjectRepo.save.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505', constraint: 'projects_repository_key_active' }));
  const created = await request(app).post('/projects').send({ name: 'c', stack: 'nodejs', repositoryUrl: 'https://github.com/acme/fresh' });
  expect(created.status).toBe(409);
});

it('clears the build approval when the repository changes', async () => {
  Object.assign(mockProjects[0], { repositoryApprovedBy: 'admin', repositoryApprovedAt: new Date(), repositoryApprovedKey: 'github.com/acme/app' });
  expect((await request(app).put('/projects/a').send({ repositoryUrl: 'https://github.com/acme/app/' })).status).toBe(200);
  expect(mockProjects[0].repositoryApprovedKey).toBe('github.com/acme/app');
  expect((await request(app).put('/projects/a').send({ repositoryUrl: 'https://github.com/acme/next' })).status).toBe(200);
  expect(mockProjects[0]).toMatchObject({ repositoryKey: 'github.com/acme/next', repositoryApprovedBy: null, repositoryApprovedAt: null, repositoryApprovedKey: null });
});

it('lets only a platform administrator change the repository while build-on-push is enabled', async () => {
  mockProjects[0].environments = [{ id: 'e', isActive: true, buildOnPush: true }];
  const denied = await request(app).put('/projects/a').send({ repositoryUrl: 'https://github.com/acme/next' });
  expect(denied.status).toBe(403); expect(mockProjects[0].repositoryKey).toBe('github.com/acme/app');
  mockUser.role = 'admin';
  expect((await request(app).put('/projects/a').send({ repositoryUrl: 'https://github.com/acme/next' })).status).toBe(200);
  expect(mockProjects[0].repositoryApprovedKey).toBeNull();
});
