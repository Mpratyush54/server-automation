import { MigrationInterface, QueryRunner } from 'typeorm';

export class SourceBuilds1799000000550 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE deployments ALTER COLUMN image_tag TYPE text');
    // Idempotent: installs adopted from synchronize-era schemas and schema repair re-run migrations.
    await q.query(`ALTER TABLE environments ADD COLUMN IF NOT EXISTS build_on_push boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS build_branch varchar(200), ADD COLUMN IF NOT EXISTS source_image text`);
    await q.query(`CREATE TABLE IF NOT EXISTS builds (
      id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
      commit_sha varchar(40) NOT NULL, branch varchar(200) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'queued', image_tag text NOT NULL, image_digest text,
      triggered_by text NOT NULL, started_at timestamp, job_submitted_at timestamp, finished_at timestamp,
      log_location text, logs text NOT NULL DEFAULT '', error text, deployment_id uuid,
      pruned_at timestamp, created_at timestamp NOT NULL DEFAULT now())`);
    // 570 later narrows builds_push_commit; on a re-run keep whichever version exists.
    await q.query("CREATE UNIQUE INDEX IF NOT EXISTS builds_push_commit ON builds(environment_id, commit_sha) WHERE triggered_by = 'push'");
    await q.query('CREATE INDEX IF NOT EXISTS builds_project_created ON builds(project_id, created_at DESC)');
    await q.query('CREATE INDEX IF NOT EXISTS builds_project_status ON builds(project_id, status)');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS builds');
    await q.query('ALTER TABLE environments DROP COLUMN IF EXISTS build_on_push, DROP COLUMN IF EXISTS build_branch, DROP COLUMN IF EXISTS source_image');
    // Digest-pinned source images can exceed the previous width; they are cut, not rejected.
    await q.query('ALTER TABLE deployments ALTER COLUMN image_tag TYPE varchar(200) USING left(image_tag, 200)');
  }
}
