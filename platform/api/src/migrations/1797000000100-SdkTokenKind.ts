import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SDK token kinds:
 *  - sdk_credentials.kind   `server` (backend SDKs) or `browser` (frontend SDKs, ingest-only)
 *
 * Every existing token becomes `server`, so backend SDKs keep working unchanged. Additive and
 * idempotent (an install created by `synchronize: true` already has the column).
 */
export class SdkTokenKind1797000000100 implements MigrationInterface {
  name = 'SdkTokenKind1797000000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sdk_credentials" ADD COLUMN IF NOT EXISTS "kind" character varying(20) NOT NULL DEFAULT 'server'`);
    await queryRunner.query(`UPDATE "sdk_credentials" SET "kind" = 'server' WHERE "kind" IS NULL OR "kind" = ''`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sdk_credentials" DROP COLUMN IF EXISTS "kind"`);
  }
}
