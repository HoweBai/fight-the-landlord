import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T12 修复：麻将记录表时间列改 BIGINT（epoch ms）。
 *
 * 原迁移 `1798200000000` 把 `started_at`/`ended_at` 建成 `datetime(3)`，但
 * `RecordWriteRequest.startedAt/endedAt` 与 ddz/pdk 一样是 **epoch ms 数字**，
 * 直接 INSERT 会报 `Incorrect datetime value`。新库由原迁移直接建 BIGINT；
 * 已跑过原迁移的库由本迁移 ALTER。
 */
export class MahjongTimestampsBigint1798400000000 implements MigrationInterface {
  name = 'MahjongTimestampsBigint1798400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `game_records_mahjong` ' +
        'MODIFY `started_at` BIGINT NOT NULL, ' +
        'MODIFY `ended_at` BIGINT NOT NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `game_record_players_mahjong` MODIFY `ended_at` BIGINT NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `game_record_players_mahjong` MODIFY `ended_at` datetime(3) NOT NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `game_records_mahjong` ' +
        'MODIFY `started_at` datetime(3) NOT NULL, ' +
        'MODIFY `ended_at` datetime(3) NOT NULL',
    );
  }
}
