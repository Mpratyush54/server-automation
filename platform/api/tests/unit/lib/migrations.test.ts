import { idempotentStatement, idempotentStatements, splitTopLevel } from '../../../src/lib/baseline-sql';
import { MIGRATION_LOCK_KEY, runPendingMigrations, withMigrationLock } from '../../../src/lib/migrations';
import { migrationsGlob } from '../../../src/config/database';

function fakeDataSource(lockResults: boolean[]) {
  const calls: string[] = [];
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      expect(params).toEqual([MIGRATION_LOCK_KEY]);
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: lockResults.shift() ?? false }];
      return [{}];
    }),
  };
  const ds = {
    createQueryRunner: jest.fn(() => runner),
    runMigrations: jest.fn().mockResolvedValue([{ name: 'InitialSchema1762560000000' }]),
  };
  return { ds: ds as any, runner, calls };
}

describe('withMigrationLock', () => {
  it('holds the advisory lock around the work and always releases it', async () => {
    const { ds, runner, calls } = fakeDataSource([true]);
    const result = await withMigrationLock(ds, async () => {
      expect(calls).toEqual([expect.stringContaining('pg_try_advisory_lock')]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls[1]).toContain('pg_advisory_unlock');
    expect(runner.release).toHaveBeenCalled();
  });

  it('unlocks and rethrows when the work fails', async () => {
    const { ds, runner, calls } = fakeDataSource([true]);
    await expect(withMigrationLock(ds, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls.some((c) => c.includes('pg_advisory_unlock'))).toBe(true);
    expect(runner.release).toHaveBeenCalled();
  });

  it('waits while another migrator holds the lock', async () => {
    const { ds } = fakeDataSource([false, false, true]);
    const log = jest.fn();
    const fn = jest.fn().mockResolvedValue(1);
    await withMigrationLock(ds, fn, { pollMs: 1, timeoutMs: 5000, log });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('waiting'));
  });

  it('times out without running the work or unlocking a lock it never took', async () => {
    const { ds, runner, calls } = fakeDataSource([]);
    const fn = jest.fn();
    await expect(withMigrationLock(ds, fn, { pollMs: 1, timeoutMs: 10 })).rejects.toThrow(/timed out/);
    expect(fn).not.toHaveBeenCalled();
    expect(calls.some((c) => c.includes('pg_advisory_unlock'))).toBe(false);
    expect(runner.release).toHaveBeenCalled();
  });

  it('runPendingMigrations runs each migration in its own transaction under the lock', async () => {
    const { ds } = fakeDataSource([true]);
    await expect(runPendingMigrations(ds)).resolves.toEqual(['InitialSchema1762560000000']);
    expect(ds.runMigrations).toHaveBeenCalledWith({ transaction: 'each' });
  });
});

describe('migrationsGlob', () => {
  it('uses forward slashes and the running file extension', () => {
    expect(migrationsGlob('C:\\app\\dist\\migrations')).toBe('C:/app/dist/migrations/*.ts');
  });
});

describe('baseline idempotent DDL', () => {
  it('splits only on top-level commas', () => {
    expect(splitTopLevel(`"a" character varying(50) NOT NULL, "b" jsonb DEFAULT '[1,2]', CONSTRAINT "PK_x" PRIMARY KEY ("a", "b")`))
      .toEqual([`"a" character varying(50) NOT NULL`, `"b" jsonb DEFAULT '[1,2]'`, `CONSTRAINT "PK_x" PRIMARY KEY ("a", "b")`]);
  });

  it('creates tables if missing and adds any missing columns, never altering existing ones', () => {
    const out = idempotentStatement(`CREATE TABLE "roles" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "name" character varying(50) NOT NULL,
      CONSTRAINT "UQ_roles_name" UNIQUE ("name"),
      CONSTRAINT "PK_roles" PRIMARY KEY ("id")
    )`);
    expect(out[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "roles" \(/);
    expect(out.slice(1)).toEqual([
      'ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "id" uuid NOT NULL DEFAULT uuid_generate_v4()',
      'ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "name" character varying(50) NOT NULL',
    ]);
  });

  it('guards enum types, indexes and constraints', () => {
    const [type, idx, uidx, fk] = idempotentStatements([
      `CREATE TYPE "public"."users_role_enum" AS ENUM('admin', 'developer')`,
      `CREATE INDEX "IDX_a" ON "audit_logs" ("user_id")`,
      `CREATE UNIQUE INDEX "IDX_b" ON "secrets" ("project_id", "key")`,
      `ALTER TABLE "users" ADD CONSTRAINT "FK_c" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    ]);
    expect(type).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
    expect(idx).toBe('CREATE INDEX IF NOT EXISTS "IDX_a" ON "audit_logs" ("user_id")');
    expect(uidx).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_b" ON "secrets" ("project_id", "key")');
    expect(fk).toContain(`WHERE conname = 'FK_c'`);
    expect(fk).toContain(`EXECUTE 'ALTER TABLE "users" ADD CONSTRAINT "FK_c"`);
  });

  it('rejects statement shapes it cannot make idempotent', () => {
    expect(() => idempotentStatement('ALTER TABLE "users" DROP COLUMN "name"')).toThrow(/unsupported/);
  });

  it('accepts every statement of the generated InitialSchema baseline', () => {
    // Importing the migration and running up() against a recording runner
    // proves the whole baseline is transformable.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { InitialSchema1762560000000 } = require('../../../src/migrations/1762560000000-InitialSchema');
    const sql: string[] = [];
    const runner = { query: async (q: string) => { sql.push(q); } };
    return new InitialSchema1762560000000().up(runner as any).then(() => {
      expect(sql.length).toBeGreaterThan(40);
      expect(sql.filter((q) => /^CREATE TABLE /.test(q) && !/IF NOT EXISTS/.test(q))).toEqual([]);
      expect(sql.filter((q) => /^CREATE (UNIQUE )?INDEX /.test(q) && !/IF NOT EXISTS/.test(q))).toEqual([]);
    });
  });

  it('accepts every statement of the wave-1 migration and makes it idempotent', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BackgroundJobsAndOperations1794127020627 } = require('../../../src/migrations/1794127020627-BackgroundJobsAndOperations');
    const sql: string[] = [];
    const runner = { query: async (q: string) => { sql.push(q); } };
    return new BackgroundJobsAndOperations1794127020627().up(runner as any).then(() => {
      for (const t of ['background_jobs', 'operations', 'operation_steps', 'outbox_messages', 'webhook_deliveries', 'idempotency_keys']) {
        expect(sql.some((q) => q.startsWith(`CREATE TABLE IF NOT EXISTS "${t}"`))).toBe(true);
      }
      expect(sql.filter((q) => /^CREATE TABLE /.test(q) && !/IF NOT EXISTS/.test(q))).toEqual([]);
      expect(sql.filter((q) => /^CREATE (UNIQUE )?INDEX /.test(q) && !/IF NOT EXISTS/.test(q))).toEqual([]);
    });
  });

  it('refuses to revert the baseline unless explicitly allowed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { InitialSchema1762560000000 } = require('../../../src/migrations/1762560000000-InitialSchema');
    const runner = { query: jest.fn() };
    delete process.env.ALLOW_BASELINE_REVERT;
    await expect(new InitialSchema1762560000000().down(runner as any)).rejects.toThrow(/Refusing/);
    expect(runner.query).not.toHaveBeenCalled();
  });
});
