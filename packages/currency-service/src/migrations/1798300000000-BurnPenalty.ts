import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 2026-10-28：麻将花猪罚分独立销毁列（不混入 rake）。 */
export class BurnPenalty1798300000000 implements MigrationInterface {
  name = 'BurnPenalty1798300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `currency_ops` ADD COLUMN `burned_penalty` int NULL DEFAULT NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `currency_ops` DROP COLUMN `burned_penalty`');
  }
}
