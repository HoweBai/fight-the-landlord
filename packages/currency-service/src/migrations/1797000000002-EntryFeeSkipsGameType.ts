import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A2（spec D6/§6.2）：台费免单表补玩法列。
 *
 * - `NOT NULL DEFAULT 'doudizhu'`：旧行自动按斗地主填充（审计表每行必属一局）；
 * - 追加到表尾，不改既有列序；
 * - `idx_skips_game_created` 服务按玩法汇总/筛选。
 */
export class EntryFeeSkipsGameType1797000000002 implements MigrationInterface {
  name = 'EntryFeeSkipsGameType1797000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `currency_entry_fee_skips` ' +
        "ADD COLUMN `game_type` varchar(16) NOT NULL DEFAULT 'doudizhu', " +
        'ADD KEY `idx_skips_game_created` (`game_type`, `created_at`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `currency_entry_fee_skips` DROP KEY `idx_skips_game_created`, DROP COLUMN `game_type`',
    );
  }
}
