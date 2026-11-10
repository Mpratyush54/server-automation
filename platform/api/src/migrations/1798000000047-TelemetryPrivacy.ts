import { MigrationInterface, QueryRunner } from 'typeorm';
import { idempotentStatements } from '../lib/baseline-sql';

/**
 * Telemetry privacy (#47): per-project scrubbing rules, retention, consent defaults,
 * and durable subject consent records for session-replay hooks (#40).
 */
export class TelemetryPrivacy1798000000047 implements MigrationInterface {
  name = 'TelemetryPrivacy1798000000047';

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
  `CREATE TABLE "telemetry_privacy_settings" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "scrub_rules" jsonb NOT NULL DEFAULT '[]',
          "scrub_ips" boolean NOT NULL DEFAULT true,
          "retention_days" jsonb NOT NULL DEFAULT '{}',
          "consent_defaults" jsonb NOT NULL DEFAULT '{"replay": false, "analytics": true}',
          "updated_by_id" uuid,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_telemetry_privacy_settings" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "IDX_b9ae9066d61f92f6b60d494d16" ON "telemetry_privacy_settings" ("project_id")`,
  `CREATE TABLE "telemetry_consents" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "subject_id" varchar(128) NOT NULL,
          "session_id" varchar(128) NOT NULL DEFAULT '',
          "replay_allowed" boolean NOT NULL DEFAULT false,
          "analytics_allowed" boolean NOT NULL DEFAULT true,
          "source" varchar(32) NOT NULL DEFAULT 'sdk',
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_telemetry_consents" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "IDX_ed28418fdc33d22464f73b33a2" ON "telemetry_consents" ("project_id", "subject_id", "session_id")`,
];

const DOWN: string[] = [
  `DROP INDEX IF EXISTS "public"."IDX_ed28418fdc33d22464f73b33a2"`,
  `DROP TABLE IF EXISTS "telemetry_consents"`,
  `DROP INDEX IF EXISTS "public"."IDX_b9ae9066d61f92f6b60d494d16"`,
  `DROP TABLE IF EXISTS "telemetry_privacy_settings"`,
];
