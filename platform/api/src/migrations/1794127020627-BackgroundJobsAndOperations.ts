import { MigrationInterface, QueryRunner } from 'typeorm';
import { idempotentStatements } from '../lib/baseline-sql';

/**
 * Roadmap wave 1 tables, generated with `npm run migration:generate` against a
 * database migrated to InitialSchema:
 *  - background_jobs                         durable jobs (#19)
 *  - operations, operation_steps             step-logged operations (#23)
 *  - outbox_messages                         transactional outbox (#23)
 *  - webhook_deliveries                      webhook de-duplication (#23)
 *  - idempotency_keys                        Idempotency-Key records (#23)
 *
 * Additive only (new tables), so the previous API version keeps working against
 * the migrated schema and the Deployment can be rolled back without a revert.
 * Statements run in their idempotent form (like the baseline), so a database
 * where these tables already exist (e.g. a pre-release build that still used
 * synchronize) is adopted without changes.
 */
export class BackgroundJobsAndOperations1794127020627 implements MigrationInterface {
  name = 'BackgroundJobsAndOperations1794127020627';

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

/** Generated DDL, in dependency order. */
const UP: string[] = [
  `CREATE TABLE "background_jobs" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "type" character varying(64) NOT NULL,
          "target_id" uuid NOT NULL,
          "status" character varying(16) NOT NULL DEFAULT 'queued',
          "step" character varying(64) NOT NULL DEFAULT 'queued',
          "attempts" integer NOT NULL DEFAULT '0',
          "max_attempts" integer NOT NULL DEFAULT '2',
          "payload" jsonb,
          "last_error" text,
          "locked_by" character varying(255),
          "locked_until" TIMESTAMP WITH TIME ZONE,
          "finished_at" TIMESTAMP WITH TIME ZONE,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_c1f31731b1a02806c4aa631acb8" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "IDX_0c0ab3107c4a48d54a7573a9ef" ON "background_jobs" ("target_id")`,
  `CREATE INDEX "idx_background_jobs_status_locked" ON "background_jobs" ("status", "locked_until")`,
  `CREATE TABLE "operation_steps" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "operation_id" uuid NOT NULL,
          "index" integer NOT NULL,
          "name" character varying(64) NOT NULL,
          "status" character varying(32) NOT NULL DEFAULT 'pending',
          "attempts" integer NOT NULL DEFAULT '0',
          "output" jsonb,
          "error" text,
          "started_at" TIMESTAMP,
          "finished_at" TIMESTAMP,
          CONSTRAINT "PK_9be6d936743399e3c3313285a5d" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "IDX_8b6acd0becba00ebd4335dba2c" ON "operation_steps" ("operation_id", "index")`,
  `CREATE TABLE "operations" (
          "id" uuid NOT NULL,
          "type" character varying(64) NOT NULL,
          "project_id" uuid,
          "lock_key" character varying(255),
          "lock_fence" character varying(64),
          "status" character varying(32) NOT NULL DEFAULT 'pending',
          "current_step" integer NOT NULL DEFAULT '0',
          "input_hash" character varying(64) NOT NULL,
          "input" jsonb,
          "state" jsonb,
          "state_encrypted" text,
          "result" jsonb,
          "error" text,
          "attempts" integer NOT NULL DEFAULT '0',
          "created_by_id" uuid,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          "finished_at" TIMESTAMP,
          CONSTRAINT "PK_7b62d84d6f9912b975987165856" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "IDX_35ac7a4391b2f2add7bcec475b" ON "operations" ("type")`,
  `CREATE INDEX "IDX_bac8e0530ab08694ea62a5f48e" ON "operations" ("project_id")`,
  `CREATE INDEX "IDX_2c151f4cf78c655b121cdadf02" ON "operations" ("lock_key")`,
  `CREATE INDEX "IDX_73981aaf12263f53d794b56e4a" ON "operations" ("status", "updated_at")`,
  `CREATE TABLE "outbox_messages" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "operation_id" uuid,
          "kind" character varying(64) NOT NULL,
          "payload" jsonb NOT NULL,
          "status" character varying(16) NOT NULL DEFAULT 'pending',
          "attempts" integer NOT NULL DEFAULT '0',
          "available_at" TIMESTAMP NOT NULL DEFAULT now(),
          "last_error" text,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "sent_at" TIMESTAMP,
          CONSTRAINT "PK_0171348f527c64b137e4d4f5b66" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "IDX_9d6ccb30ab50e29933b28ca9b2" ON "outbox_messages" ("operation_id")`,
  `CREATE INDEX "IDX_48e0e838cde590d0d04f240d83" ON "outbox_messages" ("status", "available_at")`,
  `CREATE TABLE "webhook_deliveries" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "provider" character varying(16) NOT NULL,
          "delivery_id" character varying(128) NOT NULL,
          "event" character varying(64),
          "received_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_535dd409947fb6d8fc6dfc0112a" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "IDX_c18904d7a2c1aebbccab714e82" ON "webhook_deliveries" ("received_at")`,
  `CREATE UNIQUE INDEX "IDX_44c2e7fd858c1ac51689e6a072" ON "webhook_deliveries" ("provider", "delivery_id")`,
  `CREATE TABLE "idempotency_keys" (
          "id" character varying(64) NOT NULL,
          "user_id" character varying(64) NOT NULL,
          "route" character varying(128) NOT NULL,
          "request_hash" character varying(64) NOT NULL,
          "state" character varying(16) NOT NULL,
          "response_status" integer,
          "response_body" text,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "expires_at" TIMESTAMP NOT NULL,
          CONSTRAINT "PK_8ad20779ad0411107a56e53d0f6" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "IDX_e5fc0731b6752a8e9194fa265e" ON "idempotency_keys" ("expires_at")`,
  `ALTER TABLE "operation_steps"
      ADD CONSTRAINT "FK_eab876d2b0dc500f6ae478dcd8b" FOREIGN KEY ("operation_id") REFERENCES "operations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
];

const DOWN: string[] = [
  `ALTER TABLE "operation_steps" DROP CONSTRAINT IF EXISTS "FK_eab876d2b0dc500f6ae478dcd8b"`,
  `DROP INDEX IF EXISTS "public"."IDX_e5fc0731b6752a8e9194fa265e"`,
  `DROP TABLE IF EXISTS "idempotency_keys"`,
  `DROP INDEX IF EXISTS "public"."IDX_44c2e7fd858c1ac51689e6a072"`,
  `DROP INDEX IF EXISTS "public"."IDX_c18904d7a2c1aebbccab714e82"`,
  `DROP TABLE IF EXISTS "webhook_deliveries"`,
  `DROP INDEX IF EXISTS "public"."IDX_48e0e838cde590d0d04f240d83"`,
  `DROP INDEX IF EXISTS "public"."IDX_9d6ccb30ab50e29933b28ca9b2"`,
  `DROP TABLE IF EXISTS "outbox_messages"`,
  `DROP INDEX IF EXISTS "public"."IDX_73981aaf12263f53d794b56e4a"`,
  `DROP INDEX IF EXISTS "public"."IDX_2c151f4cf78c655b121cdadf02"`,
  `DROP INDEX IF EXISTS "public"."IDX_bac8e0530ab08694ea62a5f48e"`,
  `DROP INDEX IF EXISTS "public"."IDX_35ac7a4391b2f2add7bcec475b"`,
  `DROP TABLE IF EXISTS "operations"`,
  `DROP INDEX IF EXISTS "public"."IDX_8b6acd0becba00ebd4335dba2c"`,
  `DROP TABLE IF EXISTS "operation_steps"`,
  `DROP INDEX IF EXISTS "public"."idx_background_jobs_status_locked"`,
  `DROP INDEX IF EXISTS "public"."IDX_0c0ab3107c4a48d54a7573a9ef"`,
  `DROP TABLE IF EXISTS "background_jobs"`,
];
