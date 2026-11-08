import type Redis from 'ioredis';
import { REDIS_KEY_PREFIX, getRedis, getRedisSubscriber, stateBackend } from './redis';

/**
 * Cross-replica invalidation for the per-process permission cache (middleware/auth.ts).
 *
 * Every replica subscribes to {@link PERM_INVALIDATE_CHANNEL}; `clearPermissionCache` publishes
 * the user id (or `*` for everyone). Delivery is best-effort, so the cache TTL stays the upper
 * bound on staleness — and while the subscription is down the cache is bypassed entirely
 * (fail open to the database), because invalidations may be missed in that window.
 */
export const PERM_INVALIDATE_CHANNEL = `${REDIS_KEY_PREFIX}perm-invalidate`;
const ALL = '*';

export type InvalidateHandler = (userId: string | undefined) => void;

/** One subscription per process (or per simulated replica in tests). */
export class PermissionInvalidationBus {
  private sub: Redis | null = null;
  private starting: Promise<void> | null = null;
  private ready = false;
  private lastFailure = 0;

  constructor(
    private readonly onInvalidate: InvalidateHandler,
    private readonly getPublisher: () => Promise<Redis> = getRedis,
    private readonly getSubscriber: () => Promise<Redis> = getRedisSubscriber,
  ) {}

  /** True only while the subscription is confirmed live (the local cache may then be trusted). */
  isReady(): boolean {
    return this.ready && !!this.sub;
  }

  /** Idempotent; safe to call on every request. Resolves once subscribed (or failed). */
  start(): Promise<void> {
    if (this.sub || this.starting) return this.starting || Promise.resolve();
    if (Date.now() - this.lastFailure < 5000) return Promise.resolve(); // back off after a failure
    this.starting = (async () => {
      try {
        const sub = await this.getSubscriber();
        sub.on('message', (channel: string, message: string) => {
          if (channel !== PERM_INVALIDATE_CHANNEL) return;
          this.onInvalidate(message === ALL ? undefined : message);
        });
        const lost = () => {
          if (this.ready) console.warn('[perm-cache] invalidation channel lost; bypassing the permission cache until it is back');
          this.ready = false;
          this.onInvalidate(undefined); // anything cached may now miss an invalidation
        };
        sub.on('close', lost);
        sub.on('end', lost);
        sub.on('ready', () => {
          // ioredis re-subscribes on reconnect; drop entries cached across the gap.
          this.onInvalidate(undefined);
          this.ready = true;
        });
        await sub.subscribe(PERM_INVALIDATE_CHANNEL);
        this.sub = sub;
        this.ready = true;
      } catch (err: any) {
        this.lastFailure = Date.now();
        console.warn(`[perm-cache] could not subscribe to invalidations (${err?.message || err}); using the database directly`);
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Publish an invalidation to every replica (including this one). Never throws. */
  async publish(userId?: string): Promise<void> {
    try {
      const pub = await this.getPublisher();
      await pub.publish(PERM_INVALIDATE_CHANNEL, userId || ALL);
    } catch (err: any) {
      console.warn(`[perm-cache] invalidation publish failed (${err?.message || err}); other replicas converge within the cache TTL`);
    }
  }

  async stop(): Promise<void> {
    const sub = this.sub;
    this.sub = null;
    this.ready = false;
    if (sub) await sub.unsubscribe(PERM_INVALIDATE_CHANNEL).catch(() => {});
  }
}

export function permissionPubSubEnabled(): boolean {
  return stateBackend() === 'redis';
}
