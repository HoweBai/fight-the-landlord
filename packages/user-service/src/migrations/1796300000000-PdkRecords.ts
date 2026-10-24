import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 跑得快战绩两表（多玩法 S4 Task 4.0；spec §4.9.1 / D11 **逐字**）。
 *
 * - **单独建表**，不复用斗地主 `game_records*`：旧 user-service/旧历史页永远不会读到 pdk 行
 *   （斗地主表有 `winner/landlord_seat/bottom_cards NOT NULL`，混表会打挂写入与回滚）。
 * - `game_records_pdk`：每局 1 行；`uk_pdk_room_version` 是 `record.write` 幂等的硬闸；
 *   `idx_pdk_ended_at` 服务保留期清理。
 * - `game_record_players_pdk`：每局 `player_count` 行；`hand` 16 张=32 hex / 12 张=24 hex；
 *   `played_count` 来自会话实际出牌张数（关牌判定）；`money_delta` 由 `record.moneyDelta` 回写。
 * - `unused_cards` 仅 2 人局（16 张 × 2 hex），**仅审计**，任何客户端接口都不返回。
 * - `started_at` / `ended_at` 用 epoch ms（BIGINT），与 contract 的毫秒时间戳同口径。
 *
 * ⚠️ 斗地主两表**零迁移**（本迁移不碰它们）；`down` 是 `up` 的镜像，先删子表。
 */
export class PdkRecords1796300000000 implements MigrationInterface {
  name = 'PdkRecords1796300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `game_records_pdk` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`room_code` varchar(16) NOT NULL, ' +
        '`game_version` int NOT NULL, ' +
        '`mode` varchar(16) NOT NULL, ' +
        '`player_count` tinyint NOT NULL, ' +
        '`base_score` int NOT NULL, ' +
        '`winner_seat` tinyint NOT NULL, ' +
        '`remaining` json NOT NULL, ' +
        '`multiplier` int NOT NULL, ' +
        '`bomb_count` int NOT NULL, ' +
        '`guan` tinyint(1) NOT NULL, ' +
        '`spring` tinyint(1) NOT NULL, ' +
        '`baoben_seats` json NOT NULL, ' +
        '`score_changes` json NOT NULL, ' +
        '`unused_cards` varchar(32) NULL, ' +
        '`started_at` bigint NOT NULL, ' +
        '`ended_at` bigint NOT NULL, ' +
        '`created_at` timestamp DEFAULT CURRENT_TIMESTAMP, ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_pdk_room_version` (`room_code`, `game_version`), ' +
        'KEY `idx_pdk_ended_at` (`ended_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `game_record_players_pdk` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`record_id` bigint NOT NULL, ' +
        '`seat` tinyint NOT NULL, ' +
        '`user_id` varchar(36) NULL, ' +
        '`is_robot` tinyint(1) NOT NULL, ' +
        '`robot_id` varchar(64) NULL, ' +
        '`nickname` varchar(64) NULL, ' +
        '`hand` varchar(34) NOT NULL, ' +
        '`played_count` smallint NOT NULL, ' +
        '`money_delta` int NULL, ' +
        '`ended_at` bigint NOT NULL, ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_pdk_record_seat` (`record_id`, `seat`), ' +
        'KEY `idx_pdk_user` (`user_id`), ' +
        'KEY `idx_pdk_ended_at` (`ended_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `game_record_players_pdk`');
    await queryRunner.query('DROP TABLE IF EXISTS `game_records_pdk`');
  }
}
