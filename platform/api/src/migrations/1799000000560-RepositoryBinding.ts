import { MigrationInterface, QueryRunner } from 'typeorm';
import { normalizeGitUrl } from '../lib/git-url';

/**
 * Bind repositories to projects (#55): a normalised repository key, unique across active
 * projects, and an administrator approval that source builds require. When active projects
 * already share a repository, the oldest keeps the link; the others keep their URL but no key
 * (they no longer receive webhooks or builds until their repository is changed).
 */
export class RepositoryBinding1799000000560 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS repository_key text,
      ADD COLUMN IF NOT EXISTS repository_approved_by uuid, ADD COLUMN IF NOT EXISTS repository_approved_at timestamp,
      ADD COLUMN IF NOT EXISTS repository_approved_key text`);
    const rows: { id: string; repository_url: string | null; is_active: boolean }[] =
      await q.query('SELECT id, repository_url, is_active FROM projects ORDER BY created_at ASC, id ASC');
    const taken = new Set<string>();
    for (const row of rows) {
      let key: string | null = normalizeGitUrl(row.repository_url) || null;
      if (key && row.is_active) {
        if (taken.has(key)) key = null;
        else taken.add(key);
      }
      await q.query('UPDATE projects SET repository_key = $1 WHERE id = $2', [key, row.id]);
    }
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS projects_repository_key_active ON projects(repository_key)
      WHERE is_active AND repository_key IS NOT NULL`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS projects_repository_key_active');
    await q.query(`ALTER TABLE projects DROP COLUMN IF EXISTS repository_key, DROP COLUMN IF EXISTS repository_approved_by,
      DROP COLUMN IF EXISTS repository_approved_at, DROP COLUMN IF EXISTS repository_approved_key`);
  }
}
