import { Request } from 'express';

/**
 * Webhook delivery de-duplication (issue #23). Each provider delivery id is inserted into the
 * unique `webhook_deliveries` (provider, delivery_id) index before the event is processed; a
 * provider retry of the same delivery hits the unique constraint and is acknowledged with 200
 * without being processed again. If processing fails the row is removed so a redelivery runs.
 *
 * Falls back to a bounded in-process set when the table is unusable (tests, DB outage).
 */

export type WebhookProvider = 'github' | 'gitlab';

const MAX_LEN = 128;
const memSeen = new Map<string, number>();
const MEM_MAX = 5000;

/** Delivery id header for a provider (GitLab: Idempotency-Key is stable across retries). */
export function webhookDeliveryId(provider: WebhookProvider, req: Request): string | null {
  const raw = provider === 'github'
    ? req.header('x-github-delivery')
    : req.header('idempotency-key') || req.header('x-gitlab-event-uuid');
  const v = (raw || '').trim();
  if (!v || v.length > MAX_LEN || !/^[\x21-\x7e]+$/.test(v)) return null;
  return v;
}

function memKey(provider: string, id: string) {
  return `${provider}:${id}`;
}

function memClaim(provider: string, id: string): boolean {
  const k = memKey(provider, id);
  if (memSeen.has(k)) return false;
  memSeen.set(k, Date.now());
  if (memSeen.size > MEM_MAX) {
    const oldest = memSeen.keys().next().value;
    if (oldest) memSeen.delete(oldest);
  }
  return true;
}

function isUniqueViolation(err: any): boolean {
  return err?.code === '23505' || err?.driverError?.code === '23505' || /duplicate key/i.test(String(err?.message || ''));
}

/**
 * Record a delivery. Resolves true when it is new (process it), false when it was already seen.
 */
export async function claimWebhookDelivery(provider: WebhookProvider, deliveryId: string, event?: string | null): Promise<boolean> {
  try {
    const { getDb } = await import('../config/database');
    const { WebhookDelivery } = await import('../entities/WebhookDelivery');
    const ds: any = await getDb();
    const repo = ds?.getRepository?.(WebhookDelivery);
    if (!repo || typeof repo.insert !== 'function') return memClaim(provider, deliveryId);
    await repo.insert({ provider, deliveryId, event: event ? String(event).slice(0, 64) : null });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    return memClaim(provider, deliveryId);
  }
}

/** Forget a delivery whose processing failed, so the provider's retry is processed. */
export async function releaseWebhookDelivery(provider: WebhookProvider, deliveryId: string): Promise<void> {
  memSeen.delete(memKey(provider, deliveryId));
  try {
    const { getDb } = await import('../config/database');
    const { WebhookDelivery } = await import('../entities/WebhookDelivery');
    const ds: any = await getDb();
    const repo = ds?.getRepository?.(WebhookDelivery);
    if (repo && typeof repo.delete === 'function') await repo.delete({ provider, deliveryId });
  } catch {}
}

/** Test hook. */
export function resetWebhookDedupeForTests(): void {
  memSeen.clear();
}
