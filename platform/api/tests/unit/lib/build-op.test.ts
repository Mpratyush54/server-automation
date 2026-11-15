import { MemoryRepo } from '../../helpers/memory-repo';
const mockRepos: Record<string, any> = {};
jest.mock('../../../src/config/database', () => ({ getDb: async () => ({ getRepository: (e: any) => mockRepos[e.name] }) }));
jest.mock('../../../src/lib/build-runtime', () => {
  class BuildStopped extends Error {}
  class RegistryNotFoundError extends Error {}
  return { BuildStopped, RegistryNotFoundError, cancelBuildJob: jest.fn(), runBuildJob: jest.fn(), cleanupBuildSecret: jest.fn(), registryManifest: jest.fn(async () => `sha256:${'a'.repeat(64)}`), signBuiltImage: jest.fn() };
});
const mockVerify = jest.fn(async (..._a: any[]): Promise<string> => 'head');
jest.mock('../../../src/lib/build-source', () => ({ BuildSourceError: class extends Error {}, checkBranchHead: (...a: any[]) => mockVerify(...a) }));
const mockDeploy = jest.fn();
jest.mock('../../../src/lib/deploy-op', () => ({ deployOperation: { steps: [{ name: 'apply', run: (...args: any[]) => mockDeploy(...args) }], onFailed: jest.fn() } }));
import { BuildLimitError, BuildProviderUnavailableError, BuildSupersededError, assertManualBuildAllowed, buildOperation, enqueueBuild, pruneBuildImages, queuePushBuilds, recoverBuildQueue } from '../../../src/lib/build-op';
import { BuildStopped, RegistryNotFoundError, runBuildJob, cleanupBuildSecret, registryManifest } from '../../../src/lib/build-runtime';
import { MemoryOperationStore } from '../../../src/lib/operation-store';
import { runOperation, setOperationStore } from '../../../src/lib/operations';
import { resetMemoryLocksForTests } from '../../../src/lib/locks';

const digest = `sha256:${'d'.repeat(64)}`;
const project: any = { id: 'p', isActive: true, repositoryUrl: 'https://github.com/acme/app.git', repositoryApprovedAt: new Date(), repositoryApprovedKey: 'github.com/acme/app' };
const env: any = { id: 'e', projectId: 'p', isActive: true, buildOnPush: true, buildBranch: 'main' };
let store: MemoryOperationStore;
beforeEach(async () => {
  process.env.PLATFORM_STATE_STORE = 'memory'; process.env.BUILDS_ENABLED = 'true'; process.env.BUILDS_REGISTRY = 'registry.example';
  delete process.env.BUILDS_MAX_QUEUED_PER_PROJECT; delete process.env.BUILDS_MANUAL_PER_10_MINUTES;
  store = new MemoryOperationStore(); setOperationStore(store); resetMemoryLocksForTests(); jest.clearAllMocks();
  for (const name of ['Build', 'Project', 'Environment', 'Deployment', 'AuditLog']) {
    const repo: any = new MemoryRepo<any>(() => ({ createdAt: new Date(), logs: '' }));
    repo.findOneBy = (where: any) => repo.findOne({ where });
    repo.findOneByOrFail = async (where: any) => { const row = await repo.findOneBy(where); if (!row) throw new Error('missing'); return row; };
    const update = repo.update.bind(repo); repo.update = (where: any, patch: any) => update(typeof where === 'string' ? { id: where } : where, patch);
    mockRepos[name] = repo;
  }
  await mockRepos.Project.save(project); await mockRepos.Environment.save(env);
  jest.spyOn(global, 'setImmediate').mockImplementation((() => 0) as any);
  (runBuildJob as jest.Mock).mockImplementation(async (_b: any, _url: string, hooks: any) => { await hooks.markSubmitted(); return digest; });
  mockVerify.mockResolvedValue('head');
});
afterEach(() => { jest.restoreAllMocks(); setOperationStore(null); });

it('deduplicates push commits but permits a manual rebuild', async () => {
  const first = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push');
  const duplicate = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push');
  const manual = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'user');
  expect(duplicate.id).toBe(first.id); expect(manual.id).not.toBe(first.id);
  expect(mockRepos.Build.rows).toHaveLength(2);
});

describe('push builds', () => {
  it('match only opted-in linked branches', async () => {
    expect(await queuePushBuilds(project, 'other', 'a'.repeat(40))).toBe('none');
    expect(await queuePushBuilds(project, 'main', 'a'.repeat(40))).toBe('queued');
    process.env.BUILDS_ENABLED = 'false';
    expect(await queuePushBuilds(project, 'main', 'b'.repeat(40))).toBe('none');
  });

  it('verify the pushed SHA against the linked repository and branch before queuing', async () => {
    await queuePushBuilds(project, 'main', 'a'.repeat(40));
    expect(mockVerify).toHaveBeenCalledWith('https://github.com/acme/app.git', 'main', 'a'.repeat(40));
  });

  it('reject and audit a SHA that is not on the linked branch', async () => {
    mockVerify.mockResolvedValueOnce('not-on-branch');
    expect(await queuePushBuilds(project, 'main', 'f'.repeat(40))).toBe('rejected');
    expect(mockRepos.Build.rows).toHaveLength(0);
    expect(mockRepos.AuditLog.rows[0]).toMatchObject({ action: 'build.push_rejected', targetId: 'p', metadata: { branch: 'main', commit: 'f'.repeat(40) } });
  });

  it('reject a malformed SHA without asking the provider', async () => {
    expect(await queuePushBuilds(project, 'main', 'unknown')).toBe('rejected');
    expect(mockVerify).not.toHaveBeenCalled(); expect(mockRepos.Build.rows).toHaveLength(0);
  });

  it('raise a retryable error, without auditing a rejection, when the provider cannot answer', async () => {
    mockVerify.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(queuePushBuilds(project, 'main', 'a'.repeat(40))).rejects.toBeInstanceOf(BuildProviderUnavailableError);
    expect(mockRepos.Build.rows).toHaveLength(0); expect(mockRepos.AuditLog.rows).toHaveLength(0);
  });

  it('skip a commit that is no longer the branch head', async () => {
    mockVerify.mockResolvedValueOnce('superseded');
    expect(await queuePushBuilds(project, 'main', 'a'.repeat(40))).toBe('superseded');
    expect(mockRepos.Build.rows).toHaveLength(0); expect(mockRepos.AuditLog.rows).toHaveLength(0);
  });

  it('never let a commit observed earlier cancel or replace one observed later', async () => {
    const newer = await enqueueBuild(project, env, 'main', 'b'.repeat(40), 'push', { headCheckedAt: new Date(2000) });
    await expect(enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push', { headCheckedAt: new Date(1000) })).rejects.toBeInstanceOf(BuildSupersededError);
    expect(mockRepos.Build.rows).toHaveLength(1);
    expect(mockRepos.Build.rows.find((b: any) => b.id === newer.id).status).toBe('queued');
    // The same holds once the newer build has finished.
    await mockRepos.Build.update(newer.id, { status: 'succeeded', imageDigest: 'sha256:new' });
    await expect(enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push', { headCheckedAt: new Date(1500) })).rejects.toBeInstanceOf(BuildSupersededError);
  });

  it('report an older push as superseded when every environment has a newer build', async () => {
    await enqueueBuild(project, env, 'main', 'b'.repeat(40), 'push', { headCheckedAt: new Date(Date.now() + 60_000) });
    expect(await queuePushBuilds(project, 'main', 'a'.repeat(40))).toBe('superseded');
  });

  it('deploy the existing image again when a built commit is pushed again', async () => {
    const first = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push', { headCheckedAt: new Date(1000) });
    await mockRepos.Build.update(first.id, { status: 'succeeded', imageDigest: digest });
    await enqueueBuild(project, env, 'main', 'b'.repeat(40), 'push', { headCheckedAt: new Date(2000) });
    await mockRepos.Build.update({ commitSha: 'b'.repeat(40) }, { status: 'succeeded', imageDigest: `sha256:${'e'.repeat(64)}` });
    const again = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push', { headCheckedAt: new Date(3000) });
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ status: 'succeeded', imageDigest: digest, imageTag: first.imageTag });
    await runOperation(again.id);
    expect(runBuildJob).not.toHaveBeenCalled();
    expect(mockDeploy).toHaveBeenCalledTimes(1);
    expect(mockRepos.Environment.rows[0].sourceImage).toBe(`registry.example/p-p/e-e@${digest}`);
  });

  it('build again a pushed commit whose earlier build failed or whose image was pruned', async () => {
    const failed = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push', { headCheckedAt: new Date(1000) });
    await mockRepos.Build.update(failed.id, { status: 'failed' });
    const retry = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push', { headCheckedAt: new Date(2000) });
    expect(retry.id).not.toBe(failed.id); expect(retry.status).toBe('queued');
    await mockRepos.Build.update(retry.id, { status: 'succeeded', imageDigest: digest, prunedAt: new Date() });
    expect((await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push', { headCheckedAt: new Date(3000) })).status).toBe('queued');
  });

  it('supersede older queued builds of the same environment, but not admitted ones', async () => {
    const older = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push');
    const admitted = await enqueueBuild(project, env, 'main', 'b'.repeat(40), 'user');
    await mockRepos.Build.update(admitted.id, { jobSubmittedAt: new Date() });
    await enqueueBuild(project, env, 'main', 'c'.repeat(40), 'push', { headCheckedAt: new Date(Date.now() + 1000) });
    const rows = Object.fromEntries(mockRepos.Build.rows.map((b: any) => [b.id, b]));
    expect(rows[older.id].status).toBe('cancelled');
    expect(rows[older.id].error).toContain('Superseded');
    expect(rows[admitted.id].status).toBe('queued');
  });
});

describe('repository approval', () => {
  const unapproved = { ...project, repositoryApprovedAt: null, repositoryApprovedKey: null };

  it('is required to queue manual and push builds', async () => {
    await expect(enqueueBuild(unapproved, env, 'main', 'a'.repeat(40), 'user')).rejects.toThrow('administrator must approve');
    expect(await queuePushBuilds(unapproved, 'main', 'a'.repeat(40))).toBe('unapproved');
    expect(mockVerify).not.toHaveBeenCalled(); expect(mockRepos.Build.rows).toHaveLength(0);
  });

  it('is checked again before the build runs', async () => {
    const build = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push');
    await mockRepos.Project.update('p', { repositoryUrl: 'https://github.com/acme/other.git' });
    await runOperation(build.id);
    expect(runBuildJob).not.toHaveBeenCalled();
    expect(mockRepos.Build.rows[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('administrator must approve') });
  });
});

describe('per-project limits', () => {
  it('caps queued builds per project', async () => {
    process.env.BUILDS_MAX_QUEUED_PER_PROJECT = '2';
    await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'user');
    await enqueueBuild(project, env, 'main', 'b'.repeat(40), 'user');
    await expect(enqueueBuild(project, env, 'main', 'c'.repeat(40), 'user')).rejects.toBeInstanceOf(BuildLimitError);
    // Another project's queue is unaffected.
    await mockRepos.Environment.save({ id: 'e2', projectId: 'p2', isActive: true });
    await expect(enqueueBuild({ ...project, id: 'p2' }, { id: 'e2', projectId: 'p2', isActive: true } as any, 'main', 'c'.repeat(40), 'user')).resolves.toBeDefined();
  });

  it('reports a full queue for pushes without falling back to another flow', async () => {
    process.env.BUILDS_MAX_QUEUED_PER_PROJECT = '1';
    const other = { id: 'e-other', projectId: 'p', isActive: true, buildOnPush: false, buildBranch: 'main' };
    await mockRepos.Environment.save(other);
    await enqueueBuild(project, other as any, 'main', 'a'.repeat(40), 'user');
    expect(await queuePushBuilds(project, 'main', 'b'.repeat(40))).toBe('limited');
  });

  it('rate limits manual triggers per project', async () => {
    process.env.BUILDS_MANUAL_PER_10_MINUTES = '2';
    for (const id of ['m1', 'm2']) await mockRepos.Build.save({ id, projectId: 'p', triggeredBy: 'user', status: 'succeeded', createdAt: new Date() });
    await mockRepos.Build.save({ id: 'push', projectId: 'p', triggeredBy: 'push', status: 'succeeded', createdAt: new Date() });
    await expect(assertManualBuildAllowed('p')).rejects.toBeInstanceOf(BuildLimitError);
    await expect(assertManualBuildAllowed('p2')).resolves.toBeUndefined();
    mockRepos.Build.rows.forEach((b: any) => { b.createdAt = new Date(Date.now() - 11 * 60 * 1000); });
    await expect(assertManualBuildAllowed('p')).resolves.toBeUndefined();
  });
});

it('builds, pins the digest reported by the trusted push step, then invokes the existing deploy steps', async () => {
  const build = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push');
  await runOperation(build.id);
  expect((await store.get(build.id))?.status).toBe('succeeded');
  expect(mockDeploy).toHaveBeenCalledTimes(1);
  expect(mockRepos.Build.rows[0]).toMatchObject({ status: 'succeeded', imageDigest: digest });
  expect(mockRepos.Build.rows[0].jobSubmittedAt).toBeInstanceOf(Date);
  expect(mockRepos.Environment.rows[0].sourceImage).toBe(`registry.example/p-p/e-e@${digest}`);
  expect(mockRepos.Deployment.rows[0].metadata.sourceBuild).toBe(true);
  expect(registryManifest).not.toHaveBeenCalledWith(expect.stringContaining(':' + 'a'.repeat(40)));
  expect(cleanupBuildSecret).toHaveBeenCalled();
});

it('a failed build cannot update the environment image or deploy, and keeps a user-safe reason', async () => {
  (runBuildJob as jest.Mock).mockRejectedValueOnce(new BuildStopped('Build Job timed out'));
  const build = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push');
  await runOperation(build.id);
  expect((await store.get(build.id))?.status).toBe('failed');
  expect(mockRepos.Build.rows[0]).toMatchObject({ status: 'failed', error: 'Build Job timed out' });
  expect(mockRepos.Environment.rows[0].sourceImage).toBeUndefined();
  expect(mockDeploy).not.toHaveBeenCalled(); expect(cleanupBuildSecret).toHaveBeenCalled();
});

it('a superseded build stays cancelled and never runs', async () => {
  const build = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push', { headCheckedAt: new Date(1000) });
  await enqueueBuild(project, env, 'main', 'b'.repeat(40), 'push', { headCheckedAt: new Date(2000) });
  await runOperation(build.id);
  expect(runBuildJob).not.toHaveBeenCalled();
  expect(mockRepos.Build.rows.find((b: any) => b.id === build.id).status).toBe('cancelled');
});

it('repairs queued rows created before an operation was saved', async () => {
  await mockRepos.Build.save({ id: 'orphan', projectId: 'p', environmentId: 'e', status: 'queued' });
  await recoverBuildQueue();
  expect((await store.get('orphan'))?.type).toBe('source.build');
});

it('preserves succeeded builds when retrying a step after interruption', async () => {
  const build = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push');
  mockRepos.Build.rows[0].status = 'succeeded';
  await buildOperation.steps[0].run({ state: { buildId: build.id }, setOutput: jest.fn() } as any);
  expect(runBuildJob).not.toHaveBeenCalled();
});

it('does not roll an older build over a deployment created while it was interrupted', async () => {
  const build = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push');
  await mockRepos.Deployment.save({ id: 'new', environmentId: 'e', createdAt: new Date(Date.now() + 1000) });
  await runOperation(build.id);
  expect(mockDeploy).not.toHaveBeenCalled();
  expect(mockRepos.Environment.rows[0].sourceImage).toBeUndefined();
});

it('defers registry cleanup failures without failing an already healthy rollout', async () => {
  const build = await enqueueBuild(project, env, 'main', 'a'.repeat(40), 'push');
  process.env.BUILDS_RETAIN = '1';
  for (const [id, age] of [['old', 1], ['new', 2]] as const) {
    await mockRepos.Build.save({ id, environmentId: 'e', status: 'succeeded', imageTag: `registry.example/p:${id}`, imageDigest: `sha256:${id}`, createdAt: new Date(age) });
  }
  (registryManifest as jest.Mock).mockResolvedValueOnce('sha256:cache').mockRejectedValueOnce(new Error('registry unavailable'));
  const ctx: any = { state: { buildId: build.id }, setOutput: jest.fn() };
  await buildOperation.steps[buildOperation.steps.length - 1].run(ctx);
  expect(ctx.setOutput).toHaveBeenCalledWith({ retention: 'Deferred until the next successful build' });
  delete process.env.BUILDS_RETAIN;
});

describe('retention', () => {
  const seed = async () => {
    process.env.BUILDS_RETAIN = '1';
    for (const [id, age] of [['old', 1], ['new', 2]] as const) {
      await mockRepos.Build.save({ id, environmentId: 'e', status: 'succeeded', imageTag: `registry.example/p:${id}`, imageDigest: `sha256:${id}`, createdAt: new Date(age) });
    }
  };
  afterEach(() => { delete process.env.BUILDS_RETAIN; });

  it('prunes old images when the repository has no cache image (Dockerfile builds)', async () => {
    await seed();
    (registryManifest as jest.Mock).mockImplementation(async (_image: string, method?: string) => {
      if (method === 'DELETE') return '';
      throw new RegistryNotFoundError('Registry has no such manifest');
    });
    await pruneBuildImages('e');
    expect(registryManifest).toHaveBeenCalledWith('registry.example/p@sha256:old', 'DELETE');
    expect(mockRepos.Build.rows.find((b: any) => b.id === 'old').prunedAt).toBeInstanceOf(Date);
    expect(mockRepos.Build.rows.find((b: any) => b.id === 'new').prunedAt).toBeUndefined();
  });

  it('keeps every image when the cache image cannot be checked', async () => {
    await seed();
    (registryManifest as jest.Mock).mockRejectedValueOnce(new Error('Registry HEAD failed (503)'));
    await expect(pruneBuildImages('e')).rejects.toThrow('503');
    expect(registryManifest).not.toHaveBeenCalledWith(expect.anything(), 'DELETE');
    expect(mockRepos.Build.rows.every((b: any) => !b.prunedAt)).toBe(true);
  });

  it('protects images that share the cache digest', async () => {
    await seed();
    (registryManifest as jest.Mock).mockImplementation(async (_image: string, method?: string) => (method === 'DELETE' ? '' : 'sha256:old'));
    await pruneBuildImages('e');
    expect(registryManifest).not.toHaveBeenCalledWith(expect.anything(), 'DELETE');
  });
});
