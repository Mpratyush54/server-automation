import { MigrationInterface, QueryRunner } from 'typeorm';
import { idempotentStatements } from '../lib/baseline-sql';

/**
 * Alerting and on-call (#43):
 *  - alert_channels             Slack / PagerDuty / Teams / Discord / webhook / e-mail, secrets encrypted
 *  - alert_monitors             metric / log / trace / resource threshold rules
 *  - alert_slos                 SLOs (burn-rate alerts are generated from them)
 *  - alert_silences             silences and maintenance windows
 *  - alert_escalation_policies  notify A, after N minutes notify B
 *  - alert_oncall_schedules     simple rotations with overrides
 *  - alert_incidents            firing / acknowledged / resolved, one open per (project, dedupeKey)
 *  - alert_deliveries           notification outbox (retried by the leader)
 *
 * Existing rows of the legacy `alerts` table are copied to alert_monitors (legacy_alert_id
 * links them; the copy is skipped for rows already migrated). The `alerts` table is kept so
 * the previous API version keeps working. Additive and idempotent.
 */
export class Alerting1798000000043 implements MigrationInterface {
  name = 'Alerting1798000000043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of idempotentStatements(UP)) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(MIGRATE_LEGACY_ALERTS);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of DOWN) {
      await queryRunner.query(sql);
    }
  }
}

const UP: string[] = [
  `CREATE TABLE "alert_channels" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "name" character varying(100) NOT NULL,
          "type" character varying(20) NOT NULL,
          "config" jsonb NOT NULL DEFAULT '{}',
          "secret_enc" text,
          "min_severity" character varying(20) NOT NULL DEFAULT 'info',
          "allow_private_network" boolean NOT NULL DEFAULT false,
          "enabled" boolean NOT NULL DEFAULT true,
          "last_delivery_at" TIMESTAMP,
          "last_error" text,
          "created_by" uuid,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_da89e9de0358309fb2ec1617e65" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "alert_channels_project" ON "alert_channels" ("project_id")`,
  `CREATE TABLE "alert_monitors" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "name" character varying(150) NOT NULL,
          "kind" character varying(20) NOT NULL,
          "query" text,
          "params" jsonb NOT NULL DEFAULT '{}',
          "operator" character varying(4) NOT NULL DEFAULT '>',
          "threshold" double precision NOT NULL DEFAULT '0',
          "for_seconds" integer NOT NULL DEFAULT '300',
          "severity" character varying(20) NOT NULL DEFAULT 'warning',
          "policy_id" uuid,
          "labels" jsonb NOT NULL DEFAULT '{}',
          "description" text,
          "enabled" boolean NOT NULL DEFAULT true,
          "legacy_alert_id" uuid,
          "state" character varying(20) NOT NULL DEFAULT 'ok',
          "pending_since" TIMESTAMP,
          "last_value" double precision,
          "last_evaluated_at" TIMESTAMP,
          "last_error" text,
          "created_by" uuid,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_06dcff52af731ac4386c0d21800" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "alert_monitors_project" ON "alert_monitors" ("project_id")`,
  `CREATE UNIQUE INDEX "alert_monitors_legacy" ON "alert_monitors" ("legacy_alert_id") WHERE legacy_alert_id IS NOT NULL`,
  `CREATE TABLE "alert_slos" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "name" character varying(150) NOT NULL,
          "sli_type" character varying(20) NOT NULL,
          "error_query" text,
          "total_query" text,
          "params" jsonb NOT NULL DEFAULT '{}',
          "target" double precision NOT NULL,
          "window_days" integer NOT NULL DEFAULT '30',
          "policy_id" uuid,
          "enabled" boolean NOT NULL DEFAULT true,
          "status" jsonb,
          "alert_state" jsonb NOT NULL DEFAULT '{}',
          "created_by" uuid,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_88afd5dce17a27912224e1fd092" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "alert_slos_project" ON "alert_slos" ("project_id")`,
  `CREATE TABLE "alert_silences" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "kind" character varying(20) NOT NULL DEFAULT 'silence',
          "matchers" jsonb NOT NULL DEFAULT '[]',
          "starts_at" TIMESTAMP NOT NULL,
          "ends_at" TIMESTAMP NOT NULL,
          "comment" text,
          "created_by" uuid,
          "alertmanager_id" character varying(100),
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_0b3de53f7cdfac26d37720de79f" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "alert_silences_project" ON "alert_silences" ("project_id")`,
  `CREATE TABLE "alert_escalation_policies" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "name" character varying(100) NOT NULL,
          "is_default" boolean NOT NULL DEFAULT false,
          "steps" jsonb NOT NULL DEFAULT '[]',
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_b7b7e6f82abe208c7bca8e75150" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "alert_policies_project" ON "alert_escalation_policies" ("project_id")`,
  `CREATE TABLE "alert_oncall_schedules" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "name" character varying(100) NOT NULL,
          "user_ids" jsonb NOT NULL DEFAULT '[]',
          "rotation_hours" integer NOT NULL DEFAULT '168',
          "starts_at" TIMESTAMP NOT NULL,
          "overrides" jsonb NOT NULL DEFAULT '[]',
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_f792e83d62a48f70471b1d6028a" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "alert_schedules_project" ON "alert_oncall_schedules" ("project_id")`,
  `CREATE TABLE "alert_incidents" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "project_id" uuid NOT NULL,
          "dedupe_key" character varying(300) NOT NULL,
          "source" character varying(30) NOT NULL,
          "severity" character varying(20) NOT NULL,
          "status" character varying(20) NOT NULL DEFAULT 'firing',
          "title" character varying(300) NOT NULL,
          "body" text,
          "url" character varying(500),
          "environment" character varying(50),
          "labels" jsonb NOT NULL DEFAULT '{}',
          "policy_id" uuid,
          "silenced_by" uuid,
          "escalation_step" integer NOT NULL DEFAULT '0',
          "next_escalation_at" TIMESTAMP,
          "notified_at" TIMESTAMP,
          "event_count" integer NOT NULL DEFAULT '1',
          "first_seen_at" TIMESTAMP NOT NULL,
          "last_seen_at" TIMESTAMP NOT NULL,
          "acknowledged_at" TIMESTAMP,
          "acknowledged_by" uuid,
          "resolved_at" TIMESTAMP,
          "resolved_by" uuid,
          "timeline" jsonb NOT NULL DEFAULT '[]',
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_42d57ff33601326cfdcf0cba9b1" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "alert_incidents_project" ON "alert_incidents" ("project_id")`,
  `CREATE INDEX "alert_incidents_status" ON "alert_incidents" ("status")`,
  `CREATE UNIQUE INDEX "alert_incidents_open_key" ON "alert_incidents" ("project_id", "dedupe_key") WHERE status <> 'resolved'`,
  `CREATE TABLE "alert_deliveries" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "incident_id" uuid NOT NULL,
          "project_id" uuid NOT NULL,
          "channel_id" uuid,
          "user_id" uuid,
          "event" character varying(20) NOT NULL,
          "status" character varying(20) NOT NULL DEFAULT 'pending',
          "attempts" integer NOT NULL DEFAULT '0',
          "next_attempt_at" TIMESTAMP NOT NULL,
          "last_error" text,
          "sent_at" TIMESTAMP,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_b3d51c95891264fb62df41582ad" PRIMARY KEY ("id")
      )`,
  `CREATE INDEX "alert_deliveries_status" ON "alert_deliveries" ("status")`,
  `CREATE INDEX "alert_deliveries_incident" ON "alert_deliveries" ("incident_id")`,
];

/**
 * Legacy rule -> monitor. Legacy metrics: cpu / memory (percent of the project namespaces'
 * limits) and latency (p95 ms) / errorRate (percent) from span metrics. Unknown metrics are
 * copied disabled so nothing silently starts paging.
 */
export const MIGRATE_LEGACY_ALERTS = `
INSERT INTO "alert_monitors" ("project_id", "name", "kind", "params", "operator", "threshold", "for_seconds", "severity", "enabled", "legacy_alert_id", "description")
SELECT a."project_id",
       left('Legacy: ' || a.m, 150),
       CASE WHEN a.m IN ('latency', 'errorRate', 'error_rate') THEN 'trace' ELSE 'resource' END,
       CASE
         WHEN a.m IN ('cpu', 'cpu_high') THEN '{"resource":"cpu"}'::jsonb
         WHEN a.m IN ('memory', 'memory_high') THEN '{"resource":"memory"}'::jsonb
         WHEN a.m = 'latency' THEN '{"signal":"latency_p95"}'::jsonb
         WHEN a.m IN ('errorRate', 'error_rate') THEN '{"signal":"error_rate"}'::jsonb
         ELSE jsonb_build_object('resource', a.m)
       END,
       CASE WHEN a."config"->>'operator' IN ('>', '<', '>=', '<=', '==', '!=') THEN a."config"->>'operator' ELSE '>' END,
       CASE WHEN a."config"->>'threshold' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (a."config"->>'threshold')::double precision ELSE 0 END,
       300,
       CASE WHEN a."severity" IN ('info', 'warning', 'critical') THEN a."severity" ELSE 'warning' END,
       a."is_enabled" AND a.m IN ('cpu', 'cpu_high', 'memory', 'memory_high', 'latency', 'errorRate', 'error_rate'),
       a."id",
       'Migrated from the legacy alerts table (#43).'
FROM (SELECT *, coalesce(nullif("config"->>'metric', ''), "type") AS m FROM "alerts") a
WHERE NOT EXISTS (SELECT 1 FROM "alert_monitors" x WHERE x."legacy_alert_id" = a."id")`;

const DOWN: string[] = [
  `DROP TABLE IF EXISTS "alert_deliveries"`,
  `DROP TABLE IF EXISTS "alert_incidents"`,
  `DROP TABLE IF EXISTS "alert_oncall_schedules"`,
  `DROP TABLE IF EXISTS "alert_escalation_policies"`,
  `DROP TABLE IF EXISTS "alert_silences"`,
  `DROP TABLE IF EXISTS "alert_slos"`,
  `DROP TABLE IF EXISTS "alert_monitors"`,
  `DROP TABLE IF EXISTS "alert_channels"`,
];
