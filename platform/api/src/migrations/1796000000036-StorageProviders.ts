import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Storage providers (#36):
 *  - storage_providers.health_status / last_error / checked_at   leader health check results
 *  - files.storage_provider_id                                   provider that holds each upload
 *  - storage_one_default                                         at most one default provider
 *
 * Additive and idempotent (an install created by `synchronize: true` already has these).
 */
export class StorageProviders1796000000036 implements MigrationInterface {
  name = 'StorageProviders1796000000036';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "storage_providers" ADD COLUMN IF NOT EXISTS "health_status" character varying(20) NOT NULL DEFAULT 'unknown'`);
    await q.query(`ALTER TABLE "storage_providers" ADD COLUMN IF NOT EXISTS "last_error" text`);
    await q.query(`ALTER TABLE "storage_providers" ADD COLUMN IF NOT EXISTS "checked_at" TIMESTAMP`);
    await q.query(`ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "storage_provider_id" uuid`);
    await q.query(
      `DO $m$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_file_provider') THEN ` +
        `ALTER TABLE "files" ADD CONSTRAINT "storage_file_provider" FOREIGN KEY ("storage_provider_id") ` +
        `REFERENCES "storage_providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION; END IF; END $m$`,
    );
    // Repair historic duplicate defaults before enforcing the invariant.
    await q.query(
      `UPDATE "storage_providers" SET "is_default" = false WHERE "is_default" AND "id" <> ` +
        `(SELECT "id" FROM "storage_providers" WHERE "is_default" ORDER BY "created_at", "id" LIMIT 1)`,
    );
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "storage_one_default" ON "storage_providers" ("is_default") WHERE is_default`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "public"."storage_one_default"`);
    await q.query(`ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "storage_file_provider"`);
    await q.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "storage_provider_id"`);
    await q.query(`ALTER TABLE "storage_providers" DROP COLUMN IF EXISTS "checked_at"`);
    await q.query(`ALTER TABLE "storage_providers" DROP COLUMN IF EXISTS "last_error"`);
    await q.query(`ALTER TABLE "storage_providers" DROP COLUMN IF EXISTS "health_status"`);
  }
}
