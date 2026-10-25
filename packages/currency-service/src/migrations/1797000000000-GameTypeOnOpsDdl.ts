import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A2（spec D5/§6.2）：`currency_ops` 玩法维度 **DDL 半边**。
 *
 * - 列追加到表尾（不改既有列序；避免大表按位重建）；
 * - `idx_ops_game_created` 服务管理财务的玩法筛选/汇总；
 * - 历史回填在**独立迁移** `GameTypeOnOpsBackfill1797000000001`（MySQL DDL 隐式提交；
 *   同迁移内做数据步会在中途失败时留下「列已加、迁移未记录」的卡启动状态）。
 *
 * ⚠️ 类名不得匹配 `/^Currency\d+$/`（migration.test 以 readdir 首个匹配取类）。
 */
export class GameTypeOnOpsDdl1797000000000 implements MigrationInterface {
  name = 'GameTypeOnOpsDdl1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `currency_ops` ' +
        'ADD COLUMN `game_type` varchar(16) NULL DEFAULT NULL, ' +
        'ADD KEY `idx_ops_game_created` (`game_type`, `created_at`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `currency_ops` DROP KEY `idx_ops_game_created`, DROP COLUMN `game_type`',
    );
  }
}
