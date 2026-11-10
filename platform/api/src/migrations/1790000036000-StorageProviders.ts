import { MigrationInterface, QueryRunner } from 'typeorm';

export class StorageProviders1790000036000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE storage_providers ADD COLUMN health_status varchar(20) NOT NULL DEFAULT 'unknown', ADD COLUMN last_error text, ADD COLUMN checked_at timestamp`);
    await q.query(`ALTER TABLE files ADD COLUMN storage_provider_id uuid CONSTRAINT storage_file_provider REFERENCES storage_providers(id) ON DELETE RESTRICT`);
    // Repair historic duplicate defaults before enforcing the invariant.
    await q.query(`UPDATE storage_providers SET is_default = false WHERE is_default AND id <> (SELECT id FROM storage_providers WHERE is_default ORDER BY created_at, id LIMIT 1)`);
    await q.query(`CREATE UNIQUE INDEX storage_one_default ON storage_providers (is_default) WHERE is_default`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX storage_one_default`);
    await q.query(`ALTER TABLE files DROP COLUMN storage_provider_id`);
    await q.query(`ALTER TABLE storage_providers DROP COLUMN health_status, DROP COLUMN last_error, DROP COLUMN checked_at`);
  }
}
