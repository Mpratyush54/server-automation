import { MigrationInterface, QueryRunner } from 'typeorm';
import { idempotentStatements } from '../lib/baseline-sql';

/**
 * TOTP MFA (#24):
 *  - user_mfa                                    encrypted TOTP secret, enabled_at, last_used_step
 *  - mfa_recovery_codes                          bcrypt-hashed single-use recovery codes
 *  - integration_settings.mfa_required_roles     setting `mfa.requiredRoles` (null = [admin, devops])
 *
 * Written to match what `npm run migration:generate` produces for the entities
 * (constraint names come from TypeORM's DefaultNamingStrategy). Additive only, so the
 * previous API version keeps working against the migrated schema and the Deployment can be
 * rolled back without a revert. Idempotent, like the earlier migrations.
 */
export class UserMfa1795000000000 implements MigrationInterface {
  name = 'UserMfa1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of idempotentStatements(UP)) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(`ALTER TABLE "integration_settings" ADD COLUMN IF NOT EXISTS "mfa_required_roles" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of DOWN) {
      await queryRunner.query(sql);
    }
  }
}

/** DDL in dependency order (tables, indexes, then foreign keys). */
const UP: string[] = [
  `CREATE TABLE "user_mfa" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "user_id" uuid NOT NULL,
          "secret_encrypted" text NOT NULL,
          "enabled_at" TIMESTAMP,
          "last_used_step" integer NOT NULL DEFAULT '0',
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_7c15aa872d5f1498f2294dd2df8" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "IDX_a3db12d521d7b1f7d17c71e465" ON "user_mfa" ("user_id")`,
  `CREATE TABLE "mfa_recovery_codes" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "user_id" uuid NOT NULL,
          "code_hash" text NOT NULL,
          "used_at" TIMESTAMP,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_0076416b1b84361afc3371ba121" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "IDX_23aa6c5fdecdd98508fd4456ac" ON "mfa_recovery_codes" ("user_id")`,
  `ALTER TABLE "user_mfa" ADD CONSTRAINT "FK_a3db12d521d7b1f7d17c71e465a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
  `ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "FK_23aa6c5fdecdd98508fd4456acf" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
];

const DOWN: string[] = [
  `ALTER TABLE "mfa_recovery_codes" DROP CONSTRAINT IF EXISTS "FK_23aa6c5fdecdd98508fd4456acf"`,
  `ALTER TABLE "user_mfa" DROP CONSTRAINT IF EXISTS "FK_a3db12d521d7b1f7d17c71e465a"`,
  `DROP INDEX IF EXISTS "public"."IDX_23aa6c5fdecdd98508fd4456ac"`,
  `DROP TABLE IF EXISTS "mfa_recovery_codes"`,
  `DROP INDEX IF EXISTS "public"."IDX_a3db12d521d7b1f7d17c71e465"`,
  `DROP TABLE IF EXISTS "user_mfa"`,
  `ALTER TABLE "integration_settings" DROP COLUMN IF EXISTS "mfa_required_roles"`,
];
