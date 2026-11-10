import { MigrationInterface, QueryRunner } from 'typeorm';
import { idempotentStatements } from '../lib/baseline-sql';

/**
 * Automated Git provider connect (#35):
 *  - git_provider_apps        GitHub App (manifest flow) / GitLab OAuth application, secrets encrypted
 *  - git_app_installations    GitHub App installations and the repositories they grant
 *
 * Written to match what `npm run migration:generate` produces for the entities
 * (constraint names come from TypeORM's DefaultNamingStrategy). Additive only, so the
 * previous API version keeps working against the migrated schema. Idempotent.
 */
export class GitProviderApps1796000000035 implements MigrationInterface {
  name = 'GitProviderApps1796000000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of idempotentStatements(UP)) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of DOWN) {
      await queryRunner.query(sql);
    }
  }
}

const UP: string[] = [
  `CREATE TABLE "git_provider_apps" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "provider" character varying(20) NOT NULL,
          "app_id" character varying(100),
          "slug" character varying(200),
          "owner" character varying(200),
          "owner_type" character varying(30),
          "base_url" character varying(300),
          "html_url" character varying(300),
          "client_id" character varying(200),
          "client_secret_enc" text,
          "webhook_secret_enc" text,
          "private_key_enc" text,
          "api_token_enc" text,
          "created_by" uuid,
          "last_checked_at" TIMESTAMP,
          "last_check_ok" boolean,
          "last_error" text,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_ea5ccdf66dd678447dad209c764" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "IDX_705cae059219151ec78425d480" ON "git_provider_apps" ("provider")`,
  `CREATE TABLE "git_app_installations" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "installation_id" character varying(50) NOT NULL,
          "account_login" character varying(200) NOT NULL,
          "account_type" character varying(30),
          "repository_selection" character varying(20) NOT NULL DEFAULT 'selected',
          "repositories" jsonb NOT NULL DEFAULT '[]',
          "suspended_at" TIMESTAMP,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_b688b98546d8c94d111a8561889" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "IDX_43b1eceec3a06790904b656956" ON "git_app_installations" ("installation_id")`,
];

const DOWN: string[] = [
  `DROP INDEX IF EXISTS "public"."IDX_43b1eceec3a06790904b656956"`,
  `DROP TABLE IF EXISTS "git_app_installations"`,
  `DROP INDEX IF EXISTS "public"."IDX_705cae059219151ec78425d480"`,
  `DROP TABLE IF EXISTS "git_provider_apps"`,
];
