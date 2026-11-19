import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A deleted project no longer holds its name: the table-wide UNIQUE (name) constraint becomes a
 * partial unique index over projects that are not deleted (deleted_at IS NULL). A project that
 * is still being deleted keeps its name until its resources are gone.
 */
export class ProjectNameReuse1799000000610 implements MigrationInterface {
  name = 'ProjectNameReuse1799000000610';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "UQ_2187088ab5ef2a918473cb99007"');
    await q.query('CREATE UNIQUE INDEX IF NOT EXISTS "projects_name_active" ON "projects" ("name") WHERE deleted_at IS NULL');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS "projects_name_active"');
    // A name reused after a delete would break the table-wide constraint: rename the deleted rows.
    await q.query(`UPDATE "projects" p SET "name" = left(p."name", 82) || '-deleted-' || left(p."id"::text, 8)
      WHERE p."deleted_at" IS NOT NULL AND EXISTS (SELECT 1 FROM "projects" o WHERE o."name" = p."name" AND o."id" <> p."id")`);
    await q.query('ALTER TABLE "projects" ADD CONSTRAINT "UQ_2187088ab5ef2a918473cb99007" UNIQUE ("name")');
  }
}
