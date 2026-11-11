/**
 * Versioned schema migrations (issue #17).
 *
 * The API never auto-syncs its schema. Each release ships TypeORM migrations
 * under src/migrations; `node dist/migrate.js` (the platform-api-migrate Job,
 * run by platformctl before the API Deployment rolls) applies the pending ones
 * exactly once while holding a Postgres advisory lock, so two Jobs — or a Job
 * and a developer running `npm run migration:run` — never migrate concurrently.
 */
import type { DataSource } from 'typeorm';

/** Arbitrary, fixed 64-bit key shared by every migrator of this database. */
export const MIGRATION_LOCK_KEY = '7310431784025917017';

export interface LockOptions {
  /** Give up after this long (ms). Default MIGRATION_LOCK_TIMEOUT_MS or 10 min. */
  timeoutMs?: number;
  /** Delay between pg_try_advisory_lock attempts (ms). */
  pollMs?: number;
  log?: (msg: string) => void;
}

function defaultTimeout(): number {
  const raw = parseInt(process.env.MIGRATION_LOCK_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding the session-level migration advisory lock. The lock
 * lives on a dedicated connection, so it is held for the whole of `fn` even
 * though TypeORM runs each migration on its own query runner, and Postgres
 * releases it automatically if the process dies.
 */
export async function withMigrationLock<T>(ds: DataSource, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeout();
  const pollMs = opts.pollMs ?? 2000;
  const log = opts.log ?? (() => undefined);
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    let waited = false;
    for (;;) {
      const rows = await runner.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [MIGRATION_LOCK_KEY]);
      if (rows?.[0]?.locked === true) break;
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for the migration lock (another migration is running)`);
      }
      if (!waited) {
        log('another migration holds the lock; waiting');
        waited = true;
      }
      await sleep(pollMs);
    }
    try {
      return await fn();
    } finally {
      await runner.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await runner.release();
  }
}

/** Apply every pending migration (each in its own transaction) under the lock. */
export async function runPendingMigrations(ds: DataSource, opts: LockOptions = {}): Promise<string[]> {
  return withMigrationLock(ds, async () => {
    const applied = await ds.runMigrations({ transaction: 'each' });
    return applied.map((m) => m.name);
  }, opts);
}

/**
 * DDL TypeORM would still need to make the database match the entities. Empty
 * means the migrations fully describe the schema (what `migration:check` gates
 * in CI); after an adoption of a pre-migrations install it surfaces drift.
 */
export async function pendingSchemaChanges(ds: DataSource): Promise<string[]> {
  const sql = await ds.driver.createSchemaBuilder().log();
  return sql.upQueries.map((q) => q.query);
}

/**
 * Statements that only ADD something (a table, column, index, enum type or
 * constraint). This is the drift a rollback leaves behind: an older API that
 * synchronizes its schema on boot (v1.2.0) drops the columns, indexes and
 * constraints it does not know, while the `migrations` table still lists the
 * migrations that created them as applied.
 */
const ADDITIVE_DRIFT = [
  /^CREATE TABLE\b/i,
  /^CREATE (UNIQUE )?INDEX\b/i,
  /^CREATE TYPE\b/i,
  /^ALTER TABLE ("[^"]+"\.)?"[^"]+" ADD\b/i,
];

export interface DriftReport {
  /** Missing objects: repairable by re-running the idempotent migrations. */
  additive: string[];
  /** Anything else (type/default/nullability changes, drops): never applied automatically. */
  other: string[];
}

export function classifyDrift(queries: string[]): DriftReport {
  const out: DriftReport = { additive: [], other: [] };
  for (const q of queries) {
    const sql = q.trim().replace(/\s+/g, ' ');
    (ADDITIVE_DRIFT.some((re) => re.test(sql)) ? out.additive : out.other).push(sql);
  }
  return out;
}

function migrationTimestamp(name: string): number {
  const m = /(\d{13})$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * Re-run up() of every migration (oldest first, each in its own transaction)
 * under the migration lock. Every migration in src/migrations is written in an
 * idempotent form (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, guarded
 * constraints and backfills), so this only re-creates what is missing.
 */
export async function rerunMigrations(ds: DataSource, opts: LockOptions = {}): Promise<string[]> {
  return withMigrationLock(ds, async () => {
    const migrations = [...ds.migrations].sort(
      (a, b) => migrationTimestamp(a.name || a.constructor.name) - migrationTimestamp(b.name || b.constructor.name),
    );
    const names: string[] = [];
    for (const m of migrations) {
      const name = m.name || m.constructor.name;
      const runner = ds.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await m.up(runner);
        await runner.commitTransaction();
      } catch (err: any) {
        await runner.rollbackTransaction().catch(() => undefined);
        throw new Error(`re-running ${name} failed: ${err?.message || err}`);
      } finally {
        await runner.release();
      }
      names.push(name);
    }
    return names;
  }, opts);
}
