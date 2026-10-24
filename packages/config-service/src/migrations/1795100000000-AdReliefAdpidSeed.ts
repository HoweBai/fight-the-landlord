import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 第 41 键种子：`ad.reliefAdpid` = 空串（= 未配置 ⇒ 救助入口不渲染；暗上线语义）。
 * ⚠️ **string JSON 字面量首例**：`'""'` 是空字符串（不是空值）——数值先例 `'60000'` 会误导。
 */
export class AdReliefAdpidSeed1795100000000 implements MigrationInterface {
  name = 'AdReliefAdpidSeed1795100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        `('ad.reliefAdpid', '""', 1, NOW(3), 'seed')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'ad.reliefAdpid'");
  }
}
