import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A2（spec D8/D9/§6.5）：PDK 记录补玩法维度与逐座投影 **DDL 半边**。
 *
 * - `game_records_pdk.game_type`：`NOT NULL DEFAULT 'paodekuai'`（旧行自动回填）；
 * - `game_record_players_pdk.score_change/won`：与斗地主玩家行同形，服务最近对局与统计；
 * - `idx_pdk_user_ended (user_id, ended_at)`：支撑 `MAX(ended_at)` 与 keyset。
 *
 * 数据回填在**独立迁移** `PdkRecordPlayerBackfill1797000000004`（MySQL DDL 隐式提交；
 * 同迁移内做数据步会在中途失败时留下「列已加、迁移未记录」的卡启动状态）。
 *
 * ⚠️ 类名不得以 `PdkRecords` 开头（既有 migration.test 用 `startsWith('PdkRecords')` 取旧迁移）。
 */
export class PdkRecordGameTypeDdl1797000000003 implements MigrationInterface {
  name = 'PdkRecordGameTypeDdl1797000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `game_records_pdk` ADD COLUMN `game_type` varchar(16) NOT NULL DEFAULT \'paodekuai\'',
    );
    await queryRunner.query(
      'ALTER TABLE `game_record_players_pdk` ' +
        'ADD COLUMN `score_change` int NOT NULL DEFAULT 0, ' +
        'ADD COLUMN `won` tinyint(1) NOT NULL DEFAULT 0, ' +
        'ADD KEY `idx_pdk_user_ended` (`user_id`, `ended_at`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `game_record_players_pdk` DROP KEY `idx_pdk_user_ended`, DROP COLUMN `won`, DROP COLUMN `score_change`',
    );
    await queryRunner.query('ALTER TABLE `game_records_pdk` DROP COLUMN `game_type`');
  }
}
