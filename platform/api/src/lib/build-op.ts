import crypto from 'crypto';
import { getDb } from '../config/database';
import { Build, BuildStatus } from '../entities/Build';
import { Environment } from '../entities/Environment';
import { Project } from '../entities/Project';
import { Deployment, DeploymentStatus } from '../entities/Deployment';
import { createOperation, defineOperation, getOperation, runOperation } from './operations';
import { deployOperation } from './deploy-op';
import { projectLockKey, LockBusyError } from './locks';
import { positiveBuildInt, retentionCandidates, validateBuildRef } from './build-spec';
import { BuildStopped, RegistryNotFoundError, cancelBuildJob, cleanupBuildSecret, registryManifest, runBuildJob, signBuiltImage } from './build-runtime';
import { BuildSourceError, checkBranchHead } from './build-source';
import { AuditLog } from '../entities/AuditLog';
import { RepositoryNotApprovedError, repositoryApproved } from './repository-binding';

export const BUILD_OPERATION = 'source.build';
type BuildState = { buildId: string; deploymentId: string; preview?: boolean; appName?: string; destNs?: string; host?: string; source?: boolean };

/** Rejections callers may show to users verbatim (no provider or cluster detail). */
export class BuildLimitError extends Error {}

/** A build for a newer commit of the same branch already exists; older commits never replace it. */
export class BuildSupersededError extends Error {
  constructor() { super('A newer commit of this branch is already built or queued'); }
}

/** The Git provider could not confirm a pushed commit; the webhook delivery should be retried. */
export class BuildProviderUnavailableError extends Error {
  constructor() { super('Could not verify the pushed commit with the Git provider; retry the delivery'); }
}

const ACTIVE: BuildStatus[] = ['queued', 'building'];
/** When the branch head was observed; rows from before this was recorded sort as oldest. */
const observedAt = (b: Build) => (b.headCheckedAt ? new Date(b.headCheckedAt).getTime() : -Infinity);

export function buildsEnabled(): boolean { return process.env.BUILDS_ENABLED === 'true'; }

export function buildQueueLimits() {
  return {
    queuedPerProject: positiveBuildInt(process.env.BUILDS_MAX_QUEUED_PER_PROJECT, 5, 100),
    manualPerWindow: positiveBuildInt(process.env.BUILDS_MANUAL_PER_10_MINUTES, 5, 100),
  };
}

async function loadBuild(id: string) {
  const ds = await getDb();
  const repo = ds.getRepository(Build);
  const build = await repo.findOneByOrFail({ id });
  const project = await ds.getRepository(Project).findOneByOrFail({ id: build.projectId, isActive: true });
  const env = await ds.getRepository(Environment).findOneByOrFail({ id: build.environmentId, projectId: project.id, isActive: true });
  return { ds, repo, build, project, env };
}

const imageOf = (build: Build) => `${build.imageTag.slice(0, build.imageTag.lastIndexOf(':'))}@${build.imageDigest}`;

export async function pruneBuildImages(environmentId: string): Promise<void> {
  const ds = await getDb();
  const builds = await ds.getRepository(Build).find({ where: { environmentId }, order: { createdAt: 'DESC' } });
  const deployments = await ds.getRepository(Deployment).find({ where: { environmentId }, order: { createdAt: 'DESC' } });
  // The current rollout remains pullable; historical images follow the retention limit.
  const protectedImages = deployments.filter(d => [DeploymentStatus.PENDING, DeploymentStatus.BUILDING, DeploymentStatus.DEPLOYING].includes(d.status)).map(d => d.imageTag);
  const live = deployments.find(d => d.status === DeploymentStatus.DEPLOYED);
  if (live) protectedImages.push(live.imageTag);
  if (builds[0]) {
    const cache = `${builds[0].imageTag.slice(0, builds[0].imageTag.lastIndexOf(':'))}:cache`;
    // Dockerfile builds never push a cache image: a missing cache has nothing to protect. Any other
    // registry error stops retention, since the cache digest could not be confirmed.
    try { protectedImages.push(`cache@${await registryManifest(cache)}`); }
    catch (error) { if (!(error instanceof RegistryNotFoundError)) throw error; }
  }
  for (const build of retentionCandidates(builds, positiveBuildInt(process.env.BUILDS_RETAIN, 10, 1000), protectedImages)) {
    const repository = build.imageTag.slice(0, build.imageTag.lastIndexOf(':'));
    await registryManifest(`${repository}@${build.imageDigest}`, 'DELETE');
    build.prunedAt = new Date();
    await ds.getRepository(Build).save(build);
  }
}

export const buildOperation = defineOperation<BuildState>({
  type: BUILD_OPERATION, resume: 'continue', maxAttempts: 3,
  summarize: s => ({ buildId: s.buildId, deploymentId: s.deploymentId }),
  async onFailed(ctx, error) {
    const { repo, build } = await loadBuild(ctx.state.buildId);
    if (build.status !== 'succeeded') {
      await cancelBuildJob(build);
      if (build.status !== 'cancelled') {
        build.status = 'failed'; build.finishedAt = new Date();
        build.error ||= 'Source build failed; see build logs and operation steps';
        await repo.update(build.id, { status: build.status, finishedAt: build.finishedAt, error: build.error });
      }
    }
    await cleanupBuildSecret(build);
    if (ctx.state.deploymentId) await deployOperation.onFailed?.(ctx, error);
  },
  steps: [
    { name: 'build', async run(ctx) {
      if (!buildsEnabled()) throw new Error('Source builds are disabled');
      const { repo, build, project } = await loadBuild(ctx.state.buildId);
      if (build.status === 'succeeded') { await cleanupBuildSecret(build); return; }
      if (build.status === 'cancelled' || build.status === 'failed') throw new Error(`Build is ${build.status}`);
      build.logLocation = `/api/projects/${build.projectId}/builds/${build.id}/logs`;
      let digest: string;
      try {
        // The approval is checked against the project as it is now, not as it was when queued.
        if (!repositoryApproved(project)) throw new BuildSourceError(new RepositoryNotApprovedError().message);
        digest = await runBuildJob(build, project, {
          saveLogs: async logs => { await repo.update(build.id, { logs }); },
          stillQueued: async () => (await repo.findOneBy({ id: build.id }))?.status === 'queued',
          markSubmitted: async () => {
            await repo.update(build.id, { status: 'building', startedAt: new Date(), jobSubmittedAt: build.jobSubmittedAt || new Date(), logLocation: build.logLocation });
          },
        });
      } catch (error) {
        // Only our own, user-safe messages are stored; anything else stays in operation steps.
        if (error instanceof BuildStopped || error instanceof BuildSourceError) await repo.update(build.id, { error: error.message });
        throw error;
      }
      build.imageDigest = digest;
      await signBuiltImage(imageOf(build));
      build.status = 'succeeded'; build.finishedAt = new Date();
      // Logs were updated independently while the Job ran.
      await repo.update(build.id, { status: build.status, imageDigest: build.imageDigest, finishedAt: build.finishedAt });
      await cleanupBuildSecret(build);
      ctx.setOutput({ image: imageOf(build), signing: 'cluster identity pending' });
    } },
    { name: 'prepare-deploy', async run(ctx) {
      const { ds, repo, build, env } = await loadBuild(ctx.state.buildId);
      if (!build.imageDigest || build.status !== 'succeeded') throw new Error('A successful build is required before deploying');
      const image = imageOf(build);
      const newer = await ds.getRepository(Deployment).find({ where: { environmentId: env.id } });
      if (newer.some(d => d.id !== build.id && d.createdAt > build.createdAt)) throw new Error('Source build superseded by a newer deployment');
      // Build ID is also the deterministic deployment ID: a crash cannot create a second rollout.
      const deployments = ds.getRepository(Deployment);
      if (!await deployments.findOneBy({ id: build.id })) {
        await deployments.save(deployments.create({ id: build.id, projectId: build.projectId, environmentId: build.environmentId,
          version: build.commitSha.slice(0, 12), branch: build.branch, commitSha: build.commitSha,
          imageTag: image, status: DeploymentStatus.PENDING, metadata: { sourceBuild: true, buildId: build.id, pullFromGit: false } }));
      }
      env.sourceImage = image;
      await ds.getRepository(Environment).save(env);
      build.deploymentId = build.id;
      await repo.update(build.id, { deploymentId: build.id });
      ctx.state.deploymentId = build.id;
    } },
    ...deployOperation.steps.map(step => ({ ...step, name: `deploy-${step.name}`, run: (ctx: any) => step.run(ctx) })),
    { name: 'retention', async run(ctx) {
      const { build } = await loadBuild(ctx.state.buildId);
      try { await pruneBuildImages(build.environmentId); }
      catch {
        // A storage cleanup failure must not turn a healthy rollout into a failed deploy.
        ctx.setOutput({ retention: 'Deferred until the next successful build' });
      }
    } },
  ],
});

async function ensureBuildOperation(build: Build): Promise<void> {
  if (!await getOperation(build.id)) {
    try {
      await createOperation(BUILD_OPERATION, { id: build.id, projectId: build.projectId,
        lockKey: projectLockKey(build.projectId, 'deploy', build.environmentId),
        input: { buildId: build.id, environmentId: build.environmentId, deploymentId: build.id }, state: { buildId: build.id, deploymentId: '' } });
    } catch (error) { if (!await getOperation(build.id)) throw error; }
  }
}

/** Manual triggers are rate limited per project (multi-replica safe: counted in PostgreSQL). */
export async function assertManualBuildAllowed(projectId: string): Promise<void> {
  const since = Date.now() - 10 * 60 * 1000;
  const recent = (await (await getDb()).getRepository(Build).find({ where: { projectId }, order: { createdAt: 'DESC' }, take: 200 }))
    .filter(b => b.triggeredBy !== 'push' && new Date(b.createdAt).getTime() >= since);
  if (recent.length >= buildQueueLimits().manualPerWindow) throw new BuildLimitError('Too many manual builds for this project; try again in a few minutes');
}

export interface EnqueueOptions {
  /**
   * When the commit was confirmed as the branch head (taken before asking the provider). Builds
   * are ordered by it: a commit observed earlier never supersedes or replaces one observed later.
   */
  headCheckedAt?: Date;
}

export async function enqueueBuild(project: Project, env: Environment, branch: string, commitSha: string, triggeredBy: string, options: EnqueueOptions = {}): Promise<Build> {
  if (!buildsEnabled()) throw new Error('Source builds are disabled');
  validateBuildRef(branch, commitSha);
  if (env.projectId !== project.id || !env.isActive || !project.repositoryUrl) throw new Error('Active linked environment required');
  if (!repositoryApproved(project)) throw new RepositoryNotApprovedError();
  const registry = process.env.BUILDS_REGISTRY || '';
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/.test(registry)) throw new Error('Build registry is not configured');
  const checkedAt = options.headCheckedAt || new Date();
  const ds = await getDb();
  const repo = ds.getRepository(Build);
  const existing = await repo.find({ where: { environmentId: env.id } });
  const push = triggeredBy === 'push';
  // Repeated deliveries of a push share the build that is still queued or running.
  let build = push ? existing.find(b => b.triggeredBy === 'push' && b.commitSha === commitSha && ACTIVE.includes(b.status)) || null : null;
  if (!build) {
    if (existing.some(b => b.branch === branch && b.commitSha !== commitSha && b.status !== 'cancelled' && observedAt(b) > checkedAt.getTime())) {
      throw new BuildSupersededError();
    }
    // A pushed commit that was already built (for example after a revert) is deployed again from
    // its image instead of being rebuilt.
    const reusable = push ? existing.filter(b => b.commitSha === commitSha && b.status === 'succeeded' && b.imageDigest && !b.prunedAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] : undefined;
    if (!reusable) {
      const queued = await repo.count({ where: { projectId: project.id, status: 'queued' } });
      if (queued >= buildQueueLimits().queuedPerProject) throw new BuildLimitError('This project already has the maximum number of queued builds');
    }
    if (push) {
      // A newer push replaces queued (not yet admitted) builds of commits observed before it.
      for (const old of existing.filter(b => b.status === 'queued' && !b.jobSubmittedAt && observedAt(b) < checkedAt.getTime())) {
        await repo.update(old.id, { status: 'cancelled', finishedAt: new Date(), error: `Superseded by a newer push (${commitSha.slice(0, 12)})` });
      }
    }
    const now = new Date();
    build = repo.create({ id: crypto.randomUUID(), projectId: project.id, environmentId: env.id, branch, commitSha, triggeredBy, headCheckedAt: checkedAt,
      ...(reusable
        ? { status: 'succeeded' as const, imageTag: reusable.imageTag, imageDigest: reusable.imageDigest, startedAt: now, finishedAt: now,
          logs: `Commit already built by build ${reusable.id}; deploying its image again.` }
        : { status: 'queued' as const, imageTag: `${registry}/p-${project.id}/e-${env.id}:${commitSha}`, logs: '' }) });
    try { await repo.save(build); }
    catch (error: any) {
      if (error.code !== '23505') throw error;
      build = (await repo.find({ where: { environmentId: env.id, commitSha, triggeredBy: 'push' } })).find(b => ACTIVE.includes(b.status)) || null;
      if (!build) throw error;
    }
  }
  await ensureBuildOperation(build);
  setImmediate(() => { runOperation(build!.id).catch(error => { if (!(error instanceof LockBusyError)) console.error('[build] operation unavailable'); }); });
  return build;
}

/** Repair the durable queue if the API stopped between inserting a build and its operation. */
export async function recoverBuildQueue(): Promise<void> {
  if (!buildsEnabled()) return;
  const ds = await getDb();
  for (const build of await ds.getRepository(Build).find({ where: { status: 'queued' } })) await ensureBuildOperation(build);
}

export type PushBuildResult = 'none' | 'queued' | 'rejected' | 'limited' | 'unapproved' | 'superseded';

/**
 * Queue builds for opted-in environments whose linked branch matches the push. The pushed SHA
 * comes from the webhook payload, so before anything is queued the provider is asked whether
 * that SHA is the current head of the linked branch of the project's linked repository.
 * - head: queued;
 * - an older commit of the branch: skipped, since a newer commit exists;
 * - not on the branch: rejected and audited;
 * - no definite answer: BuildProviderUnavailableError, so the delivery can be retried.
 */
export async function queuePushBuilds(project: Project, branch: string, commit: string): Promise<PushBuildResult> {
  if (!buildsEnabled()) return 'none';
  const ds = await getDb();
  const envs = await ds.getRepository(Environment).find({ where: { projectId: project.id, isActive: true, buildOnPush: true, buildBranch: branch } });
  if (!envs.length) return 'none';
  if (!repositoryApproved(project)) return 'unapproved';
  const headCheckedAt = new Date();
  let check: 'head' | 'superseded' | 'not-on-branch' = 'not-on-branch';
  if (/^[a-f0-9]{40}$/.test(commit) && project.repositoryUrl) {
    try { check = await checkBranchHead(project.repositoryUrl, branch, commit); }
    catch { throw new BuildProviderUnavailableError(); }
  }
  if (check === 'superseded') return 'superseded';
  if (check === 'not-on-branch') {
    try {
      const audit = ds.getRepository(AuditLog);
      await audit.save(audit.create({ userId: null, action: 'build.push_rejected', targetType: 'project', targetId: project.id, ipAddress: null,
        metadata: { branch, commit: String(commit).slice(0, 40), reason: 'Commit is not on the linked branch of the linked repository' } }));
    } catch { console.warn('[build] could not record a rejected push in the audit log'); }
    return 'rejected';
  }
  let queued = 0; let superseded = 0;
  for (const env of envs) {
    try { await enqueueBuild(project, env, branch, commit, 'push', { headCheckedAt }); queued++; }
    catch (error) {
      if (error instanceof BuildSupersededError) superseded++;
      else if (!(error instanceof BuildLimitError)) throw error;
    }
  }
  return queued ? 'queued' : superseded ? 'superseded' : 'limited';
}
