import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alerting (#43): title of the event that resolved an incident (for example
 * `Synthetic check "api" recovered`), used for resolution notifications instead of the
 * firing title. Null when resolved by hand or when the source sent no distinct title.
 */
export class AlertIncidentResolvedTitle1798000000048 implements MigrationInterface {
  name = 'AlertIncidentResolvedTitle1798000000048';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "resolved_title" character varying(300)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "alert_incidents" DROP COLUMN IF EXISTS "resolved_title"`);
  }
}
