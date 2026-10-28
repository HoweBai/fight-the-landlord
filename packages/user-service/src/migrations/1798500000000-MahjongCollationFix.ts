import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 2026-10-28：麻将双表建表时误用 `utf8mb4_unicode_ci`，而库内既有表（users /
 * game_records / risk_reviews …）都是 `utf8mb4_0900_ai_ci`。
 * `RISK_WIN_RATE_MAHJONG_SQL` 的 `JOIN users u ON u.id = p.user_id` 因此报
 * `Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and
 * (utf8mb4_unicode_ci,IMPLICIT) for operation '='`，
 * `RiskScanSqlFailures{scope="mahjong"}` 每轮触发。
 *
 * 本迁移把两张表统一到库内既有的 0900_ai_ci；`CONVERT TO` 会保留数据并重建索引。
 */
export class MahjongCollationFix1798500000000 implements MigrationInterface {
  name = 'MahjongCollationFix1798500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `game_records_mahjong` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    );
    await queryRunner.query(
      'ALTER TABLE `game_record_players_mahjong` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `game_records_mahjong` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
    );
    await queryRunner.query(
      'ALTER TABLE `game_record_players_mahjong` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
    );
  }
}
