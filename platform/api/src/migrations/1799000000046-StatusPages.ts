import { MigrationInterface, QueryRunner } from 'typeorm';
import { idempotentStatements } from '../lib/baseline-sql';

/**
 * Public status pages (#46): `status_pages` (per-project published page) and
 * `status_incidents` (operator-authored incident / maintenance timeline).
 * Additive and idempotent. No foreign keys (matches other Phase 4 tables).
 */
export class StatusPages1799000000046 implements MigrationInterface {
  name = 'StatusPages1799000000046';

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
  `CREATE TABLE "status_pages" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "slug" character varying(63) NOT NULL,
          "title" character varying(120) NOT NULL,
          "domain" character varying(255),
          "published" boolean NOT NULL DEFAULT false,
          "branding" jsonb NOT NULL DEFAULT '{}',
          "component_ids" jsonb,
          "created_by_id" uuid,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_status_pages" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "status_pages_project" ON "status_pages" ("project_id")`,
  `CREATE UNIQUE INDEX "status_pages_slug" ON "status_pages" ("slug")`,
  `CREATE TABLE "status_incidents" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "status_page_id" uuid NOT NULL,
          "project_id" uuid NOT NULL,
          "title" character varying(200) NOT NULL,
          "status" character varying(20) NOT NULL DEFAULT 'investigating',
          "impact" character varying(20) NOT NULL DEFAULT 'minor',
          "is_maintenance" boolean NOT NULL DEFAULT false,
          "updates" jsonb NOT NULL DEFAULT '[]',
          "scheduled_start" TIMESTAMP,
          "scheduled_end" TIMESTAMP,
          "resolved_at" TIMESTAMP,
          "created_by_id" uuid,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_status_incidents" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "status_incidents_page" ON "status_incidents" ("status_page_id", "created_at")`,
  `CREATE INDEX "status_incidents_project" ON "status_incidents" ("project_id")`,
];

const DOWN: string[] = [
  `DROP INDEX IF EXISTS "public"."status_incidents_project"`,
  `DROP INDEX IF EXISTS "public"."status_incidents_page"`,
  `DROP TABLE IF EXISTS "status_incidents"`,
  `DROP INDEX IF EXISTS "public"."status_pages_slug"`,
  `DROP INDEX IF EXISTS "public"."status_pages_project"`,
  `DROP TABLE IF EXISTS "status_pages"`,
];
