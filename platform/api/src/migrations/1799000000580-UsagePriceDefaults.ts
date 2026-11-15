import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store the usage_settings unit-price defaults (#57) as quoted literals. Postgres reports an
 * unquoted fractional default (0.04) differently from how TypeORM renders the entity default
 * ('0.04'), so the schema drift check flagged these columns. The values are unchanged.
 */
export class UsagePriceDefaults1799000000580 implements MigrationInterface {
  name = 'UsagePriceDefaults1799000000580';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_core_hour" SET DEFAULT '0.04'`);
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_gb_hour_memory" SET DEFAULT '0.005'`);
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_gb_month_storage" SET DEFAULT '0.02'`);
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_gb_bandwidth" SET DEFAULT '0.09'`);
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_build_minute" SET DEFAULT '0.002'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_build_minute" SET DEFAULT 0.002`);
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_gb_bandwidth" SET DEFAULT 0.09`);
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_gb_month_storage" SET DEFAULT 0.02`);
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_gb_hour_memory" SET DEFAULT 0.005`);
    await queryRunner.query(`ALTER TABLE "usage_settings" ALTER COLUMN "per_core_hour" SET DEFAULT 0.04`);
  }
}
