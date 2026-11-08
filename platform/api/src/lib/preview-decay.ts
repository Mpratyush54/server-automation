import { getDb } from '../config/database';
import { Deployment } from '../entities/Deployment';
import { Environment, EnvironmentName } from '../entities/Environment';
import { terminateK8sPreview } from './k8s';
import { registerLeaderJob } from './scheduler';

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Previews older than this are expired (PREVIEW_TTL_HOURS, default 72). */
const PREVIEW_TTL_MS = numEnv('PREVIEW_TTL_HOURS', 72) * 60 * 60 * 1000;
/** How often the leader checks (PREVIEW_DECAY_INTERVAL_SECONDS, default 15 min). */
const CHECK_INTERVAL_MS = numEnv('PREVIEW_DECAY_INTERVAL_SECONDS', 15 * 60) * 1000;

export const PREVIEW_DECAY_JOB = 'preview-decay';

/**
 * Start the preview decay schedule. The timer only runs on the replica holding
 * the platform-api-leader Lease and stops when leadership is lost, so the
 * check runs once per interval cluster-wide.
 */
export function startPreviewDecayScheduler(): void {
  const scheduled = registerLeaderJob({
    name: PREVIEW_DECAY_JOB,
    intervalMs: CHECK_INTERVAL_MS,
    initialDelayMs: Math.min(30_000, CHECK_INTERVAL_MS),
    run: runDecayCheck,
  });
  if (scheduled) {
    console.log(`[decay] Preview decay scheduled on the leader (TTL: ${PREVIEW_TTL_MS / 3_600_000}h, check: ${CHECK_INTERVAL_MS / 1000}s)`);
  }
}

/** One decay pass. Throws on a scheduler-level error so the run is counted as failed. */
export async function runDecayCheck(): Promise<void> {
  console.log(`[decay] run started (${process.env.HOSTNAME || 'local'})`);
  const ds = await getDb();
  const deploymentRepo = ds.getRepository(Deployment);
  const envRepo = ds.getRepository(Environment);

  // Find all preview environments
  const previewEnvs = await envRepo.find({ where: { name: EnvironmentName.PREVIEW } });
  if (previewEnvs.length === 0) return;

  const previewEnvIds = previewEnvs.map((e) => e.id);
  const cutoff = new Date(Date.now() - PREVIEW_TTL_MS);

  // Find deployed/preview deployments older than 72h
  const staleDeployments = await deploymentRepo
    .createQueryBuilder('d')
    .where('d.environment_id IN (:...envIds)', { envIds: previewEnvIds })
    .andWhere('d.status IN (:...statuses)', { statuses: ['deployed', 'building', 'deploying'] })
    .andWhere('d.created_at < :cutoff', { cutoff })
    .andWhere('d.preview_url IS NOT NULL')
    .getMany();

  if (staleDeployments.length === 0) return;

  console.log(`[decay] Found ${staleDeployments.length} expired preview deployments`);

  for (const dep of staleDeployments) {
    try {
      if (!await terminateK8sPreview(dep.branch, dep.projectId, dep.metadata?.previewResourceName as string | undefined)) throw new Error('Preview termination failed');
      dep.status = 'expired' as any;
      dep.terminatedAt = new Date();
      dep.metadata = { ...(dep.metadata as any), decayReason: '72h-ttl-expired' };
      await deploymentRepo.save(dep);
      console.log(`[decay] Expired preview: ${dep.branch} (${dep.id})`);
    } catch (err: any) {
      console.error(`[decay] Failed to expire ${dep.id}: ${err.message}`);
    }
  }
}
