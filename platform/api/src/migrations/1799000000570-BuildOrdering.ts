import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Order source builds by when their commit was confirmed as the branch head, and deduplicate
 * push builds only while they are queued or running, so a finished commit can be pushed again.
 */
export class BuildOrdering1799000000570 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE builds ADD COLUMN IF NOT EXISTS head_checked_at timestamp');
    await q.query('DROP INDEX IF EXISTS builds_push_commit');
    await q.query(`CREATE UNIQUE INDEX builds_push_commit ON builds(environment_id, commit_sha)
      WHERE triggered_by = 'push' AND status IN ('queued', 'building')`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS builds_push_commit');
    // The earlier index allowed one push build per commit in any state: older repeats keep their
    // history under another trigger name.
    await q.query(`UPDATE builds b SET triggered_by = 'push-repeat' FROM builds newer
      WHERE b.triggered_by = 'push' AND newer.triggered_by = 'push' AND b.environment_id = newer.environment_id
        AND b.commit_sha = newer.commit_sha AND (b.created_at, b.id) < (newer.created_at, newer.id)`);
    await q.query("CREATE UNIQUE INDEX builds_push_commit ON builds(environment_id, commit_sha) WHERE triggered_by = 'push'");
    await q.query('ALTER TABLE builds DROP COLUMN IF EXISTS head_checked_at');
  }
}
