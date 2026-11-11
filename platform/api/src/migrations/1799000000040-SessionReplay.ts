import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Session replay metadata (#40). Recorded events live in object storage
 * (`replays` bucket, `replays/<projectId>/<sessionId>/<seq>.json.gz`); Postgres
 * keeps one row per session (list/filter) and one per chunk (ordering, retry
 * de-duplication, first full snapshot per page for heatmap backgrounds).
 */
export class SessionReplay1799000000040 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS replay_sessions (
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id text NOT NULL,
      environment text,
      release text,
      app text,
      user_id text,
      subject_id text,
      user_agent text,
      first_page text,
      pages jsonb NOT NULL DEFAULT '[]',
      trace_ids jsonb NOT NULL DEFAULT '[]',
      started_at timestamptz NOT NULL,
      ended_at timestamptz NOT NULL,
      duration_ms bigint NOT NULL DEFAULT 0,
      chunk_count integer NOT NULL DEFAULT 0,
      event_count bigint NOT NULL DEFAULT 0,
      bytes bigint NOT NULL DEFAULT 0,
      error_count integer NOT NULL DEFAULT 0,
      network_error_count integer NOT NULL DEFAULT 0,
      viewport_width integer,
      viewport_height integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, session_id))`);
    await q.query(`CREATE INDEX IF NOT EXISTS replay_sessions_recent ON replay_sessions(project_id, started_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS replay_sessions_ended ON replay_sessions(ended_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS replay_sessions_user ON replay_sessions(project_id, user_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS replay_sessions_subject ON replay_sessions(project_id, subject_id)`);
    await q.query(`CREATE TABLE IF NOT EXISTS replay_chunks (
      project_id uuid NOT NULL,
      session_id text NOT NULL,
      seq integer NOT NULL,
      object_key text NOT NULL,
      bytes integer NOT NULL,
      event_count integer NOT NULL,
      started_at timestamptz NOT NULL,
      ended_at timestamptz NOT NULL,
      snapshot_pages jsonb NOT NULL DEFAULT '[]',
      received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, session_id, seq),
      FOREIGN KEY (project_id, session_id) REFERENCES replay_sessions(project_id, session_id) ON DELETE CASCADE)`);
    await q.query(`CREATE INDEX IF NOT EXISTS replay_chunks_snapshots ON replay_chunks USING gin (snapshot_pages)`);
    // Errors (#41) link to replays through payload.replayId: index the lookup from the player.
    const errors = await q.query(`SELECT to_regclass('error_events') AS t`);
    if (errors?.[0]?.t) {
      await q.query(`CREATE INDEX IF NOT EXISTS error_events_replay ON error_events (project_id, ((payload->>'replayId')))`);
    }
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS error_events_replay');
    await q.query('DROP TABLE IF EXISTS replay_chunks');
    await q.query('DROP TABLE IF EXISTS replay_sessions');
  }
}
