import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Synthetic monitoring (#42): `synthetic_checks` (definition + last-run state) and
 * `synthetic_results` (run history, pruned by retention). Additive and idempotent.
 * No foreign keys (entities define none, so `migration:check` stays clean); results are
 * deleted with their check by the API.
 */
export class SyntheticChecks1798000000042 implements MigrationInterface {
  name = 'SyntheticChecks1798000000042';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "synthetic_checks" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "project_id" uuid NOT NULL,
      "environment_id" uuid,
      "name" character varying(100) NOT NULL,
      "type" character varying(20) NOT NULL,
      "enabled" boolean NOT NULL DEFAULT true,
      "interval_seconds" integer NOT NULL DEFAULT 300,
      "timeout_ms" integer NOT NULL DEFAULT 10000,
      "config" jsonb NOT NULL DEFAULT '{}',
      "secrets_encrypted" text,
      "locations" jsonb NOT NULL DEFAULT '[]',
      "alert_policy" jsonb NOT NULL DEFAULT '{}',
      "next_run_at" TIMESTAMP,
      "last_run_at" TIMESTAMP,
      "last_status" character varying(20) NOT NULL DEFAULT 'unknown',
      "last_latency_ms" integer,
      "last_error" text,
      "consecutive_failures" integer NOT NULL DEFAULT 0,
      "alert_state" character varying(20) NOT NULL DEFAULT 'ok',
      "ssl_expires_at" TIMESTAMP,
      "created_by_id" uuid,
      "created_at" TIMESTAMP NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_9da51d54847be68dc09f918896b" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "synthetic_checks_project" ON "synthetic_checks" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "synthetic_checks_due" ON "synthetic_checks" ("enabled", "next_run_at")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "synthetic_results" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "check_id" uuid NOT NULL,
      "project_id" uuid NOT NULL,
      "status" character varying(20) NOT NULL,
      "latency_ms" integer,
      "status_code" integer,
      "error" text,
      "assertions" jsonb,
      "steps" jsonb,
      "ssl_expires_at" TIMESTAMP,
      "screenshot_key" character varying(300),
      "location" character varying(40) NOT NULL DEFAULT 'local',
      "started_at" TIMESTAMP NOT NULL,
      "created_at" TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_841ee512640e3d6da013ea13cd8" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "synthetic_results_check_time" ON "synthetic_results" ("check_id", "started_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "synthetic_results_project_time" ON "synthetic_results" ("project_id", "started_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "synthetic_results"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "synthetic_checks"`);
  }
}
