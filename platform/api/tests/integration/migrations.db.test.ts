/**
 * Runs the real migrations against Postgres (issue #17).
 *
 * Needs a Postgres role allowed to CREATE DATABASE; skipped unless
 * MIGRATION_TEST_PG_HOST is set (CI's api-migrations workflow sets it):
 *   MIGRATION_TEST_PG_HOST=127.0.0.1 MIGRATION_TEST_PG_PORT=5432 \
 *   MIGRATION_TEST_PG_USER=postgres MIGRATION_TEST_PG_PASSWORD=postgres \
 *   npx jest tests/integration/migrations.db.test.ts
 */
import { readdirSync } from 'fs';
import path from 'path';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { AppDataSource, MIGRATIONS_TABLE, migrationsGlob } from '../../src/config/database';
import { pendingSchemaChanges, runPendingMigrations, withMigrationLock } from '../../src/lib/migrations';

const host = process.env.MIGRATION_TEST_PG_HOST;
const conn = {
  host,
  port: parseInt(process.env.MIGRATION_TEST_PG_PORT || '5432', 10),
  username: process.env.MIGRATION_TEST_PG_USER || 'postgres',
  password: process.env.MIGRATION_TEST_PG_PASSWORD || 'postgres',
};
const d = host ? describe : describe.skip;
jest.setTimeout(120_000);

const BASELINE = 'InitialSchema1762560000000';
const WAVE1 = 'BackgroundJobsAndOperations1794127020627';
const MFA = 'UserMfa1795000000000';
// Every migration in src/migrations, in timestamp order ("<ts>-<Name>.ts" defines class
// "<Name><ts>"), so a new migration does not have to edit this test.
const ALL = readdirSync(path.join(__dirname, '../../src/migrations'))
  .map((f) => /^(\d+)-(\w+)\.ts$/.exec(f))
  .filter((m): m is RegExpExecArray => m !== null)
  .sort((a, b) => Number(a[1]) - Number(b[1]))
  .map((m) => `${m[2]}${m[1]}`);
const created: string[] = [];
const open: DataSource[] = [];

async function admin<T>(fn: (ds: DataSource) => Promise<T>): Promise<T> {
  const ds = new DataSource({ type: 'postgres', ...conn, database: 'postgres' });
  await ds.initialize();
  try {
    return await fn(ds);
  } finally {
    await ds.destroy();
  }
}

async function freshDb(prefix: string): Promise<string> {
  const name = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin((ds) => ds.query(`CREATE DATABASE "${name}"`));
  created.push(name);
  return name;
}

async function connect(database: string, extra: Partial<{ synchronize: boolean; migrations: any[] }> = {}): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    ...conn,
    database,
    entities: AppDataSource.options.entities,
    migrations: extra.migrations ?? [migrationsGlob()],
    migrationsTableName: MIGRATIONS_TABLE,
    synchronize: extra.synchronize ?? false,
    logging: false,
  });
  await ds.initialize();
  open.push(ds);
  return ds;
}

async function appliedNames(ds: DataSource): Promise<string[]> {
  const rows = await ds.query(`SELECT name FROM "${MIGRATIONS_TABLE}" ORDER BY id`);
  return rows.map((r: { name: string }) => r.name);
}

afterAll(async () => {
  for (const ds of open) if (ds.isInitialized) await ds.destroy().catch(() => undefined);
  if (!host) return;
  await admin(async (ds) => {
    for (const name of created) await ds.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  });
});

d('migrations against Postgres', () => {
  it('fresh install: applies every migration, leaves no drift, and is a no-op the second time', async () => {
    const ds = await connect(await freshDb('mig_fresh'));
    expect(await runPendingMigrations(ds)).toEqual(ALL);
    expect(await appliedNames(ds)).toEqual(ALL);
    // Equivalent of `npm run migration:check`: entities == migrations.
    expect(await pendingSchemaChanges(ds)).toEqual([]);
    expect(await runPendingMigrations(ds)).toEqual([]);
    expect(await ds.showMigrations()).toBe(false);
  });

  it('adopts an install created by synchronize: true without touching data', async () => {
    const db = await freshDb('mig_adopt');
    const legacy = await connect(db, { synchronize: true, migrations: [] });
    await legacy.query(`INSERT INTO "roles" ("name", "permissions") VALUES ('keep-me', '["projects:read"]')`);
    await legacy.destroy();

    const ds = await connect(db);
    expect(await ds.showMigrations()).toBe(true);
    expect(await runPendingMigrations(ds)).toEqual(ALL);
    expect(await appliedNames(ds)).toEqual(ALL);
    const rows = await ds.query(`SELECT name, permissions FROM "roles"`);
    expect(rows).toEqual([{ name: 'keep-me', permissions: ['projects:read'] }]);
    expect(await pendingSchemaChanges(ds)).toEqual([]);
  });

  it('adoption adds objects an older synchronize-era schema is missing', async () => {
    const db = await freshDb('mig_partial');
    const legacy = await connect(db, { synchronize: true, migrations: [] });
    await legacy.query(`DROP TABLE "notifications"`);
    await legacy.query(`ALTER TABLE "roles" DROP COLUMN "description"`);
    await legacy.query(`INSERT INTO "roles" ("name") VALUES ('still-here')`);
    await legacy.destroy();

    const ds = await connect(db);
    expect(await runPendingMigrations(ds)).toEqual(ALL);
    expect(await pendingSchemaChanges(ds)).toEqual([]);
    expect(await ds.query(`SELECT name, description FROM "roles"`)).toEqual([{ name: 'still-here', description: null }]);
  });

  it('upgrade from a baseline-only install adds the wave-1 tables and keeps data', async () => {
    const db = await freshDb('mig_upgrade');
    const { InitialSchema1762560000000 } = await import('../../src/migrations/1762560000000-InitialSchema');
    const old = await connect(db, { migrations: [InitialSchema1762560000000] });
    expect(await runPendingMigrations(old)).toEqual([BASELINE]);
    await old.query(`INSERT INTO "roles" ("name") VALUES ('before-upgrade')`);
    await old.destroy();

    const ds = await connect(db);
    expect(await runPendingMigrations(ds)).toEqual(ALL.slice(1));
    expect(await pendingSchemaChanges(ds)).toEqual([]);
    const tables = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [['background_jobs', 'idempotency_keys', 'operation_steps', 'operations', 'outbox_messages', 'webhook_deliveries']],
    );
    expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual([
      'background_jobs', 'idempotency_keys', 'operation_steps', 'operations', 'outbox_messages', 'webhook_deliveries',
    ]);
    expect(await ds.query(`SELECT name FROM "roles" WHERE name = 'before-upgrade'`)).toHaveLength(1);

    // Later migrations revert cleanly back to MFA...
    while ((await appliedNames(ds)).length > 3) await ds.undoLastMigration({ transaction: 'each' });
    expect(await appliedNames(ds)).toEqual([BASELINE, WAVE1, MFA]);
    expect(await pendingSchemaChanges(ds)).not.toEqual([]);
    // ...then the MFA migration (#24), then the wave-1 one (the baseline stays).
    await ds.undoLastMigration({ transaction: 'each' });
    expect(await appliedNames(ds)).toEqual([BASELINE, WAVE1]);
    expect(await ds.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'user_mfa'`)).toEqual([]);
    expect(await ds.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'integration_settings' AND column_name = 'mfa_required_roles'`,
    )).toEqual([]);
    await ds.undoLastMigration({ transaction: 'each' });
    expect(await appliedNames(ds)).toEqual([BASELINE]);
    expect(await ds.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'operations'`)).toEqual([]);
  });

  it('a failing migration is rolled back and not recorded', async () => {
    class Broken1999999999999 implements MigrationInterface {
      name = 'Broken1999999999999';
      async up(q: QueryRunner) {
        await q.query(`ALTER TABLE "roles" ADD COLUMN "half_done" integer`);
        await q.query(`SELECT * FROM "table_that_does_not_exist"`);
      }
      async down() { /* nothing */ }
    }
    const db = await freshDb('mig_fail');
    const base = await connect(db);
    await runPendingMigrations(base);
    await base.destroy();

    const ds = await connect(db, { migrations: [migrationsGlob(), Broken1999999999999] });
    await expect(runPendingMigrations(ds)).rejects.toThrow();
    expect(await appliedNames(ds)).toEqual(ALL);
    const cols = await ds.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'roles' AND column_name = 'half_done'`);
    expect(cols).toEqual([]);
  });

  it('the advisory lock keeps a second migrator out until the first finishes', async () => {
    const db = await freshDb('mig_lock');
    const a = await connect(db);
    const b = await connect(db);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const first = withMigrationLock(a, async () => { entered(); await held; });
    await inside;
    await expect(withMigrationLock(b, async () => 'never', { timeoutMs: 300, pollMs: 50 })).rejects.toThrow(/timed out/);
    release();
    await first;
    await expect(withMigrationLock(b, async () => 'ok', { timeoutMs: 2000, pollMs: 50 })).resolves.toBe('ok');
  });
});
