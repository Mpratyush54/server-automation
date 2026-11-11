import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Error retention (#47): the hourly job deletes a project's error_events by age. The
 * existing index leads with issue_id, so add (project_id, received_at). error_events is not
 * a TypeORM entity (raw SQL, hash-partitioned), so this index is outside the drift check.
 */
export class ErrorEventsRetentionIndex1798000000050 implements MigrationInterface {
  name = 'ErrorEventsRetentionIndex1798000000050';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX IF NOT EXISTS error_events_received ON error_events(project_id, received_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS error_events_received`);
  }
}
