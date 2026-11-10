import { MigrationInterface, QueryRunner } from 'typeorm';

export class ErrorTracking1798000000041 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS error_issues (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      environment text NOT NULL, fingerprint text NOT NULL, fingerprint_aliases jsonb NOT NULL DEFAULT '[]', title text NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
      assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
      first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
      count bigint NOT NULL DEFAULT 0, release_counts jsonb NOT NULL DEFAULT '{}',
      latest_release text NOT NULL, resolved_release text, regression boolean NOT NULL DEFAULT false)`);
    await q.query(`ALTER TABLE error_issues ADD COLUMN IF NOT EXISTS fingerprint_aliases jsonb NOT NULL DEFAULT '[]'`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS error_issues_group ON error_issues(project_id,environment,fingerprint)`);
    await q.query(`CREATE INDEX IF NOT EXISTS error_issues_recent ON error_issues(project_id, last_seen)`);
    // Hash partitions bound index size and enable project-scoped retention/deletion.
    await q.query(`CREATE TABLE IF NOT EXISTS error_events (
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id uuid NOT NULL,
      issue_id uuid NOT NULL REFERENCES error_issues(id) ON DELETE CASCADE,
      received_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,
      PRIMARY KEY(project_id,id)) PARTITION BY HASH(project_id)`);
    for (let i = 0; i < 8; i++) await q.query(`CREATE TABLE IF NOT EXISTS error_events_p${i}
      PARTITION OF error_events FOR VALUES WITH (MODULUS 8, REMAINDER ${i})`);
    await q.query(`CREATE INDEX IF NOT EXISTS error_events_issue ON error_events(project_id,issue_id,received_at DESC)`);
    await q.query(`CREATE TABLE IF NOT EXISTS error_sourcemaps (
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      release text NOT NULL, file text NOT NULL, object_key text NOT NULL, digest text NOT NULL,
      PRIMARY KEY(project_id,release,file))`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS error_sourcemaps');
    await q.query('DROP TABLE IF EXISTS error_events');
    await q.query('DROP TABLE IF EXISTS error_issues');
  }
}
