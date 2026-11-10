import express from 'express';
import request from 'supertest';
import router from '../../src/routes/error-tracking';
import { ingestTelemetry } from '../../src/lib/telemetry-queue';
import { requireProjectAccess } from '../../src/lib/project-access';
import { verifyIngestToken, originAllowed } from '../../src/lib/telemetry-tokens';
import { getDb } from '../../src/config/database';
jest.mock('../../src/config/database', () => ({ getDb: jest.fn() }));
jest.mock('../../src/lib/telemetry-queue', () => ({ ingestTelemetry: jest.fn(), TelemetryBackpressureError: class extends Error {} }));
jest.mock('../../src/lib/project-access', () => ({ requireProjectAccess: jest.fn(), userCanAccessProject: jest.fn() }));
jest.mock('../../src/lib/telemetry-tokens', () => ({ verifyIngestToken: jest.fn(), originAllowed: jest.fn() }));
jest.mock('../../src/middleware/auth', () => ({
  allowBrowserSdkToken: (r: any, _: any, next: any) => { r.browserSdkTokenAllowed = true; next(); },
  sdkTokenAuth: (r: any, s: any, next: any) => { if (!r.header('Authorization')) return s.sendStatus(401); r.projectId = '11111111-1111-4111-8111-111111111111'; next(); },
  expressAuthenticate: (r: any, s: any, next: any) => { if (!r.header('Authorization')) return s.sendStatus(401); if (r.header('Authorization') === 'Bearer ci') r.agentToken = { scopes: ['projects:read'] }; next(); },
}));
const app = express(); app.use(express.json()); app.use(router);
const project = '11111111-1111-4111-8111-111111111111';
const payload = { type: 'Error', message: 'test', frames: [], environment: 'prod', release: '1.0.0', projectId: 'attacker' };
beforeEach(() => { jest.clearAllMocks(); (requireProjectAccess as jest.Mock).mockResolvedValue({ ok: true }); });
test('ingest requires auth, binds project from credential and is write-only', async () => {
  expect((await request(app).post('/sdk/errors').send(payload)).status).toBe(401);
  const res = await request(app).post('/sdk/errors').set('Authorization', 'Bearer browser').send(payload);
  expect(res.status).toBe(202); expect(res.body).toEqual({ accepted: true });
  expect(ingestTelemetry).toHaveBeenCalledWith('errors', project, { projectId: project, event: expect.not.objectContaining({ projectId: 'attacker' }) });
});
test('RUM verifies browser origin and environment comes from signed claims', async () => {
  (verifyIngestToken as jest.Mock).mockResolvedValue({ ok: true, claims: { typ: 'web', projectId: project, environment: 'signed-env', origins: [] } });
  (originAllowed as jest.Mock).mockReturnValue(false);
  expect((await request(app).post('/errors/rum').send(payload)).status).toBe(403);
  (originAllowed as jest.Mock).mockReturnValue(true);
  expect((await request(app).post('/errors/rum').send(payload)).status).toBe(202);
  expect(ingestTelemetry).toHaveBeenCalledWith('errors', project, expect.objectContaining({ event: expect.objectContaining({ environment: 'signed-env' }) }));
});
test('CI project read grant cannot upload source maps; denied project cannot list or triage', async () => {
  expect((await request(app).post(`/projects/${project}/releases/1/sourcemaps`).set('Authorization', 'Bearer ci').send({ file: 'a.js', map: {} })).status).toBe(403);
  (requireProjectAccess as jest.Mock).mockResolvedValue({ ok: false, status: 403, error: 'Forbidden' });
  expect((await request(app).get(`/projects/${project}/errors`).set('Authorization', 'Bearer human')).status).toBe(403);
  expect((await request(app).patch(`/projects/${project}/errors/${project}`).set('Authorization', 'Bearer human').send({ status: 'resolved' })).status).toBe(403);
  expect(getDb).not.toHaveBeenCalled();
});
