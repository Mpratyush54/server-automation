import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { pingRedis } from '../lib/redis';
import { isShuttingDown } from '../lib/shutdown';
import { withTimeout } from '../lib/with-timeout';

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
 * GET /api/health/ready — readiness: 200 only when PostgreSQL and Redis answer and the process
 * is not draining. Liveness stays on GET /api/health (process up, no dependency checks), so a
 * database or Redis outage takes replicas out of rotation instead of restarting them.
 */
router.get('/health/ready', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (isShuttingDown()) {
    return res.status(503).json({ status: 'draining' });
  }
  const [db, redisRaw] = await Promise.all([checkDb(), pingRedis()]);
  // Public endpoint: report a status word, never driver error text (hosts, users).
  const redis = redisRaw === 'ok' || redisRaw === 'skipped' ? redisRaw : 'unavailable';
  if (redis === 'unavailable') console.warn(`[health] redis not ready: ${redisRaw}`);
  const ok = db === 'ok' && redis !== 'unavailable';
  return res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks: { db, redis } });
});

export default router;
