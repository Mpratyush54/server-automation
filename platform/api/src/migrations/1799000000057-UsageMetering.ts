import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-project usage metering (#57): daily rollups, quotas, and unit prices.
 * Additive and idempotent.
 */
export class UsageMetering1799000000057 implements MigrationInterface {
  name = 'UsageMetering1799000000057';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "usage_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "per_core_hour" double precision NOT NULL DEFAULT 0.04,
        "per_gb_hour_memory" double precision NOT NULL DEFAULT 0.005,
        "per_gb_month_storage" double precision NOT NULL DEFAULT 0.02,
        "per_gb_bandwidth" double precision NOT NULL DEFAULT 0.09,
        "per_build_minute" double precision NOT NULL DEFAULT 0.002,
        "monthly_server_cost" double precision NOT NULL DEFAULT 0,
        "currency" character varying(8) NOT NULL DEFAULT 'USD',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_usage_settings" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "usage_quotas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "cpu_core_hours" double precision,
        "memory_gb_hours" double precision,
        "storage_gb" double precision,
        "bandwidth_gb" double precision,
        "build_minutes" double precision,
        "resource_quota" jsonb,
        "alerts_enabled" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_usage_quotas" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_usage_quota_project" UNIQUE ("project_id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_usage_quota_project" ON "usage_quotas" ("project_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "usage_daily_rollups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "environment_id" uuid,
        "environment_name" character varying(50),
        "namespace" character varying(100),
        "day" date NOT NULL,
        "cpu_core_hours" double precision NOT NULL DEFAULT 0,
        "memory_gb_hours" double precision NOT NULL DEFAULT 0,
        "pvc_storage_gb" double precision NOT NULL DEFAULT 0,
        "object_storage_gb" double precision NOT NULL DEFAULT 0,
        "ingress_bandwidth_gb" double precision NOT NULL DEFAULT 0,
        "build_minutes" double precision NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_usage_daily_rollups" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_usage_daily_project_env_day" UNIQUE ("project_id", "environment_id", "day")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_usage_daily_project_day" ON "usage_daily_rollups" ("project_id", "day")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_usage_daily_day" ON "usage_daily_rollups" ("day")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_daily_rollups"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_quotas"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_settings"`);
  }
}
