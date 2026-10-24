import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 台费并入档位表 阶段 2：删除旧第 42 键 `currency.entryFeePercents` 行。
 *
 * ⚠️ 历史种子迁移 `1795200000000-EntryFeePercentsSeed.ts` **保留**（历史事实）；本迁移在其后执行，
 * 最终态无该行。`down` 重新插入与历史种子逐字一致的四档 ×0，供回滚到阶段 1/旧代码使用。
 * ⚠️ 时间戳必须 > `1795800000000`（记牌器价格种子）且全仓唯一。
 */
export class RemoveEntryFeePercents1796000000000 implements MigrationInterface {
  name = 'RemoveEntryFeePercents1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM `platform_config` WHERE `key` = 'currency.entryFeePercents'",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        `('currency.entryFeePercents', '[{"baseScore":15,"percent":0},{"baseScore":80,"percent":0},{"baseScore":480,"percent":0},{"baseScore":1200,"percent":0}]', 1, NOW(3), 'seed')`,
    );
  }
}
