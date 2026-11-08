/**
 * Issue #23 acceptance tests (in-process backends: no Redis, memory step log):
 *  - concurrent deploys for the same project/env: one runs, the others get 409 with the holder
 *  - replaying a webhook delivery id does not create a second deployment
 *  - the same Idempotency-Key returns the identical response without re-executing
 *  - GET /operations/:id exposes deploy progress; the lock is released when the deploy ends
 */
process.env.JWT_SECRET = 'coordination-test-secret';
process.env.GITHUB_WEBHOOK_SECRET = 'gh-hook-secret';
process.env.GITLAB_WEBHOOK_SECRET = 'gl-hook-secret';

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class { loadFromCluster() {} loadFromDefault() {} makeApiClient() { return {}; } },
  CoreV1Api: class {},
  CustomObjectsApi: class {},
}));

// Argo sync blocks until the test releases it, so the deploy lock stays held meanwhile.
let releaseArgo: (() => void) | null = null;
const ensureAndSyncArgoApp = jest.fn().mockImplementation(
  () => new Promise((resolve) => { releaseArgo = () => resolve({ ok: false, error: 'stopped by test' }); }),
);
jest.mock('../../src/lib/k8s', () => ({
  argoAppName: (name: string, env: string) => `${name}-${env}`,
  deployK8sPreview: jest.fn().mockResolvedValue(true),
  ensureAndSyncArgoApp: (...a: any[]) => ensureAndSyncArgoApp(...a),
  ensureProjectIngress: jest.fn().mockResolvedValue(undefined),
  operateProjectWorkloads: jest.fn().mockResolvedValue(undefined),
  terminateK8sPreview: jest.fn().mockResolvedValue(true),
  previewResourceName: (id: string, branch: string) => `preview-${id}-${branch}`,
}));
const triggerPipeline = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/lib/gitlab', () => ({ triggerPipeline: (...a: any[]) => triggerPipeline(...a) }));
jest.mock('../../src/lib/clickup', () => ({
  postComment: jest.fn(), formatPreviewComment: jest.fn().mockResolvedValue(''), extractTaskId: () => null,
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENV_ID = '22222222-2222-4222-8222-222222222222';
const REPO = 'https://github.com/acme/demo.git';

const deployments: any[] = [];
const deliveries = new Set<string>();
let seq = 0;

function repoFor(name: string) {
  switch (name) {
    case 'User':
      return { findOne: async ({ where }: any) => ({ id: where.id, role: 'devops', roleId: null, name: 'Ops', email: 'ops@example.test', isActive: true }) };
    case 'Project':
      return { findOne: async () => ({ id: PROJECT_ID, name: 'demo', repositoryUrl: REPO, domain: 'example.test' }) };
    case 'Environment':
      return {
        findOne: async () => ({ id: ENV_ID, name: 'development', namespace: 'demo-dev', domain: 'dev.example.test', projectId: PROJECT_ID }),
        find: async () => [{ id: ENV_ID, namespace: 'demo-dev', projectId: PROJECT_ID }],
      };
    case 'Deployment':
      return {
        create: (d: any) => ({ ...d }),
        save: async (d: any) => {
          if (!d.id) {
            d.id = `dep-${++seq}`;
            d.createdAt = new Date(Date.now() + seq);
            deployments.push(d);
          }
          return d;
        },
        findOne: async ({ where }: any) => deployments.find((d) => d.id === where.id) || null,
        find: async () => deployments,
      };
    case 'WebhookDelivery':
      return {
        insert: async (row: any) => {
          const k = `${row.provider}:${row.deliveryId}`;
          if (deliveries.has(k)) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
          deliveries.add(k);
          return {};
        },
        delete: async (row: any) => { deliveries.delete(`${row.provider}:${row.deliveryId}`); },
      };
    default:
      return { create: (d: any) => d, save: async (d: any) => d, findOne: async () => null, find: async () => [] };
  }
}

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({ getRepository: (e: any) => repoFor(e?.name) })),
}));

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import deploymentRoutes from '../../src/routes/deployments';
import webhookRoutes from '../../src/routes/webhooks';
import operationRoutes from '../../src/routes/operations';
import { setCoordinationRedisForTests } from '../../src/lib/coord-redis';
import { resetMemoryLocksForTests } from '../../src/lib/locks';
import { setOperationStore, waitForActiveRuns } from '../../src/lib/operations';
import { MemoryOperationStore } from '../../src/lib/operation-store';
import { MemoryIdempotencyStore, setIdempotencyStore } from '../../src/middleware/idempotency';
import { resetWebhookDedupeForTests } from '../../src/lib/webhook-dedupe';

const token = jwt.sign({ id: 'u-ops', role: 'devops' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${token}` };

function buildApp() {
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api', deploymentRoutes, webhookRoutes, operationRoutes);
  return app;
}

async function finishRunningDeploy() {
  // let the background run reach Argo, then make Argo return
  for (let i = 0; i < 50 && !releaseArgo; i++) await new Promise((r) => setTimeout(r, 10));
  releaseArgo?.();
  releaseArgo = null;
  await waitForActiveRuns();
}

let app: express.Express;
beforeEach(() => {
  deployments.length = 0;
  deliveries.clear();
  releaseArgo = null;
  ensureAndSyncArgoApp.mockClear();
  triggerPipeline.mockClear();
  setCoordinationRedisForTests(null);
  resetMemoryLocksForTests();
  setOperationStore(new MemoryOperationStore());
  setIdempotencyStore(new MemoryIdempotencyStore());
  resetWebhookDedupeForTests();
  app = buildApp();
});

afterEach(async () => {
  await finishRunningDeploy();
});

const deployBody = { projectId: PROJECT_ID, environmentId: ENV_ID, version: '1.2.3', branch: 'main' };

describe('per-project deploy lock', () => {
  it('two concurrent deploys for the same project/env: one runs, the other gets 409', async () => {
    const [a, b] = await Promise.all([
      request(app).post('/api/deploy').set(auth).send(deployBody),
      request(app).post('/api/deploy').set(auth).send(deployBody),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const ok = a.status === 201 ? a : b;
    const busy = a.status === 409 ? a : b;
    expect(ok.body.operationId).toBeTruthy();
    expect(busy.body).toMatchObject({ code: 'OPERATION_IN_PROGRESS', operationId: ok.body.operationId });
    expect(deployments).toHaveLength(1);
  });

  it('five parallel deploys create exactly one deployment', async () => {
    const res = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/deploy').set(auth).send(deployBody)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(4);
    expect(deployments).toHaveLength(1);
  });

  it('rollback/restart/terminate of the same environment are refused while a deploy runs', async () => {
    const first = await request(app).post('/api/deploy').set(auth).send(deployBody).expect(201);
    const restart = await request(app).post(`/api/deployments/${first.body.id}/restart`).set(auth).send({});
    expect(restart.status).toBe(409);
    const terminate = await request(app).post(`/api/deployments/${first.body.id}/terminate`).set(auth).send({});
    expect(terminate.status).toBe(409);
    const rollback = await request(app).post('/api/rollback').set(auth).send({ deploymentId: first.body.id });
    expect(rollback.status).toBe(409);
  });

  it('releases the lock when the deploy ends and records the step log', async () => {
    const first = await request(app).post('/api/deploy').set(auth).send(deployBody).expect(201);
    await finishRunningDeploy();
    const op = await request(app).get(`/api/operations/${first.body.operationId}`).set(auth).expect(200);
    expect(op.body.type).toBe('deployment.deploy');
    expect(op.body.status).toBe('failed');
    expect(op.body.steps.map((s: any) => s.name)).toEqual(['apply', 'wait-healthy', 'finalize']);
    expect(op.body.steps[0]).toMatchObject({ status: 'failed', error: 'stopped by test' });
    expect(deployments[0].status).toBe('failed');
    // next deploy is accepted
    await request(app).post('/api/deploy').set(auth).send(deployBody).expect(201);
  });
});

describe('Idempotency-Key on POST /deploy', () => {
  it('same key returns the identical response without re-executing', async () => {
    const first = await request(app).post('/api/deploy').set(auth).set('Idempotency-Key', 'deploy-abc').send(deployBody);
    expect(first.status).toBe(201);
    await finishRunningDeploy();
    const replay = await request(app).post('/api/deploy').set(auth).set('Idempotency-Key', 'deploy-abc').send(deployBody);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(deployments).toHaveLength(1);
    expect(ensureAndSyncArgoApp).toHaveBeenCalledTimes(1);
  });

  it('same key with a different body → 422', async () => {
    await request(app).post('/api/deploy').set(auth).set('Idempotency-Key', 'deploy-xyz').send(deployBody).expect(201);
    const r = await request(app).post('/api/deploy').set(auth).set('Idempotency-Key', 'deploy-xyz').send({ ...deployBody, version: '9.9.9' });
    expect(r.status).toBe(422);
    expect(deployments).toHaveLength(1);
  });
});

describe('webhook delivery dedupe', () => {
  function githubPush(deliveryId: string) {
    const payload = JSON.stringify({ ref: 'refs/heads/main', after: 'abc123', repository: { clone_url: REPO } });
    const sig = 'sha256=' + crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(payload).digest('hex');
    return request(app).post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'push')
      .set('x-github-delivery', deliveryId)
      .set('x-hub-signature-256', sig)
      .send(payload);
  }

  it('replaying the same GitHub delivery id does not create a second deployment', async () => {
    const first = await githubPush('delivery-1');
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();
    const replays = await Promise.all([githubPush('delivery-1'), githubPush('delivery-1'), githubPush('delivery-1')]);
    for (const r of replays) {
      expect(r.status).toBe(200);
      expect(r.body.duplicate).toBe(true);
    }
    expect(deployments).toHaveLength(1);
    expect(triggerPipeline).toHaveBeenCalledTimes(1);
    // a new delivery is processed
    await githubPush('delivery-2').expect(200);
    expect(deployments).toHaveLength(2);
  });

  it('dedupes GitLab deliveries by Idempotency-Key / X-Gitlab-Event-UUID', async () => {
    const send = (uuid: string) => request(app).post('/api/webhooks/gitlab')
      .set('x-gitlab-token', process.env.GITLAB_WEBHOOK_SECRET!)
      .set('x-gitlab-event', 'Push Hook')
      .set('x-gitlab-event-uuid', uuid)
      .send({ ref: 'refs/heads/main', after: 'def456', project: { http_url: REPO } });
    await send('evt-1').expect(200);
    const dup = await send('evt-1');
    expect(dup.body.duplicate).toBe(true);
    expect(deployments).toHaveLength(1);
  });

  it('a delivery whose processing failed is processed again on retry', async () => {
    triggerPipeline.mockRejectedValueOnce(new Error('gitlab down'));
    const failed = await githubPush('delivery-retry');
    expect(failed.status).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    const retried = await githubPush('delivery-retry');
    expect(retried.status).toBe(200);
    expect(retried.body.duplicate).toBeUndefined();
  });
});

describe('GET /operations', () => {
  it('404 for unknown or malformed ids', async () => {
    await request(app).get('/api/operations/not-a-uuid').set(auth).expect(404);
    await request(app).get('/api/operations/33333333-3333-4333-8333-333333333333').set(auth).expect(404);
  });

  it('lists a project\'s operations', async () => {
    const first = await request(app).post('/api/deploy').set(auth).send(deployBody).expect(201);
    const list = await request(app).get(`/api/operations?projectId=${PROJECT_ID}`).set(auth).expect(200);
    expect(list.body.map((o: any) => o.id)).toContain(first.body.operationId);
  });
});
