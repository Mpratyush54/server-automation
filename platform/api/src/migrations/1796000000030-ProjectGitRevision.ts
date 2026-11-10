import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repository default branch and per-project revision override (#30):
 *  - projects.default_branch   discovered default branch (cache)
 *  - projects.git_revision     operator override used for the next deploy/registration
 *
 * Additive and idempotent (an install created by `synchronize: true` already has the columns).
 */
export class ProjectGitRevision1796000000030 implements MigrationInterface {
  name = 'ProjectGitRevision1796000000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "default_branch" character varying(255)`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "git_revision" character varying(255)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "git_revision"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "default_branch"`);
  }
}
