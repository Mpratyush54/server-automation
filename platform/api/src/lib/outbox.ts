import { resolveOperationStore } from './operations';
import type { OutboxDraft } from './operation-store';

/**
 * Outbox dispatcher. Handlers are registered by kind; messages are claimed with a visibility
 * timeout (so two replicas never send the same message concurrently) and retried with
 * exponential backoff. Delivery is at-least-once: handlers should tolerate duplicates.
 */
export type OutboxHandler = (payload: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, OutboxHandler>();
const MAX_ATTEMPTS = 8;

export function registerOutboxHandler(kind: string, handler: OutboxHandler): void {
  handlers.set(kind, handler);
}

/** Enqueue side effects that are not tied to an operation step. */
export async function enqueueOutbox(msgs: OutboxDraft[], operationId: string | null = null): Promise<void> {
  const store = await resolveOperationStore();
  await store.enqueueOutbox(operationId, msgs);
}

export function retryDelayMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

export async function dispatchOutbox(opts: { operationId?: string; limit?: number } = {}): Promise<{ sent: number; failed: number }> {
  ensureDefaultHandlers();
  const store = await resolveOperationStore();
  const batch = await store.claimOutbox(opts.limit || 50, opts.operationId);
  let sent = 0;
  let failed = 0;
  for (const msg of batch) {
    const handler = handlers.get(msg.kind);
    try {
      if (!handler) throw new Error(`no outbox handler for ${msg.kind}`);
      await handler(msg.payload);
      await store.completeOutbox(msg.id, true);
      sent++;
    } catch (err: any) {
      failed++;
      const retryAt = msg.attempts < MAX_ATTEMPTS ? new Date(Date.now() + retryDelayMs(msg.attempts)) : null;
      await store.completeOutbox(msg.id, false, String(err?.message || err), retryAt).catch(() => {});
    }
  }
  return { sent, failed };
}

let defaultsRegistered = false;

/** Built-in side effects. Kept here so every replica can dispatch any message. */
function ensureDefaultHandlers(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;

  registerOutboxHandler('notify.roles', async (p) => {
    const { notifyRoles } = await import('./notify');
    await notifyRoles(p as any);
  });

  registerOutboxHandler('notify.user', async (p) => {
    const { notifyUser } = await import('./notify');
    await notifyUser(p as any);
  });

  registerOutboxHandler('deploy.marker', async (p) => {
    const { publishReleaseMarker } = await import('./release-markers');
    await publishReleaseMarker(String(p.deploymentId));
  });

  // Deployment result e-mail to DevOps users via the default SMTP config.
  registerOutboxHandler('deploy.email', async (p) => {
    const { getDb } = await import('../config/database');
    const { SmtpConfig } = await import('../entities/SmtpConfig');
    const { User, UserRole } = await import('../entities/User');
    const ds = await getDb();
    const smtpCfg = await ds.getRepository(SmtpConfig).findOne({ where: { isDefault: true } });
    if (!smtpCfg) return;
    const devopsUsers = await ds.getRepository(User).find({ where: { role: UserRole.DEVOPS } });
    const to = devopsUsers.map((u) => u.email).filter(Boolean);
    if (!to.length) return;
    const smtp = await import('./smtp-service');
    const projectName = String(p.projectName || '');
    const environment = String(p.environment || '');
    if (p.success) {
      const html = smtp.buildDeploymentSuccessEmail({
        projectName, environment, version: String(p.version || ''), url: String(p.url || ''),
        commitSha: String(p.commitSha || ''), deployedBy: 'Platform',
      });
      await smtp.sendMail(smtpCfg as any, to, `[${projectName}] Deployment Successful — ${environment}`, html);
    } else {
      const html = smtp.buildDeploymentFailedEmail({
        projectName, environment, version: String(p.version || ''), error: String(p.error || 'Unknown failure'),
        deployedBy: 'Platform',
      });
      await smtp.sendMail(smtpCfg as any, to, `[${projectName}] Deployment FAILED — ${environment}`, html);
    }
  });

  // ClickUp preview comment + task link after a successful deploy.
  registerOutboxHandler('deploy.clickup', async (p) => {
    const { postComment, formatPreviewComment } = await import('./clickup');
    const { getDb } = await import('../config/database');
    const { ClickupTaskLink } = await import('../entities/ClickupTaskLink');
    const comment = await formatPreviewComment({
      project: String(p.projectName || ''), branch: String(p.branch || ''), url: String(p.url || ''), commit: String(p.commit || ''),
    });
    await postComment(String(p.clickupTaskId), comment);
    const ds = await getDb();
    const repo = ds.getRepository(ClickupTaskLink);
    const exists = await repo.findOne({ where: { clickupTaskId: String(p.clickupTaskId), deploymentId: String(p.deploymentId) } });
    if (!exists) {
      await repo.save(repo.create({
        clickupTaskId: String(p.clickupTaskId), deploymentId: String(p.deploymentId),
        projectId: String(p.projectId), branch: String(p.branch || ''),
      }));
    }
  });
}
