import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { pingRedis } from '../lib/redis';
import { isShuttingDown } from '../lib/shutdown';
import { withTimeout } from '../lib/with-timeout';
import { classifyDrift, pendingSchemaChanges } from '../lib/migrations';

const router = Router();
const CHECK_TIMEOUT_MS = 2000;

async function checkDb(): Promise<string> {
  const result = await withTimeout(
    (async () => {
      const ds = await getDb();
      await ds.query('SELECT 1');
      return 'ok';
    })().catch((err: any) => {
      console.warn(`[health] database not ready: ${err?.message || err}`);
      return 'unavailable';
    }),
    CHECK_TIMEOUT_MS,
    'timed out',
  );
  return result;
}

/**
 * GET /api/health/ready — readiness: 200 when PostgreSQL answers and the process is not
 * draining. Redis is reported in `checks.redis` but does NOT gate readiness: a Redis outage
 * would otherwise take every replica out of the Service at once. Without Redis the
 * Redis-backed flows degrade individually instead — login state, exchange codes and OIDC
 * codes answer 503, rate limits fall back to per-replica memory, the permission cache reads
 * through to the database. Liveness stays on GET /api/health (process up, no dependency
 * checks), so a database outage takes replicas out of rotation instead of restarting them.
 */
router.get('/health/ready', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (isShuttingDown()) {
    return res.status(503).json({ status: 'draining' });
  }
  const [db, redisRaw] = await Promise.all([checkDb(), pingRedis()]);
  // Public endpoint: report a status word, never driver error text (hosts, users).
  const redis = redisRaw === 'ok' || redisRaw === 'skipped' ? redisRaw : 'unavailable';
  if (redis === 'unavailable') console.warn(`[health] redis unavailable (readiness unaffected): ${redisRaw}`);
  const ok = db === 'ok';
  return res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks: { db, redis } });
});

const SCHEMA_TTL_MS = 30_000;
const SCHEMA_TIMEOUT_MS = 15_000;
let schemaCache: { at: number; missing: number } | undefined;
let schemaInflight: Promise<{ at: number; missing: number } | undefined> | undefined;

/** Test hook: forget the cached schema result. */
export function resetSchemaCheckForTests(): void {
  schemaCache = undefined;
  schemaInflight = undefined;
}

async function checkSchema(): Promise<{ at: number; missing: number } | undefined> {
  if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache;
  // One comparison at a time per replica, cached: the endpoint is public.
  schemaInflight ??= withTimeout(
    (async () => {
      const ds = await getDb();
      const { additive } = classifyDrift(await pendingSchemaChanges(ds));
      schemaCache = { at: Date.now(), missing: additive.length };
      return schemaCache;
    })(),
    SCHEMA_TIMEOUT_MS,
    undefined,
  ).finally(() => {
    schemaInflight = undefined;
  });
  return schemaInflight;
}

/**
 * GET /api/health/schema — 200 when every table, column, index and constraint the
 * entities need exists; 503 `drift` when objects are missing (e.g. an older API that
 * synchronized its schema on boot dropped them after a rollback). Used by the
 * `platformctl upgrade` health gate; NOT a Kubernetes probe. Reports a count only.
 */
router.get('/health/schema', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const result = await checkSchema().catch(() => undefined);
  if (!result) return res.status(503).json({ status: 'unavailable' });
  const ok = result.missing === 0;
  if (!ok) console.warn(`[health] schema drift: ${result.missing} missing object(s); run the platform-api migrations`);
  return res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'drift', missing: result.missing });
});

export default router;
