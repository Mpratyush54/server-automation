import { getDb } from '../config/database';
import { Deployment } from '../entities/Deployment';
import { Environment, EnvironmentName } from '../entities/Environment';
import { terminateK8sPreview } from './k8s';

const PREVIEW_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // check every 15 minutes

let timer: ReturnType<typeof setInterval> | null = null;

export function startPreviewDecayScheduler() {
  if (timer) return;
  console.log('[decay] Preview environment decay scheduler started (TTL: 72h, check: 15min)');
  timer = setInterval(runDecayCheck, CHECK_INTERVAL_MS);
  // Run once on startup after a short delay
  setTimeout(runDecayCheck, 30_000);
}

export function stopPreviewDecayScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function runDecayCheck() {
  try {
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
        await terminateK8sPreview(dep.branch);
        dep.status = 'expired' as any;
        dep.terminatedAt = new Date();
        dep.metadata = { ...(dep.metadata as any), decayReason: '72h-ttl-expired' };
        await deploymentRepo.save(dep);
        console.log(`[decay] Expired preview: ${dep.branch} (${dep.id})`);
      } catch (err: any) {
        console.error(`[decay] Failed to expire ${dep.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[decay] Scheduler error: ${err.message}`);
  }
}
