import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnvironmentAutoscaling1799000000056 implements MigrationInterface {
  name = 'EnvironmentAutoscaling1799000000056';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "autoscaling" jsonb`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "environments" DROP COLUMN IF EXISTS "autoscaling"`);
  }
}
