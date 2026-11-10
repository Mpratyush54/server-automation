import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProjectGitRevision1790000030000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE projects ADD COLUMN default_branch varchar(255), ADD COLUMN git_revision varchar(255)');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE projects DROP COLUMN git_revision, DROP COLUMN default_branch');
  }
}
