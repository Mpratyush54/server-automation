import { MigrationInterface, QueryRunner } from 'typeorm';

/** Alerting retention (#43): the hourly prune scans deliveries by age and incidents by resolve time. */
export class AlertingRetentionIndexes1798000000049 implements MigrationInterface {
  name = 'AlertingRetentionIndexes1798000000049';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX IF NOT EXISTS "alert_incidents_resolved_at" ON "alert_incidents" ("resolved_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "alert_deliveries_created" ON "alert_deliveries" ("created_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "alert_deliveries_created"`);
    await q.query(`DROP INDEX IF EXISTS "alert_incidents_resolved_at"`);
  }
}
