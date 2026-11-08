import { getDb } from '../config/database';
import { Deployment, DeploymentStatus } from '../entities/Deployment';
import { BackgroundJob } from '../entities/BackgroundJob';
import {
  JobHandler, JobStore, recoverStaleJobs, typeormJobStore,
} from './background-jobs';

/**
 * Deployment rollout recovery.
 *
 * POST /deploy runs the rollout as a step-logged operation (`lib/deploy-op.ts`,
 * issue #23) under the per-environment deploy lock; the operation worker, which
 * runs only on the lease leader (issue #19), resumes it after an API restart or
 * fails it once its attempts are used up. This module keeps the leader-side
 * safety nets: rows in `background_jobs` of type `deploy` are converted to a
 * deploy operation, and non-terminal deployments with neither a job nor an
 * operation (rollouts from an API version without durable deploys) are failed,
 * so a deployment never stays pending/building/deploying.
 */

export const DEPLOY_JOB_TYPE = 'deploy';

const NON_TERMINAL: DeploymentStatus[] = [DeploymentStatus.PENDING, DeploymentStatus.BUILDING, DeploymentStatus.DEPLOYING];

/** Deployments older than this in a non-terminal state with no job row are orphans (pre-upgrade rollouts). */
export const ORPHAN_AGE_MS = 10 * 60 * 1000;

export function isTerminalDeploymentStatus(status: DeploymentStatus | string): boolean {
  return !NON_TERMINAL.includes(status as DeploymentStatus);
}

/** Set a deployment to FAILED unless it already reached a terminal state. */
export async function markFailed(deploymentId: string, error: string): Promise<void> {
  const ds = await getDb();
  const repo = ds.getRepository(Deployment);
  const dep = await repo.findOne({ where: { id: deploymentId } });
  if (dep && !isTerminalDeploymentStatus(dep.status)) {
    dep.status = DeploymentStatus.FAILED;
    dep.metadata = { ...(dep.metadata || {}), error };
    await repo.save(dep);
  }
}

export const deployJobHandler: JobHandler = {
  async run(job, ctx) {
    // Deploys run as operations now; a queued `deploy` job is handed over to one.
    await ctx.setStep('deploy-operation');
    const { executeOperation } = await import('./operations');
    const { DEPLOY_OPERATION } = await import('./deploy-op');
    const ds = await getDb();
    const dep = await ds.getRepository(Deployment).findOne({ where: { id: job.targetId } });
    if (!dep) return;
    await executeOperation(DEPLOY_OPERATION, {
      projectId: dep.projectId,
      input: { deploymentId: dep.id, environmentId: dep.environmentId },
      state: { deploymentId: dep.id },
    });
  },
  async isComplete(job) {
    const ds = await getDb();
    const dep = await ds.getRepository(Deployment).findOne({ where: { id: job.targetId } });
    return !dep || isTerminalDeploymentStatus(dep.status);
  },
  async onGiveUp(job, reason) {
    await markFailed(job.targetId, reason);
  },
};

export const jobHandlers: Record<string, JobHandler> = { [DEPLOY_JOB_TYPE]: deployJobHandler };

let store: JobStore | null = null;
export function getJobStore(): JobStore {
  if (!store) store = typeormJobStore(async () => (await getDb()).getRepository(BackgroundJob));
  return store;
}

/** Test hook. */
export function setJobStoreForTests(s: JobStore | null): void {
  store = s;
}

/**
 * Deployments left non-terminal with no job row and no deploy operation
 * (POST /deploy rollouts started by an API version without durable deploys,
 * then interrupted) are marked failed.
 */
export async function failOrphanedDeployments(): Promise<number> {
  const ds = await getDb();
  const repo = ds.getRepository(Deployment);
  const orphans = await repo.createQueryBuilder('d')
    .where('d.status IN (:...statuses)', { statuses: NON_TERMINAL })
    .andWhere('d.createdAt < :cutoff', { cutoff: new Date(Date.now() - ORPHAN_AGE_MS) })
    // Only rollouts started by POST /deploy (they always carry pullFromGit);
    // webhook "staging" rows stay pending while an external CI pipeline runs.
    .andWhere(`(d.metadata ->> 'pullFromGit') IS NOT NULL`)
    .andWhere('NOT EXISTS (SELECT 1 FROM background_jobs j WHERE j.target_id = d.id)')
    .andWhere(`NOT EXISTS (SELECT 1 FROM operations o WHERE o.type = 'deployment.deploy' AND o.input ->> 'deploymentId' = d.id::text)`)
    .getMany();
  for (const dep of orphans) {
    dep.status = DeploymentStatus.FAILED;
    dep.metadata = { ...(dep.metadata || {}), error: 'Deployment interrupted by an API restart' };
    await repo.save(dep);
    console.warn(`[deploy-recovery] marked orphaned deployment ${dep.id} failed`);
  }
  return orphans.length;
}

/** Leader job: resume or fail interrupted rollouts. */
export async function runDeployRecovery(): Promise<void> {
  const { resumed, failed } = await recoverStaleJobs(getJobStore(), jobHandlers);
  const orphans = await failOrphanedDeployments();
  if (resumed.length || failed.length || orphans) {
    console.log(`[deploy-recovery] resumed=${resumed.length} failed=${failed.length} orphaned=${orphans}`);
  }
}
