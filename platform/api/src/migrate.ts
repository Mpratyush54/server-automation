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
import { classifyDrift, DriftReport, pendingSchemaChanges, rerunMigrations, runPendingMigrations } from './lib/migrations';

export async function migrate(ds: DataSource, log: (msg: string) => void = console.log): Promise<string[]> {
  const applied = await runPendingMigrations(ds, { log: (m) => log(`[migrate] ${m}`) });
  if (applied.length === 0) {
    log('[migrate] schema is up to date; no pending migrations');
  } else {
    for (const name of applied) log(`[migrate] applied ${name}`);
  }
  await repairSchemaDrift(ds, log);
  return applied;
}

/**
 * Compare the entities with the database after the migrations ran.
 *
 * Missing objects (tables, columns, indexes, constraints, enum types) are
 * repaired by re-running the idempotent migrations: an older API that still
 * synchronized its schema on boot (e.g. v1.2.0 after a rollback) drops newer
 * columns while the migrations table keeps listing them as applied, and the
 * API then fails every query on those tables. If anything is still missing
 * after the repair, this throws, so the Job fails and the upgrade stops
 * instead of reporting success on a broken schema.
 *
 * Other differences (types, defaults, nullability) are reported, never applied.
 */
export async function repairSchemaDrift(ds: DataSource, log: (msg: string) => void = console.log): Promise<void> {
  let drift: DriftReport;
  try {
    drift = classifyDrift(await pendingSchemaChanges(ds));
  } catch (err: any) {
    log(`[migrate] drift check skipped: ${err?.message || err}`);
    return;
  }
  if (drift.additive.length > 0) {
    log(`[migrate] schema drift: ${drift.additive.length} object(s) missing although their migrations are recorded as applied:`);
    for (const q of drift.additive) log(`[migrate]   ${q}`);
    log('[migrate] repairing: re-running the idempotent migrations');
    const rerun = await rerunMigrations(ds, { log: (m) => log(`[migrate] ${m}`) });
    log(`[migrate] re-ran ${rerun.length} migration(s)`);
    drift = classifyDrift(await pendingSchemaChanges(ds));
    if (drift.additive.length > 0) {
      for (const q of drift.additive) log(`[migrate]   still missing: ${q}`);
      throw new Error(`schema repair incomplete: ${drift.additive.length} object(s) still missing after re-running the migrations`);
    }
    log('[migrate] schema repaired: no missing objects remain');
  }
  if (drift.other.length > 0) {
    log(`[migrate] WARNING: ${drift.other.length} non-additive schema difference(s) between entities and database (not applied):`);
    for (const q of drift.other) log(`[migrate]   ${q}`);
  }
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
