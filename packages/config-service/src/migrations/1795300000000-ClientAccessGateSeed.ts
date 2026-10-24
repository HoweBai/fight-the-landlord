import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 客户端接入片 T2：第 43/44 键 `client.appEnabled` / `client.h5Enabled` 的种子迁移
 * —— 双 `true`（**暗上线 = 全开** ⇒ 行为与今天逐字节一致；整端准入闸要显式关才咬）。
 *
 * ⚠️ 形状逐字照 `1795200000000-EntryFeePercentsSeed.ts`（类名 `<Name><时间戳>`、`name`
 * 属性与类名一致、SQL 反引号标识符、一语句多 VALUE 元组）。时间戳 1795300000000 >
 * 既有最大 1795200000000（同库内按序执行）。
 */
export class ClientAccessGateSeed1795300000000 implements MigrationInterface {
  name = 'ClientAccessGateSeed1795300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        `('client.appEnabled', 'true', 1, NOW(3), 'seed'),` +
        `('client.h5Enabled', 'true', 1, NOW(3), 'seed')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM `platform_config` WHERE `key` IN ('client.appEnabled', 'client.h5Enabled')",
    );
  }
}
