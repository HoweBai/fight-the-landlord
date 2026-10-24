import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 台费片 T2：第 42 键 `currency.entryFeePercents` 的种子迁移（规格 §2.1c 逐字）——
 * 4 行 × percent 0（与档位表同形；**暗上线 = 全 0** ⇒ 收费块整体短路，行为与今天逐字节一致）。
 *
 * ⚠️ 形状逐字照 `1795100000000-AdReliefAdpidSeed.ts`（其自身照 IntervalConfigSeed 一族）：
 * 类名 `<Name><时间戳>`、`name` 属性与类名一致、SQL 用反引号标识符、一语句多 VALUE 元组。
 * 时间戳 1795200000000 > 既有最大 1795100000000（同库内按序执行）。
 */
export class EntryFeePercentsSeed1795200000000 implements MigrationInterface {
  name = 'EntryFeePercentsSeed1795200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里是 JSON 数组字面量（键序 baseScore→percent 逐字）。
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        `('currency.entryFeePercents', '[{"baseScore":15,"percent":0},{"baseScore":80,"percent":0},{"baseScore":480,"percent":0},{"baseScore":1200,"percent":0}]', 1, NOW(3), 'seed')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'currency.entryFeePercents'");
  }
}
