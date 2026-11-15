import crypto from 'crypto';
import { UserRole } from '../entities/User';
import { k8sStatusCode } from './config-store';
import { readSecretData } from './k8s';
import { platformLockKey } from './locks';
import { createOperation, defineOperation, getOperation, StepContext } from './operations';

/**
 * Second phase of a Redis Sentinel password rotation (durable, leader-run).
 *
 * The rotation leaves the previous and the new password valid on every member, because
 * the Redis and Sentinel liveness probes read the password from the mounted
 * databases/redis Secret and kubelet refreshes that mount only after a delay (about
 * 60-90 s). Dropping the old password before then made every probe fail with NOAUTH and
 * restarted the pods. This operation waits REDIS_DROP_DELAY_MS after the Secret was
 * patched, then makes the new password the only one for the default user and plat-api.
 * plat-sentinel keeps the new and the one previous password, so apps that have not
 * restarted keep discovering until the next rotation's drop removes the older one.
 *
 * It is stored in the operations table and picked up by the leader's resume job, so it
 * survives API restarts and does not hold up the rotation request. The step is idempotent
 * and does nothing when a newer rotation has replaced the password in the meantime.
 */
export const REDIS_PASSWORD_DROP_OPERATION = 'platform.redis-password-drop';
/** Kubelet's Secret refresh (sync period + cache TTL) plus margin. */
export const REDIS_DROP_DELAY_MS = 180_000;
export const REDIS_DROP_RETRY_MS = 60_000;
/** Give up (old password stays valid, admins are notified) after this many failed tries. */
export const REDIS_DROP_MAX_TRIES = 30;

/** Same lock as the rotation itself (lib/secret-rotate), so the two never overlap. */
const ROTATION_LOCK_KEY = platformLockKey('secret-rotation');

type DropState = {
  /** The password that must remain (state is stored encrypted). */
  next: string;
  /** The password being replaced; only its derived plat-sentinel password is kept. */
  previous?: string;
  /** Epoch ms before which the old password must stay valid. */
  notBefore: number;
  tries: number;
};

/** Deterministic operation id, so re-running the scheduling step never creates a second drop. */
export function redisDropOperationId(rotationOperationId: string): string {
  const h = crypto.createHash('sha256').update(`redis-password-drop:${rotationOperationId}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function retryLater(ctx: StepContext<DropState>, reason: string): never {
  const s = ctx.state;
  s.tries = (s.tries || 0) + 1;
  if (s.tries >= REDIS_DROP_MAX_TRIES) {
    throw new Error(`gave up after ${s.tries} tries: ${reason}`);
  }
  return ctx.defer(Date.now() + REDIS_DROP_RETRY_MS, `retrying: ${reason}`);
}

export const redisPasswordDropOperation = defineOperation<DropState>({
  type: REDIS_PASSWORD_DROP_OPERATION,
  sensitive: true,
  resume: 'continue',
  summarize: (s) => ({ tries: s.tries || 0 }),
  async onFailed(ctx, error) {
    ctx.emit('notify.roles', {
      roles: [UserRole.ADMIN, UserRole.DEVOPS],
      title: 'Old Redis password still works',
      body: `The previous Redis password could not be removed (${error.slice(0, 200)}). Redis keeps working with both passwords. Rotate secrets again to retry.`,
      kind: 'security',
      link: '/settings',
      metadata: { operationId: ctx.operationId },
    });
  },
  steps: [
    {
      name: 'drop-previous-password',
      async run(ctx) {
        const s = ctx.state;
        if (Date.now() < s.notBefore) {
          ctx.defer(s.notBefore, 'waiting for the new Redis password to reach every pod');
        }

        let current: Record<string, string>;
        let pending: Record<string, string> = {};
        try {
          current = await readSecretData('databases', 'redis');
        } catch {
          return retryLater(ctx, 'could not read the databases/redis Secret');
        }
        try {
          pending = await readSecretData('platform', 'platform-rotate-pending');
        } catch (err) {
          if (k8sStatusCode(err) !== 404) return retryLater(ctx, 'could not read the pending rotation Secret');
        }
        // A newer rotation owns the passwords now; its own drop step cleans up.
        const superseded = current['redis-password'] !== s.next
          || (!!pending.REDIS_PASSWORD_NEW && pending.REDIS_PASSWORD_NEW !== s.next);
        if (superseded) {
          ctx.setOutput({ dropped: false, note: 'a newer rotation replaced this password; nothing to do' });
          return;
        }

        const { dropPreviousSentinelPassword } = await import('./redis-password-rotate');
        try {
          await dropPreviousSentinelPassword(s.next, s.previous);
        } catch (err: any) {
          // The error text is generic (never echoes credentials).
          return retryLater(ctx, String(err?.message || 'Redis unavailable').slice(0, 200));
        }
        ctx.setOutput({ dropped: true });
      },
    },
  ],
});

/**
 * Durably schedule the drop of the previous Redis password `delayMs` from now. Idempotent
 * per rotation: a second call returns the existing operation. The leader's resume job runs
 * it (lib/operation-worker), never this request.
 */
export async function scheduleRedisPasswordDrop(opts: {
  rotationOperationId: string;
  next: string;
  previous?: string;
  actorUserId?: string | null;
  delayMs?: number;
}): Promise<{ operationId: string; notBefore: Date }> {
  const id = redisDropOperationId(opts.rotationOperationId);
  const existing = await getOperation(id);
  if (existing) {
    const at = Number((existing.state as Partial<DropState>)?.notBefore) || Date.now();
    return { operationId: id, notBefore: new Date(at) };
  }
  const notBefore = Date.now() + (opts.delayMs ?? REDIS_DROP_DELAY_MS);
  await createOperation<DropState>(REDIS_PASSWORD_DROP_OPERATION, {
    id,
    lockKey: ROTATION_LOCK_KEY,
    input: { kind: 'redis-password-drop', rotationOperationId: opts.rotationOperationId },
    state: { next: opts.next, previous: opts.previous, notBefore, tries: 0 },
    createdById: opts.actorUserId || null,
  });
  return { operationId: id, notBefore: new Date(notBefore) };
}
