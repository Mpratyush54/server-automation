import { MemoryStore, Options, Store, ClientRateLimitInfo } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisKey, stateBackend, withRedis } from './redis';

/** After a Redis failure, use the local fallback for this long before trying Redis again. */
const REDIS_RETRY_AFTER_MS = 10_000;

/**
 * express-rate-limit store whose counters live in Redis (`rate-limit-redis`, key prefix
 * `plat:api:rl:<name>:`) so limits are shared by every replica and survive restarts.
 *
 * Degraded mode: if Redis is unreachable the limiter does NOT turn off — it falls back to a
 * per-process MemoryStore (limits become per-replica) and logs a warning, then retries Redis
 * after {@link REDIS_RETRY_AFTER_MS}. Brute-force protection therefore never fails fully open,
 * and password login keeps working during a Redis outage.
 */
export class FallbackRedisStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private redis: RedisStore | null = null;
  private readonly fallback = new MemoryStore();
  private options: Options | null = null;
  private downUntil = 0;

  constructor(name: string) {
    this.prefix = redisKey(`rl:${name}:`);
  }

  init(options: Options): void {
    this.options = options;
    this.fallback.init(options);
  }

  private store(): RedisStore {
    if (!this.redis) {
      const store = new RedisStore({
        prefix: this.prefix,
        sendCommand: (command: string, ...args: string[]) => withRedis((r) => r.call(command, ...args)) as any,
      });
      // The constructor starts SCRIPT LOAD immediately; a failure is retried on use, never unhandled.
      (store as any).incrementScriptSha?.catch?.(() => {});
      (store as any).getScriptSha?.catch?.(() => {});
      if (this.options) store.init(this.options);
      this.redis = store;
    }
    return this.redis;
  }

  private async attempt<T>(op: (s: RedisStore) => Promise<T>, fallback: () => Promise<T> | T): Promise<T> {
    if (Date.now() < this.downUntil) return fallback();
    try {
      return await op(this.store());
    } catch (err: any) {
      if (this.downUntil === 0 || Date.now() >= this.downUntil) {
        console.warn(`[rate-limit] Redis unavailable (${err?.message || err}); using per-replica limits for ${REDIS_RETRY_AFTER_MS / 1000}s`);
      }
      this.downUntil = Date.now() + REDIS_RETRY_AFTER_MS;
      return fallback();
    }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    return this.attempt((s) => s.get(key), () => this.fallback.get(key));
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    return this.attempt((s) => s.increment(key), () => this.fallback.increment(key));
  }

  async decrement(key: string): Promise<void> {
    await this.attempt((s) => s.decrement(key), () => this.fallback.decrement(key));
  }

  async resetKey(key: string): Promise<void> {
    await this.fallback.resetKey(key);
    await this.attempt((s) => s.resetKey(key), () => undefined);
  }

  shutdown(): void {
    this.fallback.shutdown();
  }
}

/**
 * Store for a named limiter: Redis-backed in deployments; `undefined` (express-rate-limit's
 * default MemoryStore) under tests / PLATFORM_STATE_STORE=memory.
 */
export function createLimiterStore(name: string): Store | undefined {
  return stateBackend() === 'redis' ? new FallbackRedisStore(name) : undefined;
}
