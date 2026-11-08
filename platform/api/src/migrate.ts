/**
 * platform-api-migrate entrypoint (issue #17): `node dist/migrate.js`.
 *
 * Runs in the same image as the API, as a short-lived Kubernetes Job that
 * platformctl starts after the pre-upgrade database backup and before the API
 * Deployment rolls. Applies pending migrations under a Postgres advisory lock
 * and exits non-zero on any failure, which stops the rollout and leaves the
 * previous API ReplicaSet serving.
 */
import 'dotenv/config';
import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import { getDb } from './config/database';
import { pendingSchemaChanges, runPendingMigrations } from './lib/migrations';

export async function migrate(ds: DataSource, log: (msg: string) => void = console.log): Promise<string[]> {
  const applied = await runPendingMigrations(ds, { log: (m) => log(`[migrate] ${m}`) });
  if (applied.length === 0) {
    log('[migrate] schema is up to date; no pending migrations');
  } else {
    for (const name of applied) log(`[migrate] applied ${name}`);
  }
  // Report (never apply) any remaining difference between the entities and the
  // database, e.g. columns an old synchronize-based install created differently.
  try {
    const drift = await pendingSchemaChanges(ds);
    if (drift.length > 0) {
      log(`[migrate] WARNING: ${drift.length} schema difference(s) between entities and database remain:`);
      for (const q of drift) log(`[migrate]   ${q}`);
    }
  } catch (err: any) {
    log(`[migrate] drift check skipped: ${err?.message || err}`);
  }
  return applied;
}

async function main() {
  let ds: DataSource | undefined;
  try {
    ds = await getDb();
    console.log(`[migrate] connected to ${ds.options.database}`);
    await migrate(ds);
    await ds.destroy();
    process.exit(0);
  } catch (err: any) {
    console.error(`[migrate] FAILED: ${err?.message || err}`);
    if (ds?.isInitialized) await ds.destroy().catch(() => undefined);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
