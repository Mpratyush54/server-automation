import express from 'express';
import request from 'supertest';
const mockPush = jest.fn(async (..._args: any[]): Promise<string> => 'queued');
const mockClaim = jest.fn(async () => true);
const mockVerify = jest.fn(async () => true);
jest.mock('../../../src/lib/build-op', () => ({ queuePushBuilds: (...args: any[]) => mockPush(...args) }));
jest.mock('../../../src/config/database', () => ({ getDb: async () => ({ getRepository: () => ({ findOne: async () => ({ id: 'p' }) }) }) }));
jest.mock('../../../src/lib/webhook-dedupe', () => ({
  webhookDeliveryId: () => 'delivery', claimWebhookDelivery: () => mockClaim(), releaseWebhookDelivery: jest.fn(),
}));
jest.mock('../../../src/lib/github-app', () => ({ githubWebhookSecrets: async () => [], verifyHubSignature: () => mockVerify(), handleInstallationWebhook: jest.fn() }));
jest.mock('../../../src/lib/gitlab-app', () => ({ gitlabWebhookSecrets: async () => [], verifyGitlabTokenAgainst: () => mockVerify() }));
jest.mock('../../../src/lib/k8s', () => ({ deployK8sPreview: jest.fn() }));
jest.mock('../../../src/lib/gitlab', () => ({ triggerPipeline: jest.fn() }));
jest.mock('../../../src/lib/clickup', () => ({}));
import router from '../../../src/routes/webhooks';
const app = express(); app.use(express.json(), router);
beforeEach(() => { jest.clearAllMocks(); mockClaim.mockResolvedValue(true); mockVerify.mockResolvedValue(true); mockPush.mockResolvedValue('queued'); });

it.each(['github', 'gitlab'])('routes authenticated %s pushes to source builds before the legacy deploy flow', async provider => {
  const event = provider === 'github' ? 'push' : 'Push Hook';
  const result = await request(app).post(`/webhooks/${provider}`).set(provider === 'github' ? 'x-github-event' : 'x-gitlab-event', event)
    .send({ ref: 'refs/heads/release/app', after: 'a'.repeat(40), repository: { clone_url: 'https://github.com/acme/app.git' }, project: { http_url: 'https://gitlab.com/acme/app.git' } });
  expect(result.status).toBe(200); expect(result.body.message).toBe('Source build queued');
  expect(mockPush).toHaveBeenCalledWith({ id: 'p' }, 'release/app', 'a'.repeat(40));
});
it('does not queue unauthenticated or duplicate deliveries', async () => {
  mockVerify.mockResolvedValueOnce(false);
  expect((await request(app).post('/webhooks/github').set('x-github-event', 'push').send({})).status).toBe(401);
  expect(mockClaim).not.toHaveBeenCalled();
  mockClaim.mockResolvedValueOnce(false);
  const result = await request(app).post('/webhooks/github').set('x-github-event', 'push').send({});
  expect(result.body.duplicate).toBe(true); expect(mockPush).not.toHaveBeenCalled();
});
it.each([
  ['github', 'push', { ref: 'refs/heads/main', deleted: true }],
  ['github', 'push', { ref: 'refs/tags/v1', after: 'a'.repeat(40) }],
  ['gitlab', 'Push Hook', { ref: 'refs/heads/main', after: '0'.repeat(40) }],
])('ignores deleted branches and non-branch refs (%s)', async (provider, event, payload) => {
  const result = await request(app).post(`/webhooks/${provider}`).set(provider === 'github' ? 'x-github-event' : 'x-gitlab-event', event as string).send(payload);
  expect(result.status).toBe(200); expect(result.body.message).toBe('Ref ignored'); expect(mockPush).not.toHaveBeenCalled();
});

it.each(['github', 'gitlab'])('rejects a %s push whose SHA is not on the linked branch without running the legacy flow', async provider => {
  mockPush.mockResolvedValueOnce('rejected');
  const { triggerPipeline } = jest.requireMock('../../../src/lib/gitlab');
  const event = provider === 'github' ? 'push' : 'Push Hook';
  const result = await request(app).post(`/webhooks/${provider}`).set(provider === 'github' ? 'x-github-event' : 'x-gitlab-event', event)
    .send({ ref: 'refs/heads/main', after: 'f'.repeat(40), repository: { clone_url: 'https://github.com/acme/app.git' }, project: { http_url: 'https://gitlab.com/acme/app.git' } });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ success: false, message: 'Source build rejected: commit is not on the linked branch' });
  expect(triggerPipeline).not.toHaveBeenCalled();
});

it('reports a full project build queue', async () => {
  mockPush.mockResolvedValueOnce('limited');
  const result = await request(app).post('/webhooks/github').set('x-github-event', 'push')
    .send({ ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { clone_url: 'https://github.com/acme/app.git' } });
  expect(result.body.success).toBe(false); expect(result.body.message).toContain('queue is full');
});
