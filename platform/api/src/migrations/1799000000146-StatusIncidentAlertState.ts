import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Status pages (#46): remember whether a `firing` status-page alert event was
 * emitted for an incident, so resolving it only emits `resolved` when needed.
 * Additive and idempotent.
 */
export class StatusIncidentAlertState1799000000146 implements MigrationInterface {
  name = 'StatusIncidentAlertState1799000000146';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "status_incidents" ADD COLUMN IF NOT EXISTS "alert_firing" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "status_incidents" DROP COLUMN IF EXISTS "alert_firing"`);
  }
}
