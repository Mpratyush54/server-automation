/**
 * Rollback to an API that synchronized its schema on boot (v1.2.0) drops newer columns
 * while the migrations table still lists them as applied. The migrate Job must repair that
 * (re-run the idempotent migrations) or fail, never succeed with a broken schema.
 */
const mockPending = jest.fn();
const mockRerun = jest.fn();
const mockRun = jest.fn();
jest.mock('../../src/lib/migrations', () => {
  const actual = jest.requireActual('../../src/lib/migrations');
  return {
    ...actual,
    pendingSchemaChanges: (...a: unknown[]) => mockPending(...a),
    rerunMigrations: (...a: unknown[]) => mockRerun(...a),
    runPendingMigrations: (...a: unknown[]) => mockRun(...a),
  };
});

import { classifyDrift } from '../../src/lib/migrations';
import { migrate } from '../../src/migrate';

const ds = {} as any;
const DROPPED = [
  `ALTER TABLE "projects" ADD "status_page_enabled" boolean NOT NULL DEFAULT false`,
  `CREATE INDEX "IDX_abc" ON "projects" ("status_page_slug") `,
  `ALTER TABLE "files" ADD CONSTRAINT "storage_file_provider" FOREIGN KEY ("storage_provider_id") REFERENCES "storage_providers"("id")`,
];

beforeEach(() => {
  mockPending.mockReset();
  mockRerun.mockReset().mockResolvedValue(['A1', 'B2']);
  mockRun.mockReset().mockResolvedValue([]);
});

describe('classifyDrift', () => {
  it('separates missing objects from other differences', () => {
    const r = classifyDrift([
      ...DROPPED,
      `CREATE TABLE "x" ("id" uuid NOT NULL)`,
      `CREATE UNIQUE INDEX "u" ON "x" ("id")`,
      `CREATE TYPE "public"."x_enum" AS ENUM('a')`,
      `ALTER TABLE "x" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()`,
      `ALTER TABLE "x" DROP COLUMN "legacy"`,
      `DROP INDEX "public"."IDX_old"`,
    ]);
    expect(r.additive).toHaveLength(6);
    expect(r.other).toEqual([
      `ALTER TABLE "x" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()`,
      `ALTER TABLE "x" DROP COLUMN "legacy"`,
      `DROP INDEX "public"."IDX_old"`,
    ]);
  });
});

describe('migrate drift repair', () => {
  it('does nothing extra on a clean schema', async () => {
    mockPending.mockResolvedValue([]);
    await migrate(ds, () => undefined);
    expect(mockRerun).not.toHaveBeenCalled();
  });

  it('re-runs the idempotent migrations when objects are missing, then succeeds', async () => {
    mockPending.mockResolvedValueOnce(DROPPED).mockResolvedValueOnce([]);
    const lines: string[] = [];
    await migrate(ds, (m) => lines.push(m));
    expect(mockRerun).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toContain('schema repaired');
  });

  it('fails (non-zero Job) when objects are still missing after the repair', async () => {
    mockPending.mockResolvedValue(DROPPED);
    await expect(migrate(ds, () => undefined)).rejects.toThrow(/schema repair incomplete: 3 object/);
  });

  it('fails when re-running a migration fails', async () => {
    mockPending.mockResolvedValue(DROPPED);
    mockRerun.mockRejectedValue(new Error('re-running X failed: boom'));
    await expect(migrate(ds, () => undefined)).rejects.toThrow(/boom/);
  });

  it('reports but never applies non-additive differences', async () => {
    mockPending.mockResolvedValue([`ALTER TABLE "x" ALTER COLUMN "y" TYPE text`]);
    const lines: string[] = [];
    await migrate(ds, (m) => lines.push(m));
    expect(mockRerun).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('non-additive');
  });
});
