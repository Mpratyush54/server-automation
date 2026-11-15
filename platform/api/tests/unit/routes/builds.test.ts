import express from 'express';
import request from 'supertest';
const mockRepo = { find: jest.fn(async () => []), findOneBy: jest.fn(), save: jest.fn(), update: jest.fn(async (..._a: any[]) => ({ affected: 1 })) };
const mockAudit = jest.fn(async (..._a: any[]) => undefined);
const approvedProject = { id: 'p', repositoryUrl: 'https://github.com/acme/app.git', repositoryKey: 'github.com/acme/app', repositoryApprovedAt: new Date(), repositoryApprovedKey: 'github.com/acme/app' };
const mockAuthUser: any = { id: 'user', role: 'devops' };
jest.mock('../../../src/config/database', () => ({ getDb: async () => ({ getRepository: () => mockRepo }) }));
jest.mock('../../../src/middleware/auth', () => ({ expressAuthenticate: (req: any, res: any, next: any) => {
  if (!req.headers.authorization) return res.sendStatus(401);
  req.user = { ...mockAuthUser }; if (req.headers['x-agent']) req.agentToken = { scopes: ['*'] }; next();
}, logAudit: (...a: any[]) => mockAudit(...a) }));
jest.mock('../../../src/middleware/idempotency', () => ({ idempotency: () => (_req: any, _res: any, next: any) => next() }));
const mockAccess = jest.fn();
jest.mock('../../../src/lib/project-access', () => ({ requireProjectAccess: (...args: any[]) => mockAccess(...args) }));
const mockEnqueue = jest.fn(async (..._args: any[]) => ({ id: 'b', status: 'queued' }));
const mockManual = jest.fn(async (..._args: any[]) => undefined);
jest.mock('../../../src/lib/build-op', () => {
  class BuildLimitError extends Error {}
  class BuildSupersededError extends Error {}
  return { BuildLimitError, BuildSupersededError, buildsEnabled: () => process.env.BUILDS_ENABLED === 'true', enqueueBuild: (...args: any[]) => mockEnqueue(...args),
    assertManualBuildAllowed: (...args: any[]) => mockManual(...args) };
});
jest.mock('../../../src/lib/git-remote', () => ({ fetchBranchCommits: jest.fn(async () => [{ sha: 'a'.repeat(40) }]),
  parseGitRemote: jest.requireActual('../../../src/lib/git-remote').parseGitRemote }));
import router from '../../../src/routes/builds';
const app = express(); app.use(express.json(), router);
const base = '/projects/p/builds';
beforeEach(() => { jest.clearAllMocks(); mockRepo.findOneBy.mockReset(); mockAuthUser.role = 'devops'; mockAccess.mockResolvedValue({ ok: true }); process.env.BUILDS_ENABLED = 'true'; });

it.each([['get', base], ['post', base], ['patch', `${base}/settings`], ['get', `${base}/b/logs`]])('requires authentication for %s %s', async (method, url) => {
  const result = await (request(app) as any)[method](url);
  expect(result.status).toBe(401); expect(mockRepo.find).not.toHaveBeenCalled();
});
it('denies access to another project and requires devops for manual deployments', async () => {
  mockAccess.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden' });
  expect((await request(app).post(base).set('Authorization', 'test').send({ environmentId: 'e', branch: 'main' })).status).toBe(403);
  expect(mockAccess.mock.calls[0][2]).toBe('devops'); expect(mockEnqueue).not.toHaveBeenCalled();
});
it('scopes logs to the authorized project and disables caching', async () => {
  mockRepo.findOneBy.mockResolvedValue({ logs: '<script>plain text</script>', status: 'building' });
  const result = await request(app).get(`${base}/b/logs`).set('Authorization', 'test');
  expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
  expect(mockRepo.findOneBy).toHaveBeenCalledWith({ id: 'b', projectId: 'p' });
  expect(mockAccess.mock.calls[0][2]).toBe('developer');
});
it('returns 404 for a build outside the project', async () => {
  mockRepo.findOneBy.mockResolvedValue(null);
  expect((await request(app).get(`${base}/b/logs`).set('Authorization', 'test')).status).toBe(404);
});
it('requires installer opt-in for mutations', async () => {
  process.env.BUILDS_ENABLED = 'false';
  expect((await request(app).post(base).set('Authorization', 'test').send({ environmentId: 'e', branch: 'main' })).status).toBe(409);
});
it('requires an explicit environment and validates linked branch settings', async () => {
  expect((await request(app).post(base).set('Authorization', 'test').send({ branch: 'main' })).status).toBe(400);
  expect((await request(app).patch(`${base}/settings`).set('Authorization', 'test').send({ environmentId: 'e', buildOnPush: 'yes', branch: 'main' })).status).toBe(400);
  mockRepo.findOneBy.mockResolvedValueOnce({ id: 'e' }).mockResolvedValueOnce(approvedProject);
  const result = await request(app).patch(`${base}/settings`).set('Authorization', 'test').send({ environmentId: 'e', buildOnPush: true, branch: 'feature/app' });
  expect(result.status).toBe(200);
  expect(mockRepo.save).toHaveBeenCalledWith({ id: 'e', buildOnPush: true, buildBranch: 'feature/app' });
});
it('queues only the branch commit resolved by the server', async () => {
  mockRepo.findOneBy.mockResolvedValueOnce(approvedProject).mockResolvedValueOnce({ id: 'e' });
  const result = await request(app).post(base).set('Authorization', 'test').send({ environmentId: 'e', branch: 'main', commitSha: 'untrusted' });
  expect(result.status).toBe(202);
  expect(mockEnqueue).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'main', 'a'.repeat(40), 'user', { headCheckedAt: expect.any(Date) });
});
it('rate limits manual builds per project with 429 and a clear message', async () => {
  const { BuildLimitError } = jest.requireMock('../../../src/lib/build-op');
  mockRepo.findOneBy.mockResolvedValueOnce(approvedProject).mockResolvedValueOnce({ id: 'e' });
  mockManual.mockRejectedValueOnce(new BuildLimitError('Too many manual builds for this project; try again in a few minutes'));
  const result = await request(app).post(base).set('Authorization', 'test').send({ environmentId: 'e', branch: 'main' });
  expect(result.status).toBe(429); expect(result.body.error).toContain('Too many manual builds');
  expect(mockManual).toHaveBeenCalledWith('p'); expect(mockEnqueue).not.toHaveBeenCalled();
});
it('maps a full project queue to 429', async () => {
  const { BuildLimitError } = jest.requireMock('../../../src/lib/build-op');
  mockRepo.findOneBy.mockResolvedValueOnce(approvedProject).mockResolvedValueOnce({ id: 'e' });
  mockEnqueue.mockRejectedValueOnce(new BuildLimitError('This project already has the maximum number of queued builds'));
  expect((await request(app).post(base).set('Authorization', 'test').send({ environmentId: 'e', branch: 'main' })).status).toBe(429);
});

describe('repository approval', () => {
  it('is required before build-on-push can be enabled; disabling is always allowed', async () => {
    mockRepo.findOneBy.mockResolvedValueOnce({ id: 'e' }).mockResolvedValueOnce({ ...approvedProject, repositoryApprovedAt: null });
    const denied = await request(app).patch(`${base}/settings`).set('Authorization', 'test').send({ environmentId: 'e', buildOnPush: true, branch: 'main' });
    expect(denied.status).toBe(409); expect(denied.body.error).toContain('administrator must approve'); expect(mockRepo.save).not.toHaveBeenCalled();
    mockRepo.findOneBy.mockResolvedValueOnce({ id: 'e' });
    expect((await request(app).patch(`${base}/settings`).set('Authorization', 'test').send({ environmentId: 'e', buildOnPush: false, branch: 'main' })).status).toBe(200);
  });

  it('maps an unapproved repository on Build now to 409', async () => {
    const { RepositoryNotApprovedError } = jest.requireActual('../../../src/lib/repository-binding');
    mockRepo.findOneBy.mockResolvedValueOnce(approvedProject).mockResolvedValueOnce({ id: 'e' });
    mockEnqueue.mockRejectedValueOnce(new RepositoryNotApprovedError());
    expect((await request(app).post(base).set('Authorization', 'test').send({ environmentId: 'e', branch: 'main' })).status).toBe(409);
  });

  it('reports the approval state with the build list', async () => {
    mockRepo.findOneBy.mockResolvedValueOnce(approvedProject);
    const result = await request(app).get(base).set('Authorization', 'test');
    expect(result.body.repository).toMatchObject({ url: approvedProject.repositoryUrl, approved: true, canApprove: false });
  });

  it('can be granted only by a platform administrator signed in as a person', async () => {
    for (const role of ['devops', 'tech_lead']) {
      mockAuthUser.role = role;
      expect((await request(app).post(`${base}/repository-approval`).set('Authorization', 'test').send({})).status).toBe(403);
    }
    mockAuthUser.role = 'admin';
    expect((await request(app).post(`${base}/repository-approval`).set('Authorization', 'test').set('x-agent', '1').send({})).status).toBe(403);
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('records who approved which repository', async () => {
    mockAuthUser.role = 'admin';
    mockRepo.findOneBy.mockResolvedValueOnce({ ...approvedProject, repositoryApprovedAt: null, repositoryApprovedKey: null });
    const result = await request(app).post(`${base}/repository-approval`).set('Authorization', 'test').send({ repositoryUrl: 'https://github.com/acme/app' });
    expect(result.status).toBe(200); expect(result.body.approved).toBe(true);
    expect(mockRepo.update).toHaveBeenCalledWith({ id: 'p', repositoryKey: 'github.com/acme/app' },
      expect.objectContaining({ repositoryApprovedBy: 'user', repositoryApprovedKey: 'github.com/acme/app' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'build.repository_approved', targetId: 'p' }));
  });

  it('refuses an approval for a repository other than the one linked now', async () => {
    mockAuthUser.role = 'admin';
    mockRepo.findOneBy.mockResolvedValueOnce(approvedProject);
    expect((await request(app).post(`${base}/repository-approval`).set('Authorization', 'test').send({ repositoryUrl: 'https://github.com/acme/other' })).status).toBe(409);
    mockRepo.findOneBy.mockResolvedValueOnce({ ...approvedProject, repositoryUrl: 'https://example.com/acme/app.git', repositoryKey: 'example.com/acme/app' });
    expect((await request(app).post(`${base}/repository-approval`).set('Authorization', 'test').send({})).status).toBe(400);
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('can be withdrawn by a platform administrator', async () => {
    mockAuthUser.role = 'admin';
    mockRepo.findOneBy.mockResolvedValueOnce(approvedProject);
    const result = await request(app).delete(`${base}/repository-approval`).set('Authorization', 'test');
    expect(result.status).toBe(200);
    expect(mockRepo.update).toHaveBeenCalledWith({ id: 'p' }, { repositoryApprovedBy: null, repositoryApprovedAt: null, repositoryApprovedKey: null });
  });
});
