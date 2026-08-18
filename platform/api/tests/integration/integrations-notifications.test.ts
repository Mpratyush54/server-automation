/**
 * Integrations, OAuth providers, notifications, and secret rotation routes.
 */

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class { loadFromDefault() {} makeApiClient() { return {}; } },
  CustomObjectsApi: class {},
}));
jest.mock('../../src/lib/k8s', () => ({
  checkK8sConnection: jest.fn().mockResolvedValue(true),
  getK8sNodes: jest.fn().mockResolvedValue([]),
  getK8sNamespaces: jest.fn().mockResolvedValue([]),
  getK8sPods: jest.fn().mockResolvedValue([]),
  getPodLogs: jest.fn().mockResolvedValue(''),
  deletePod: jest.fn().mockResolvedValue(true),
  updateArgoCDApp: jest.fn().mockResolvedValue(true),
  patchSecretData: jest.fn().mockResolvedValue(undefined),
  restartNamedDeployment: jest.fn().mockResolvedValue(undefined),
  upsertSecretData: jest.fn().mockResolvedValue(undefined),
  readSecretData: jest.fn().mockResolvedValue({}),
  deleteSecret: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/lib/lokilog', () => ({ forwardToLoki: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/config/mongoose', () => ({ connectMongo: jest.fn().mockResolvedValue(true) }));
jest.mock('pg', () => ({
  Client: class {
    connect = jest.fn().mockResolvedValue(undefined);
    query = jest.fn().mockResolvedValue({ rowCount: 1 });
    end = jest.fn().mockResolvedValue(undefined);
  },
}));
jest.mock('ioredis', () => ({
  __esModule: true,
  default: class {
    connect = jest.fn().mockResolvedValue(undefined);
    config = jest.fn().mockResolvedValue('OK');
    auth = jest.fn().mockResolvedValue('OK');
    disconnect = jest.fn();
  },
}));

const bcrypt = require('bcryptjs');
const TEST_PASSWORD = 'TestPass123';
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

const ADMIN = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'admin@pratyushes.dev',
  username: 'admin',
  name: 'Admin',
  role: 'admin',
  roleId: null,
  isActive: true,
  passwordHash: TEST_HASH,
  githubId: null,
  gitlabId: null,
};

const DEVELOPER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'john@pratyushes.dev',
  username: 'john',
  name: 'John Dev',
  role: 'developer',
  roleId: null,
  isActive: true,
  passwordHash: TEST_HASH,
};

let integrationRow: any = {
  id: 'int-1',
  githubClientId: null,
  githubClientSecret: null,
  githubToken: null,
  githubOrg: null,
  gitlabUrl: 'https://gitlab.com',
  gitlabClientId: null,
  gitlabClientSecret: null,
  gitlabToken: null,
  gitlabGroup: null,
  clickupToken: null,
  clickupListId: null,
  infisicalUrl: null,
  infisicalToken: null,
  githubLoginEnabled: true,
  gitlabLoginEnabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const notifications: any[] = [];

const mockUserRepo = {
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([ADMIN, DEVELOPER]),
  save: jest.fn().mockImplementation((u: any) => Promise.resolve(u)),
  create: jest.fn().mockImplementation((d: any) => ({ id: 'new-user', ...d })),
};

const mockIntegrationRepo = {
  find: jest.fn().mockImplementation(() => Promise.resolve([integrationRow])),
  save: jest.fn().mockImplementation((d: any) => {
    integrationRow = { ...integrationRow, ...d };
    return Promise.resolve(integrationRow);
  }),
  create: jest.fn().mockImplementation((d: any) => ({ id: 'int-1', ...d })),
};

const mockNotificationRepo = {
  find: jest.fn().mockImplementation(({ where }: any) => {
    const items = notifications.filter((n) => n.userId === where.userId);
    return Promise.resolve(items);
  }),
  findOne: jest.fn().mockImplementation(({ where }: any) => {
    return Promise.resolve(notifications.find((n) => n.id === where.id && n.userId === where.userId) || null);
  }),
  save: jest.fn().mockImplementation((n: any) => {
    if (!n.id) n.id = `n-${notifications.length + 1}`;
    const idx = notifications.findIndex((x) => x.id === n.id);
    if (idx >= 0) notifications[idx] = n;
    else notifications.push(n);
    return Promise.resolve(n);
  }),
  create: jest.fn().mockImplementation((d: any) => ({ ...d })),
};

const mockAuditRepo = {
  create: jest.fn().mockImplementation((d: any) => d),
  save: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockResolvedValue([]),
};

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue({
    getRepository: (entity: any) => {
      const name = typeof entity === 'string' ? entity : entity?.name;
      if (name === 'User') return mockUserRepo;
      if (name === 'IntegrationSettings') return mockIntegrationRepo;
      if (name === 'Notification') return mockNotificationRepo;
      if (name === 'AuditLog') return mockAuditRepo;
      if (name === 'Role') return { findOne: jest.fn().mockResolvedValue(null) };
      return {
        findOne: jest.fn(),
        find: jest.fn().mockResolvedValue([]),
        save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
        create: jest.fn().mockImplementation((d: any) => d),
      };
    },
  }),
  reconnectPostgres: jest.fn().mockResolvedValue({}),
  isPostgresAuthError: () => false,
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import apiRouter from '../../src/routes/api';

const JWT_SECRET = 'plat-super-secret-key';
const adminToken = jwt.sign(
  { id: ADMIN.id, email: ADMIN.email, name: ADMIN.name, role: ADMIN.role },
  JWT_SECRET,
  { expiresIn: '2h' },
);
const devToken = jwt.sign(
  { id: DEVELOPER.id, email: DEVELOPER.email, name: DEVELOPER.name, role: DEVELOPER.role },
  JWT_SECRET,
  { expiresIn: '2h' },
);

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('integrations + notifications + rotate', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

  beforeEach(() => {
    notifications.length = 0;
    integrationRow.githubClientId = null;
    integrationRow.githubClientSecret = null;
    integrationRow.gitlabClientId = null;
    integrationRow.gitlabClientSecret = null;
    mockUserRepo.findOne.mockImplementation(({ where }: any) => {
      if (where?.id === ADMIN.id || where?.email === ADMIN.email) return Promise.resolve({ ...ADMIN });
      if (where?.id === DEVELOPER.id) return Promise.resolve({ ...DEVELOPER });
      return Promise.resolve(null);
    });
  });

  it('GET /auth/providers is public and reports unconfigured OAuth', async () => {
    const res = await request(app).get('/api/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body.github.enabled).toBe(false);
    expect(res.body.gitlab.enabled).toBe(false);
  });

  it('saves GitHub and GitLab OAuth apps then enables providers', async () => {
    const put = await request(app)
      .put('/api/settings/integrations')
      .set(authHeader(adminToken))
      .send({
        githubLoginEnabled: true,
        githubClientId: 'gh-client',
        githubClientSecret: 'gh-secret',
        gitlabLoginEnabled: true,
        gitlabUrl: 'https://gitlab.com',
        gitlabClientId: 'gl-client',
        gitlabClientSecret: 'gl-secret',
        githubToken: 'ghp_link',
        gitlabToken: 'glpat_link',
      });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.providers.github.enabled).toBe(true);
    expect(put.body.providers.gitlab.enabled).toBe(true);

    const pub = await request(app).get('/api/auth/providers');
    expect(pub.body.github.enabled).toBe(true);
    expect(pub.body.gitlab.enabled).toBe(true);

    const get = await request(app)
      .get('/api/settings/integrations')
      .set(authHeader(adminToken));
    expect(get.status).toBe(200);
    expect(get.body.githubClientId).toBe('gh-client');
    expect(get.body.githubClientSecret.set).toBe(true);
    expect(get.body.callbackUrls.github).toContain('/api/auth/github/callback');
  });

  it('rejects developers from integrations and rotate', async () => {
    const integ = await request(app)
      .put('/api/settings/integrations')
      .set(authHeader(devToken))
      .send({ githubClientId: 'x' });
    expect(integ.status).toBe(403);

    const rotate = await request(app)
      .post('/api/settings/rotate-secrets')
      .set(authHeader(devToken))
      .send({ confirm: 'ROTATE' });
    expect(rotate.status).toBe(403);
  });

  it('requires ROTATE confirm and then returns one-time secret values', async () => {
    const denied = await request(app)
      .post('/api/settings/rotate-secrets')
      .set(authHeader(adminToken))
      .send({ confirm: 'nope' });
    expect(denied.status).toBe(400);

    const ok = await request(app)
      .post('/api/settings/rotate-secrets')
      .set(authHeader(adminToken))
      .send({ confirm: 'ROTATE' });
    expect(ok.status).toBe(200);
    expect(ok.body.values.ADMIN_PASSWORD).toBeTruthy();
    expect(ok.body.values.POSTGRES_PASSWORD).toBeTruthy();
    expect(ok.body.values).not.toHaveProperty('JWT_SECRET');
  });

  it('lists, marks, and counts notifications for the current user', async () => {
    notifications.push({
      id: 'n-1',
      userId: ADMIN.id,
      title: 'Hello',
      body: 'World',
      kind: 'info',
      link: '/profile',
      readAt: null,
      createdAt: new Date(),
    });
    notifications.push({
      id: 'n-2',
      userId: DEVELOPER.id,
      title: 'Other',
      body: null,
      kind: 'info',
      link: null,
      readAt: null,
      createdAt: new Date(),
    });

    const list = await request(app).get('/api/notifications').set(authHeader(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.unreadCount).toBe(1);

    const read = await request(app).post('/api/notifications/n-1/read').set(authHeader(adminToken));
    expect(read.status).toBe(200);
    expect(read.body.readAt).toBeTruthy();

    const after = await request(app).get('/api/notifications').set(authHeader(adminToken));
    expect(after.body.unreadCount).toBe(0);
  });
});
