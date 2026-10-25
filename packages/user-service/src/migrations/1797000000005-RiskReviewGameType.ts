import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B 组（spec D15/U5）：`risk_reviews` 加玩法维度 `game_type`。
 *
 * - 值域由应用层约束：`doudizhu | paodekuai | mixed | platform`；
 * - 旧行由 `DEFAULT 'doudizhu'` 回填（U5 的显式选择；生产尚未部署 PDK 风控）；
 * - `idx_game_status_id (game_type, status, id)` 支撑审核队列的玩法+状态 keyset 筛选；
 * - `down()` 先删索引再删列。
 *
 * ⚠️ 类名不以 `PdkRecords` 开头（既有 migration.test 的旧迁移选择器）。
 */
export class RiskReviewGameType1797000000005 implements MigrationInterface {
  name = 'RiskReviewGameType1797000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE `risk_reviews` ADD COLUMN `game_type` varchar(16) NOT NULL DEFAULT 'doudizhu' AFTER `status`, ADD KEY `idx_game_status_id` (`game_type`, `status`, `id`)",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `risk_reviews` DROP KEY `idx_game_status_id`, DROP COLUMN `game_type`',
    );
  }
}
