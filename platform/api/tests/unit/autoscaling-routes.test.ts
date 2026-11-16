jest.mock('../../src/config/database', () => ({ getDb: jest.fn() }));
jest.mock('../../src/lib/autoscaling-k8s', () => ({ applyEnvironmentAutoscaling: jest.fn(), readEnvironmentAutoscaling: jest.fn() }));
jest.mock('../../src/lib/project-access', () => ({ requireProjectAccess: jest.fn() }));
jest.mock('../../src/lib/locks', () => ({
  ...jest.requireActual('../../src/lib/locks'), acquireLock: jest.fn(), getLockHolder: jest.fn(),
}));
jest.mock('../../src/middleware/auth', () => ({
  ...jest.requireActual('../../src/middleware/auth'),
  expressAuthenticate: (req: any, res: any, next: any) => {
    if (!req.headers['x-role']) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: 'user', role: req.headers['x-role'] };
    if (req.headers['x-agent']) req.agentToken = {};
    next();
  }, logAudit: jest.fn(),
}));
import express from 'express';
import request from 'supertest';
import router from '../../src/routes/autoscaling';
import { getDb } from '../../src/config/database';
import { requireProjectAccess } from '../../src/lib/project-access';
import { acquireLock } from '../../src/lib/locks';
import { applyEnvironmentAutoscaling, readEnvironmentAutoscaling } from '../../src/lib/autoscaling-k8s';
import { defaultAutoscaling, AutoscalingError } from '../../src/lib/autoscaling';

const app = express().use(express.json()).use(router);
const path = '/projects/project/environments/environment/autoscaling';
const env: any = { id: 'environment', projectId: 'project', namespace: 'project-production', name: 'production', autoscaling: null };
const repo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
const release = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  env.autoscaling = null;
  (getDb as jest.Mock).mockResolvedValue({ getRepository: () => repo });
  repo.findOne.mockResolvedValue(env); repo.find.mockResolvedValue([env]); repo.save.mockResolvedValue(env);
  (requireProjectAccess as jest.Mock).mockResolvedValue({ ok: true });
  (acquireLock as jest.Mock).mockResolvedValue({ release });
  (applyEnvironmentAutoscaling as jest.Mock).mockResolvedValue(undefined);
  (readEnvironmentAutoscaling as jest.Mock).mockResolvedValue({ settings: defaultAutoscaling, workloads: [] });
});
it('requires authentication for reads and writes', async () => {
  expect((await request(app).get(path)).status).toBe(401);
  expect((await request(app).put(path).send(defaultAutoscaling)).status).toBe(401);
  expect(getDb).not.toHaveBeenCalled();
});
it.each(['viewer', 'developer', 'tech_lead'])('forbids writes by %s', async role => {
  expect((await request(app).put(path).set('x-role', role).send(defaultAutoscaling)).status).toBe(403);
  expect(applyEnvironmentAutoscaling).not.toHaveBeenCalled();
});
it('forbids agents on the role-gated write route', async () => {
  expect((await request(app).put(path).set('x-role', 'devops').set('x-agent', 'yes').send(defaultAutoscaling)).status).toBe(403);
});
it('allows project viewers to read and scopes environment lookup to the project', async () => {
  expect((await request(app).get(path).set('x-role', 'viewer')).status).toBe(200);
  expect(requireProjectAccess).toHaveBeenCalledWith(expect.anything(), 'project', 'viewer');
  expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'environment', projectId: 'project' } });
});
it('checks project membership before accessing an environment', async () => {
  (requireProjectAccess as jest.Mock).mockResolvedValue({ ok: false, status: 403, error: 'Forbidden' });
  expect((await request(app).put(path).set('x-role', 'devops').send(defaultAutoscaling)).status).toBe(403);
  expect(repo.findOne).not.toHaveBeenCalled();
});
it.each(['devops', 'admin'])('lets %s save settings under the deployment lock', async role => {
  expect((await request(app).put(path).set('x-role', role).send(defaultAutoscaling)).status).toBe(200);
  expect(requireProjectAccess).toHaveBeenCalledWith(expect.anything(), 'project', 'devops');
  expect(acquireLock).toHaveBeenCalledWith('lock:project:project:deploy:environment', expect.anything());
  expect(env.autoscaling).toEqual(defaultAutoscaling);
  expect(repo.save).toHaveBeenCalledWith(env);
  expect(release).toHaveBeenCalled();
});
it('returns 400 for invalid settings, 404 for unknown environments, and 409 for unavailable KEDA', async () => {
  expect((await request(app).put(path).set('x-role', 'devops').send({ ...defaultAutoscaling, minReplicas: 4 })).status).toBe(400);
  repo.findOne.mockResolvedValueOnce(null);
  expect((await request(app).get(path).set('x-role', 'viewer')).status).toBe(404);
  (applyEnvironmentAutoscaling as jest.Mock).mockRejectedValueOnce(new AutoscalingError('Needs full profile', 409));
  expect((await request(app).put(path).set('x-role', 'devops').send(defaultAutoscaling)).status).toBe(409);
  expect(repo.save).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalled();
});
it('refuses shared namespaces and releases the lock on failure', async () => {
  repo.find.mockResolvedValue([env, { projectId: 'other' }]);
  expect((await request(app).put(path).set('x-role', 'devops').send(defaultAutoscaling)).status).toBe(409);
  expect(applyEnvironmentAutoscaling).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalled();
});
