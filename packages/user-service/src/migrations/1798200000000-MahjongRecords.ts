import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 2026-10-28：麻将独立双表（沿用 pdk D11 先例）。 */
export class MahjongRecords1798200000000 implements MigrationInterface {
  name = 'MahjongRecords1798200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `game_records_mahjong` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`room_code` varchar(32) NOT NULL, ' +
        '`game_version` int NOT NULL, ' +
        '`mode` varchar(16) NOT NULL, ' +
        '`game_type` varchar(16) NOT NULL DEFAULT \'mahjong\', ' +
        '`player_count` tinyint NOT NULL DEFAULT 4, ' +
        '`base_score` int NOT NULL, ' +
        '`dealer_seat` tinyint NOT NULL, ' +
        '`end_reason` varchar(16) NOT NULL, ' +
        '`liuju` tinyint NOT NULL DEFAULT 0, ' +
        '`winner_seats` json NOT NULL, ' +
        '`huazhu_seats` json NOT NULL, ' +
        '`fan_details` json NOT NULL, ' +
        '`events` json NOT NULL, ' +
        '`burn` json NOT NULL, ' +
        '`rake_total` int NOT NULL DEFAULT 0, ' +
        '`started_at` datetime(3) NOT NULL, ' +
        '`ended_at` datetime(3) NOT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_mahjong_room_version` (`room_code`, `game_version`), ' +
        'KEY `idx_mahjong_ended_at` (`ended_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    );
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `game_record_players_mahjong` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`record_id` bigint NOT NULL, ' +
        '`seat` tinyint NOT NULL, ' +
        '`user_id` varchar(64) NULL, ' +
        '`is_robot` tinyint NOT NULL DEFAULT 0, ' +
        '`robot_id` varchar(64) NULL, ' +
        '`nickname` varchar(64) NULL, ' +
        '`hand` varchar(27) NOT NULL, ' +
        '`final_hand` varchar(27) NULL, ' +
        '`melds` json NOT NULL, ' +
        '`discards` json NOT NULL, ' +
        '`lack_suit` tinyint NULL, ' +
        '`is_out` tinyint NOT NULL DEFAULT 0, ' +
        '`fan` int NULL, ' +
        '`multiplier` int NULL, ' +
        '`score_change` int NOT NULL DEFAULT 0, ' +
        '`money_delta` int NULL, ' +
        '`won` tinyint NOT NULL DEFAULT 0, ' +
        '`ended_at` datetime(3) NOT NULL, ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_mahjong_record_seat` (`record_id`, `seat`), ' +
        'KEY `idx_mahjong_user_ended` (`user_id`, `ended_at`), ' +
        'KEY `idx_mahjong_ended_at` (`ended_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `game_record_players_mahjong`');
    await queryRunner.query('DROP TABLE IF EXISTS `game_records_mahjong`');
  }
}
