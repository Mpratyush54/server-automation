import { getDb } from '../config/database';
import { AgentCommandApproval } from '../entities/AgentCommandApproval';
import { BackgroundJob } from '../entities/BackgroundJob';
import { McpToken } from '../entities/McpToken';
import { OAuthClient } from '../entities/OAuthClient';
import { UNAPPROVED_CLIENT_RETENTION_MS } from './mcp-oauth';

export const TOKEN_CLEANUP_JOB = 'token-cleanup';
/** Finished background_jobs rows are kept this long for troubleshooting. */
export const FINISHED_JOB_RETENTION_DAYS = 30;

/**
 * Housekeeping, idempotent and safe to run on any schedule:
 * - approved agent-command approvals whose window lapsed are marked `expired`
 *   (execute already refuses them; this keeps listings accurate);
 * - finished background_jobs rows older than the retention window are pruned;
 * - remote MCP tokens (#193) that expired or were revoked more than a day ago are deleted, and
 *   assistant registrations nobody approved within UNAPPROVED_CLIENT_RETENTION_MS are removed.
 */
export async function runTokenCleanup(now: Date = new Date()): Promise<{ expiredApprovals: number; prunedJobs: number; prunedMcpTokens: number; prunedMcpClients: number }> {
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
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const mcpTokens = await ds.getRepository(McpToken)
    .createQueryBuilder()
    .delete()
    .from(McpToken)
    .where('expires_at < :dayAgo OR revoked_at < :dayAgo', { dayAgo })
    .execute();
  const clientCutoff = new Date(now.getTime() - UNAPPROVED_CLIENT_RETENTION_MS);
  const mcpClients = await ds.getRepository(OAuthClient)
    .createQueryBuilder()
    .delete()
    .from(OAuthClient)
    .where('approved_at IS NULL')
    .andWhere('created_at < :clientCutoff', { clientCutoff })
    .execute();
  const result = {
    expiredApprovals: approvals.affected || 0,
    prunedJobs: jobs.affected || 0,
    prunedMcpTokens: mcpTokens.affected || 0,
    prunedMcpClients: mcpClients.affected || 0,
  };
  console.log(`[token-cleanup] expired approvals=${result.expiredApprovals} pruned jobs=${result.prunedJobs} mcp tokens=${result.prunedMcpTokens} mcp clients=${result.prunedMcpClients}`);
  return result;
}
