import 'dotenv/config';
import 'reflect-metadata';
import { runRecorded, renderJobMetrics } from '../lib/job-metrics';

/**
 * Entry point helper for `node dist/jobs/<name>.js`, used when a job is run by
 * a Kubernetes CronJob (control-plane scheduled, exactly once per schedule)
 * instead of the in-process leader loop. Exits 0 on success, 1 on failure.
 * Use `concurrencyPolicy: Forbid` on the CronJob so runs never overlap.
 */
export async function runOnce(name: string, fn: () => Promise<unknown>): Promise<void> {
  const err = await runRecorded(name, async () => { await fn(); });
  if (process.env.JOB_PRINT_METRICS === '1') process.stdout.write(renderJobMetrics());
  try {
    const { AppDataSource } = await import('../config/database');
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch {
    // ignore
  }
  process.exit(err ? 1 : 0);
}
