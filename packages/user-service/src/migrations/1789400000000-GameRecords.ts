import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 对局记录两表（记录片 T4；规格 §2.6 / 设计 D3 **逐字**）。
 *
 * - `game_records`：每局 1 行；`UNIQUE KEY uk_room_version (room_code, game_version)`
 *   是 `record.write` **幂等**的硬闸（重复投递只能命中它）；`idx_ended_at` 服务清理与 keyset。
 * - `game_record_players`：每局 3 行（防「有记录无 players」孤儿 = 写入侧事务的职责）；
 *   三索引各自有主：`idx_user_ended`（「我的历史战绩」keyset）、`idx_ended_at`（清理）、
 *   `idx_record`（按记录回查）。
 * - `user_id` 机器人 = NULL（**绝不写 displayId**）；`nickname` 快照宽度 = `users.nickname` 同宽；
 *   `is_robot` 定死（P3 榜过滤复用）；`money_delta` 预留（P1 恒 NULL）。
 * - `hand` / `bottom_cards` 是 T1 codec 的定长 hex（34 / 6）。
 *
 * ⚠️ **形状逐字照 `1789100000000-BaseScoreLevels`**：类名 `<Name><timestamp>`、
 * `name` 属性与类名一致、`CREATE TABLE IF NOT EXISTS`（现有库上 `migrationsRun` 可重跑）、
 * charset/collation 与既有表一致（进 JOIN 的 `user_id` 与 `users.id` 必须同口径）。
 *
 * ⚠️ **down 是 up 的镜像**：先删子表（players）再删父表（records）。
 */
export class GameRecords1789400000000 implements MigrationInterface {
  name = 'GameRecords1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `game_records` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`room_code` varchar(16) NOT NULL, ' +
        '`game_version` int NOT NULL, ' +
        '`mode` varchar(16) NOT NULL, ' +
        '`base_score` int NOT NULL, ' +
        '`winner` varchar(8) NOT NULL, ' +
        '`landlord_seat` tinyint NOT NULL, ' +
        '`multiplier` int NOT NULL, ' +
        '`spring` varchar(16) NOT NULL, ' +
        '`landlord_score_change` int NOT NULL, ' +
        '`farmer_score_change` int NOT NULL, ' +
        '`bottom_cards` char(6) NOT NULL, ' +
        '`started_at` datetime(3) NOT NULL, ' +
        '`ended_at` datetime(3) NOT NULL, ' +
        '`created_at` datetime(3) NOT NULL, ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_room_version` (`room_code`, `game_version`), ' +
        'KEY `idx_ended_at` (`ended_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `game_record_players` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`record_id` bigint NOT NULL, ' +
        '`seat` tinyint NOT NULL, ' +
        '`user_id` varchar(64) NULL, ' +
        '`is_robot` tinyint(1) NOT NULL, ' +
        '`robot_id` varchar(64) NULL, ' +
        '`nickname` varchar(50) NULL, ' +
        '`role` varchar(8) NOT NULL, ' +
        '`score_change` int NOT NULL, ' +
        '`won` tinyint(1) NOT NULL, ' +
        '`hand` char(34) NOT NULL, ' +
        '`money_delta` int NULL, ' +
        '`ended_at` datetime(3) NOT NULL, ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_user_ended` (`user_id`, `ended_at`), ' +
        'KEY `idx_ended_at` (`ended_at`), ' +
        'KEY `idx_record` (`record_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `game_record_players`');
    await queryRunner.query('DROP TABLE IF EXISTS `game_records`');
  }
}
