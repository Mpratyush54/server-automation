import { getDb } from '../config/database';
import { AgentCommandApproval } from '../entities/AgentCommandApproval';
import { BackgroundJob } from '../entities/BackgroundJob';

export const TOKEN_CLEANUP_JOB = 'token-cleanup';
/** Finished background_jobs rows are kept this long for troubleshooting. */
export const FINISHED_JOB_RETENTION_DAYS = 30;

/**
 * Housekeeping, idempotent and safe to run on any schedule:
 * - approved agent-command approvals whose window lapsed are marked `expired`
 *   (execute already refuses them; this keeps listings accurate);
 * - finished background_jobs rows older than the retention window are pruned.
 */
export async function runTokenCleanup(now: Date = new Date()): Promise<{ expiredApprovals: number; prunedJobs: number }> {
  const ds = await getDb();
  const approvals = await ds.getRepository(AgentCommandApproval)
    .createQueryBuilder()
    .update(AgentCommandApproval)
    .set({ status: 'expired' })
    .where('status = :approved', { approved: 'approved' })
    .andWhere('approval_expires_at IS NOT NULL AND approval_expires_at < :now', { now })
    .execute();
  const cutoff = new Date(now.getTime() - FINISHED_JOB_RETENTION_DAYS * 86_400_000);
  const jobs = await ds.getRepository(BackgroundJob)
    .createQueryBuilder()
    .delete()
    .from(BackgroundJob)
    .where(`status IN ('succeeded', 'failed')`)
    .andWhere('finished_at < :cutoff', { cutoff })
    .execute();
  const result = { expiredApprovals: approvals.affected || 0, prunedJobs: jobs.affected || 0 };
  console.log(`[token-cleanup] expired approvals=${result.expiredApprovals} pruned jobs=${result.prunedJobs}`);
  return result;
}
