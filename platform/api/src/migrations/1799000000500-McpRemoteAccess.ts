import { MigrationInterface, QueryRunner } from 'typeorm';
import { idempotentStatements } from '../lib/baseline-sql';

/**
 * Remote MCP access (#193): AI assistants registered through OAuth dynamic client registration
 * (`oauth_clients`), a person's approval of one assistant (`mcp_grants`), and the hashed access
 * and refresh tokens of each grant (`mcp_tokens`). Commands a connected assistant asks to run
 * record the grant in `agent_command_approvals.requested_by_mcp_grant_id`.
 * Additive and idempotent. No foreign keys (matches the other Phase 4+ tables).
 */
export class McpRemoteAccess1799000000500 implements MigrationInterface {
  name = 'McpRemoteAccess1799000000500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of idempotentStatements(UP)) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(
      `ALTER TABLE "agent_command_approvals" ADD COLUMN IF NOT EXISTS "requested_by_mcp_grant_id" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of DOWN) {
      await queryRunner.query(sql);
    }
  }
}

const UP: string[] = [
  `CREATE TABLE "oauth_clients" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "client_id" character varying(64) NOT NULL,
          "client_name" character varying(100) NOT NULL,
          "redirect_uris" jsonb NOT NULL,
          "grant_types" jsonb NOT NULL,
          "software_id" character varying(200),
          "software_version" character varying(100),
          "registration_ip_hash" character varying(64),
          "approved_at" TIMESTAMP,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_oauth_clients" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "oauth_clients_client_id" ON "oauth_clients" ("client_id")`,
  `CREATE INDEX "oauth_clients_pending" ON "oauth_clients" ("approved_at", "registration_ip_hash")`,
  `CREATE TABLE "mcp_grants" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "client_ref" uuid NOT NULL,
          "user_id" uuid NOT NULL,
          "scopes" jsonb NOT NULL DEFAULT '[]',
          "resource" character varying(500) NOT NULL,
          "last_used_at" TIMESTAMP,
          "revoked_at" TIMESTAMP,
          "revoked_by_user_id" uuid,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_mcp_grants" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "mcp_grants_active_user_client" ON "mcp_grants" ("user_id", "client_ref") WHERE "revoked_at" IS NULL`,
  `CREATE INDEX "mcp_grants_client" ON "mcp_grants" ("client_ref")`,
  `CREATE TABLE "mcp_tokens" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "grant_id" uuid NOT NULL,
          "kind" character varying(16) NOT NULL,
          "token_hash" character varying(64) NOT NULL,
          "expires_at" TIMESTAMP NOT NULL,
          "used_at" TIMESTAMP,
          "revoked_at" TIMESTAMP,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_mcp_tokens" PRIMARY KEY ("id")
      )`,
  `CREATE UNIQUE INDEX "mcp_tokens_hash" ON "mcp_tokens" ("token_hash")`,
  `CREATE INDEX "mcp_tokens_grant" ON "mcp_tokens" ("grant_id")`,
];

const DOWN: string[] = [
  `ALTER TABLE "agent_command_approvals" DROP COLUMN IF EXISTS "requested_by_mcp_grant_id"`,
  `DROP INDEX IF EXISTS "public"."mcp_tokens_grant"`,
  `DROP INDEX IF EXISTS "public"."mcp_tokens_hash"`,
  `DROP TABLE IF EXISTS "mcp_tokens"`,
  `DROP INDEX IF EXISTS "public"."mcp_grants_client"`,
  `DROP INDEX IF EXISTS "public"."mcp_grants_active_user_client"`,
  `DROP TABLE IF EXISTS "mcp_grants"`,
  `DROP INDEX IF EXISTS "public"."oauth_clients_pending"`,
  `DROP INDEX IF EXISTS "public"."oauth_clients_client_id"`,
  `DROP TABLE IF EXISTS "oauth_clients"`,
];
