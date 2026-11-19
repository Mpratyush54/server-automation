/**
 * Real project deletion (DELETE /api/projects/:id): confirmation and step-up, backups before
 * anything is removed, deleteDatabases true/false, an idempotent retry after a mid-way failure,
 * and name reuse with distinct id-scoped resources for the new project.
 *
 * Cluster, database and storage side effects are replaced through setProjectDeleteDepsForTests;
 * the platform database is an in-memory repository set.
 */
jest.mock('@kubernetes/client-node', () => {
  class Api {}
  return {
    KubeConfig: class { loadFromCluster() {} loadFromDefault() {} makeApiClient() { return {}; } },
    CoreV1Api: Api, AppsV1Api: Api, NetworkingV1Api: Api, CustomObjectsApi: Api, RbacAuthorizationV1Api: Api, BatchV1Api: Api,
  };
});
jest.mock('../../src/lib/telemetry-origins', () => ({ requestTelemetryOriginsSync: jest.fn() }));

import { MemoryRepo } from '../helpers/memory-repo';

const repos = new Map<string, MemoryRepo<any>>();
// Column defaults the database would apply.
const DEFAULTS: Record<string, () => Record<string, unknown>> = {
  Project: () => ({ isActive: true, deletedAt: null, databaseResources: null }),
  Environment: () => ({ isActive: true, buildOnPush: false }),
};
const repo = (name: string) => {
  if (!repos.has(name)) repos.set(name, new MemoryRepo<any>(DEFAULTS[name] || (() => ({}))));
  return repos.get(name)!;
};
jest.mock('../../src/config/database', () => ({
  getDb: jest.fn(async () => ({
    getRepository: (e: any) => repo(typeof e === 'string' ? e : e.name),
    query: jest.fn(async () => []),
  })),
}));

import express from 'express';
import request from 'supertest';
import projectsRouter from '../../src/routes/projects';
import { signSessionToken } from '../../src/lib/session-token';
import { getOperation, setOperationStore } from '../../src/lib/operations';
import { MemoryOperationStore } from '../../src/lib/operation-store';
import { resetMemoryLocksForTests } from '../../src/lib/locks';
import { setCoordinationRedisForTests } from '../../src/lib/coord-redis';
import { setProjectDeleteDepsForTests, ProjectDeleteDeps } from '../../src/lib/project-delete';
import type { ProjectDatabase } from '../../src/lib/project-delete-resources';
import { assignedNamespace } from '../../src/lib/project-namespace';
import { argoAppName } from '../../src/lib/k8s';
import { projectDbIdentity } from '../../src/lib/project-db-identity';

const JWT_SECRET = 'project-delete-test-secret';
const DEVOPS = { id: 'u-devops', email: 'ops@example.test', name: 'Ops', role: 'devops' };
const LEAD = { id: 'u-lead', email: 'lead@example.test', name: 'Lead', role: 'tech_lead' };
const now = () => Math.floor(Date.now() / 1000);
let mfaToken = '';
let plainToken = '';
let leadToken = '';

const DBS: ProjectDatabase[] = [
  { kind: 'postgres', environment: 'production', name: 'plat_aaa_bbb', user: 'plat_aaa_bbb_user' },
  { kind: 'mongo', environment: 'production', name: 'plat_aaa_bbb', user: 'plat_aaa_bbb_user' },
  { kind: 'redis', environment: 'production', name: 'plat_aaa_bbb', user: 'plat_aaa_bbb', keyPrefix: 'plat:aaa:bbb:' },
];

let calls: string[] = [];
let deps: { [K in keyof ProjectDeleteDeps]: jest.Mock };

function makeDeps() {
  const rec = (name: string, value: any) => jest.fn(async (...args: any[]) => { calls.push(`${name}:${args.length && typeof args[0] === 'object' && args[0]?.kind ? `${args[0].kind}` : ''}`); return typeof value === 'function' ? value(...args) : value; });
  deps = {
    listProjectDatabases: rec('list', DBS),
    projectNamespacesFor: jest.fn(async (id: string) => (await repo('Environment').find({ where: { projectId: id } })).map((e: any) => e.namespace)),
    lockDatabase: rec('lock', true),
    unlockDatabase: rec('unlock', undefined),
    backupDatabase: rec('backup', (_p: string, db: ProjectDatabase) => ({ key: `${db.kind}:${db.environment}:${db.name}`, kind: db.kind, environment: db.environment, name: db.name, backupId: `b-${db.kind}`, status: 'completed', fileId: `backups/${db.kind}`, providerType: 'minio', sizeBytes: 10 })),
    dropDatabase: rec('drop', undefined),
    removeArgoApplications: rec('argo', {}),
    removeNamespaces: rec('namespaces', {}),
    removeLegacyPreviews: rec('previews', 0),
    removeRegistryImages: rec('images', 0),
    removeUploadedFiles: rec('files', 0),
    removeReplayObjects: rec('replays', 0),
    removeProjectData: rec('data', {}),
    removeMonitoring: rec('monitoring', {}),
    activeProjectOperations: jest.fn(async () => []),
  } as any;
  setProjectDeleteDepsForTests(deps as any);
}

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  mfaToken = signSessionToken(DEVOPS, { amr: ['pwd', 'otp', 'mfa'], authTime: now() });
  plainToken = signSessionToken(DEVOPS, { amr: ['pwd'], authTime: now() });
  leadToken = signSessionToken(LEAD, { amr: ['pwd', 'otp', 'mfa'], authTime: now() });
  app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
});
beforeEach(() => {
  repos.clear();
  for (const u of [DEVOPS, LEAD]) repo('User').rows.push({ ...u, isActive: true, roleId: null });
  calls = [];
  setOperationStore(new MemoryOperationStore());
  setCoordinationRedisForTests(null);
  resetMemoryLocksForTests();
  makeDeps();
});
afterAll(() => setProjectDeleteDepsForTests(null));

const auth = (t = mfaToken) => ({ Authorization: `Bearer ${t}` });

async function createProject(name = 'shop') {
  const res = await request(app).post('/api/projects').set(auth()).send({ name, stack: 'nodejs' });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  repo('SdkCredential').rows.push({ id: 'tok-1', projectId: id, name: 't', token: 'sdk_live_x', status: 'active', kind: 'server' });
  repo('Secret').rows.push({ id: 'sec-1', projectId: id, environmentId: 'production', key: 'API_KEY', encryptedValue: 'x', isActive: true });
  repo('SecretVersion').rows.push({ id: 'sv-1', secretId: 'sec-1' });
  return id;
}

async function waitDone(operationId: string) {
  for (let i = 0; i < 200; i++) {
    const op = await getOperation(operationId);
    if (op && ['succeeded', 'failed', 'compensated'].includes(op.status)) return op;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('operation did not finish');
}

const del = (id: string, body: any, token = mfaToken) => request(app).delete(`/api/projects/${id}`).set(auth(token)).send(body);
const audits = () => repo('AuditLog').rows.map((r: any) => r.action);

describe('refusals', () => {
  it('needs a recent MFA step-up', async () => {
    const id = await createProject();
    const res = await del(id, { confirmName: 'shop' }, plainToken);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('step_up_required');
    expect(deps.lockDatabase).not.toHaveBeenCalled();
  });

  it('needs the exact project name', async () => {
    const id = await createProject();
    for (const body of [{}, { confirmName: 'Shop' }, { confirmName: 'shop ' }]) {
      const res = await del(id, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('confirm_name_mismatch');
    }
    expect((await repo('Project').findOne({ where: { id } }))!.isActive).toBe(true);
  });

  it('needs the devops role', async () => {
    const id = await createProject();
    expect((await del(id, { confirmName: 'shop' }, leadToken)).status).toBe(403);
  });

  it('rejects a non-boolean deleteDatabases', async () => {
    const id = await createProject();
    expect((await del(id, { confirmName: 'shop', deleteDatabases: 'yes' })).status).toBe(400);
  });
});

describe('delete', () => {
  it('backs up, keeps the databases detached, removes everything else and frees the name', async () => {
    const id = await createProject();
    const oldNamespaces = repo('Environment').rows.map((e: any) => e.namespace);
    const res = await del(id, { confirmName: 'shop' });
    expect(res.status).toBe(202);
    const op = await waitDone(res.body.operationId);
    expect(op.status).toBe('succeeded');
    expect(op.steps.every((s) => s.status === 'succeeded')).toBe(true);

    expect(deps.backupDatabase).toHaveBeenCalledTimes(3);
    expect(deps.dropDatabase).not.toHaveBeenCalled();
    // Backups strictly before anything is removed.
    expect(calls.findIndex((c) => c.startsWith('argo'))).toBeGreaterThan(calls.lastIndexOf('backup:redis'));
    expect(deps.removeNamespaces).toHaveBeenCalledWith(id, expect.arrayContaining(oldNamespaces));

    const project = (await repo('Project').findOne({ where: { id } }))!;
    expect(project.isActive).toBe(false);
    expect(project.deletedAt).toBeInstanceOf(Date);
    expect(repo('SdkCredential').rows.every((t: any) => t.status === 'revoked')).toBe(true);
    expect(repo('Secret').rows).toHaveLength(0);
    expect(repo('SecretVersion').rows).toHaveLength(0);
    expect(repo('ProjectMember').rows.filter((m: any) => m.projectId === id)).toHaveLength(0);
    expect(repo('Environment').rows.every((e: any) => e.isActive === false)).toBe(true);

    expect(audits()).toEqual(expect.arrayContaining([
      'project.delete.started', 'project.delete.backed_up', 'project.delete.removal_started', 'project.delete.apps_removed',
      'project.delete.namespaces_removed', 'project.delete.monitoring_removed', 'project.delete.access_revoked',
      'project.delete.databases_detached', 'project.delete.data_removed', 'project.deleted',
    ]));
    const detached = repo('AuditLog').rows.find((r: any) => r.action === 'project.delete.databases_detached');
    expect(detached.metadata.databases).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'postgres', database: 'plat_aaa_bbb', user: 'plat_aaa_bbb_user', backupId: 'b-postgres' }),
      expect.objectContaining({ kind: 'redis', keyPrefix: 'plat:aaa:bbb:' }),
    ]));

    const status = await request(app).get(`/api/projects/${id}/deletion`).set(auth());
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('deleted');
    expect(status.body.operation.steps.map((s: any) => s.name)).toEqual([
      'prepare', 'lock-databases', 'back-up-databases', 'stop-apps', 'remove-namespaces', 'remove-monitoring',
      'revoke-access', 'remove-databases', 'remove-data', 'finish',
    ]);

    // The name is free again, and the new project's resources never collide with the old ones.
    const again = await request(app).post('/api/projects').set(auth()).send({ name: 'shop', stack: 'nodejs' });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(id);
    const newNamespaces = repo('Environment').rows.filter((e: any) => e.projectId === again.body.id).map((e: any) => e.namespace);
    expect(newNamespaces).toHaveLength(3);
    for (const ns of newNamespaces) expect(oldNamespaces).not.toContain(ns);
    for (const env of ['development', 'staging', 'production']) {
      expect(argoAppName('shop', env, again.body.id)).not.toBe(argoAppName('shop', env, id));
      expect(assignedNamespace('shop', env, again.body.id)).not.toBe(assignedNamespace('shop', env, id));
      expect(projectDbIdentity(again.body.id, env).id).not.toBe(projectDbIdentity(id, env).id);
    }
    // A deleted project is no longer listed.
    expect((await request(app).get('/api/projects').set(auth())).body.map((p: any) => p.id)).not.toContain(id);
    // Deleting again is refused: it is already gone.
    expect((await del(id, { confirmName: 'shop' })).body.code).toBe('project_already_deleted');
  });

  it('drops the databases only after every backup completed', async () => {
    const id = await createProject();
    const res = await del(id, { confirmName: 'shop', deleteDatabases: true });
    const op = await waitDone(res.body.operationId);
    expect(op.status).toBe('succeeded');
    expect(deps.dropDatabase).toHaveBeenCalledTimes(3);
    const lastBackup = calls.lastIndexOf('backup:redis');
    for (const kind of ['postgres', 'mongo', 'redis']) expect(calls.indexOf(`drop:${kind}`)).toBeGreaterThan(lastBackup);
    expect(audits()).toContain('project.delete.databases_dropped');
    expect(audits()).not.toContain('project.delete.databases_detached');
  });

  it('aborts with nothing deleted when a backup fails, and restores the project', async () => {
    const id = await createProject();
    deps.backupDatabase.mockImplementation(async (_p: string, db: ProjectDatabase) => {
      if (db.kind === 'mongo') throw new Error('backup target unreachable');
      return { key: `${db.kind}:${db.environment}:${db.name}`, kind: db.kind, environment: db.environment, name: db.name, backupId: 'b', status: 'completed', fileId: 'f', providerType: 'minio', sizeBytes: 1 };
    });
    const res = await del(id, { confirmName: 'shop', deleteDatabases: true });
    const op = await waitDone(res.body.operationId);
    expect(op.status).toBe('failed');
    expect(op.error).toContain('Backup failed, nothing was deleted');
    expect(op.error).toContain('mongo plat_aaa_bbb (production): backup target unreachable');
    for (const fn of ['removeArgoApplications', 'removeNamespaces', 'dropDatabase', 'removeMonitoring', 'removeProjectData', 'removeRegistryImages'] as const) {
      expect(deps[fn]).not.toHaveBeenCalled();
    }
    expect(deps.unlockDatabase).toHaveBeenCalledTimes(3);
    const project = (await repo('Project').findOne({ where: { id } }))!;
    expect(project.isActive).toBe(true);
    expect(project.deletedAt).toBeNull();
    expect(repo('SdkCredential').rows[0].status).toBe('active');
    expect(repo('Secret').rows).toHaveLength(1);
    expect(audits()).toContain('project.delete.aborted');
    const status = await request(app).get(`/api/projects/${id}/deletion`).set(auth());
    expect(status.body.status).toBe('aborted');
    // The name stays taken by the restored project.
    expect((await request(app).post('/api/projects').set(auth()).send({ name: 'shop', stack: 'nodejs' })).status).toBe(409);
  });

  it('retries a delete that failed mid-way without repeating backups or restoring anything', async () => {
    const id = await createProject();
    deps.removeNamespaces.mockRejectedValueOnce(new Error('cluster API timed out'));
    const first = await del(id, { confirmName: 'shop' });
    const failed = await waitDone(first.body.operationId);
    expect(failed.status).toBe('failed');
    expect(failed.steps.find((s) => s.name === 'remove-namespaces')!.status).toBe('failed');
    expect(audits()).toContain('project.delete.failed');

    // Half-deleted: hidden, still holding its name, not restored.
    const half = (await repo('Project').findOne({ where: { id } }))!;
    expect(half.isActive).toBe(false);
    expect(half.deletedAt).toBeNull();
    expect(deps.unlockDatabase).not.toHaveBeenCalled();
    const blocked = await request(app).post('/api/projects').set(auth()).send({ name: 'shop', stack: 'nodejs' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('project_name_deleting');
    expect((await request(app).get(`/api/projects/${id}/deletion`).set(auth())).body.status).toBe('failed');
    // Still listed (flagged) so the failed delete can be found and retried.
    const listed = await request(app).get('/api/projects').set(auth());
    expect(listed.body.find((p: any) => p.id === id)).toMatchObject({ deleting: true });

    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt for the retry
    const retry = await del(id, { confirmName: 'shop' });
    expect(retry.status).toBe(202);
    expect(retry.body.resumed).toBe(true);
    const done = await waitDone(retry.body.operationId);
    expect(done.status).toBe('succeeded');
    expect(deps.backupDatabase).toHaveBeenCalledTimes(3); // only the first attempt
    expect(deps.removeArgoApplications).toHaveBeenCalledTimes(2); // idempotent steps re-run
    expect(deps.removeNamespaces).toHaveBeenCalledTimes(2);
    expect(audits()).toContain('project.delete.retried');
    expect((await repo('Project').findOne({ where: { id } }))!.deletedAt).toBeInstanceOf(Date);
  });

  it('waits for running deploys before removing anything', async () => {
    const id = await createProject();
    deps.activeProjectOperations.mockResolvedValueOnce(['deploy-1']);
    const res = await del(id, { confirmName: 'shop' });
    for (let i = 0; i < 100; i++) {
      const op = await getOperation(res.body.operationId);
      if (op?.status === 'pending' && op.steps[3].output?.waitingUntil) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const op = (await getOperation(res.body.operationId))!;
    expect(op.status).toBe('pending');
    expect(op.steps[3].output?.waitingReason).toContain('running deploy');
    expect(deps.removeArgoApplications).not.toHaveBeenCalled();
    // Calling delete again while it waits returns the same operation.
    const again = await del(id, { confirmName: 'shop' });
    expect(again.body).toMatchObject({ operationId: res.body.operationId, alreadyRunning: true });
  });
});
