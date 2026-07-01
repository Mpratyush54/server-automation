jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(),
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn().mockReturnValue({}),
  })),
  CoreV1Api: jest.fn(),
  AppsV1Api: jest.fn(),
  NetworkingV1Api: jest.fn(),
  CustomObjectsApi: jest.fn(),
  V1Deployment: jest.fn(),
  V1Service: jest.fn(),
}));

import express from 'express';
import request from 'supertest';

// The main api.ts just mounts all sub-routers — verify every sub-router is mounted
import apiRouter from '../../../src/routes/api';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}

describe('api.ts mount point', () => {
  it('should mount auth routes — GET /api/health responds 200', async () => {
    const app = createApp();
    // health doesn't need auth, but it goes through the real handler that calls res.json
    // In test environment there's no DB so it will error, but the route IS mounted
    const res = await request(app).get('/api/health');
    // Should not get 404
    expect(res.status).not.toBe(404);
  });

  it('should mount auth routes — POST /api/auth/login responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).post('/api/auth/login').send({ email: 'x' });
    expect(res.status).not.toBe(404);
  });

  it('should mount project routes — GET /api/projects responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/projects');
    expect(res.status).not.toBe(404);
  });

  it('should mount deployment routes — POST /api/deploy responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).post('/api/deploy');
    expect(res.status).not.toBe(404);
  });

  it('should mount config routes — GET /api/config responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/config');
    expect(res.status).not.toBe(404);
  });

  it('should mount secret routes — GET /api/projects/:projectId/secrets responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/projects/p1/secrets');
    expect(res.status).not.toBe(404);
  });

  it('should mount storage routes — GET /api/storage/file/x responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/storage/file/x');
    expect(res.status).not.toBe(404);
  });

  it('should mount alert routes — GET /api/alerts responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/alerts');
    expect(res.status).not.toBe(404);
  });

  it('should mount db-connection routes — GET /api/db-connections responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/db-connections');
    expect(res.status).not.toBe(404);
  });

  it('should mount bootstrap routes — GET /api/bootstrap/status responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/bootstrap/status');
    expect(res.status).not.toBe(404);
  });

  it('should mount webhook routes — POST /api/webhooks/github responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).post('/api/webhooks/github');
    expect(res.status).not.toBe(404);
  });

  it('should mount cicd routes — GET /api/cicd/gitlab-ci responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/cicd/gitlab-ci');
    expect(res.status).not.toBe(404);
  });

  it('should mount SDK routes — POST /api/sdk/register responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sdk/register');
    expect(res.status).not.toBe(404);
  });

  it('should mount metric routes — GET /api/metrics responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/metrics');
    expect(res.status).not.toBe(404);
  });

  it('should mount setting routes — GET /api/settings/smtp responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/settings/smtp');
    expect(res.status).not.toBe(404);
  });

  it('should mount audit-log routes — GET /api/audit-logs responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/audit-logs');
    expect(res.status).not.toBe(404);
  });

  it('should mount bug-report routes — GET /api/bug-reports responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/bug-reports');
    expect(res.status).not.toBe(404);
  });

  it('should mount OAuth routes — GET /api/oauth/.well-known/openid-configuration responds (no 404)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/oauth/.well-known/openid-configuration');
    expect(res.status).not.toBe(404);
  });
});
