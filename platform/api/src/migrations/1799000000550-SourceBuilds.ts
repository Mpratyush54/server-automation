import { MigrationInterface, QueryRunner } from 'typeorm';

export class SourceBuilds1799000000550 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE deployments ALTER COLUMN image_tag TYPE text');
    await q.query(`ALTER TABLE environments ADD COLUMN build_on_push boolean NOT NULL DEFAULT false,
      ADD COLUMN build_branch varchar(200), ADD COLUMN source_image text`);
    await q.query(`CREATE TABLE builds (
      id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
      commit_sha varchar(40) NOT NULL, branch varchar(200) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'queued', image_tag text NOT NULL, image_digest text,
      triggered_by text NOT NULL, started_at timestamp, job_submitted_at timestamp, finished_at timestamp,
      log_location text, logs text NOT NULL DEFAULT '', error text, deployment_id uuid,
      pruned_at timestamp, created_at timestamp NOT NULL DEFAULT now())`);
    await q.query("CREATE UNIQUE INDEX builds_push_commit ON builds(environment_id, commit_sha) WHERE triggered_by = 'push'");
    await q.query('CREATE INDEX builds_project_created ON builds(project_id, created_at DESC)');
    await q.query('CREATE INDEX builds_project_status ON builds(project_id, status)');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE builds');
    await q.query('ALTER TABLE environments DROP COLUMN build_on_push, DROP COLUMN build_branch, DROP COLUMN source_image');
  }
}
