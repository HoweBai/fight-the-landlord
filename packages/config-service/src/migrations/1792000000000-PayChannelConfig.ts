import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 支付配置管理化（T2）：渠道凭据第二键空间的存储表（规格 §2.2 DDL **逐字**）
 * —— `pay_channel_config`（与 config-service 同库 `fight_the_landlord`）。
 *
 * ⚠️ **形状逐字照 `1789900000000-AdminRbac.ts`**：类名 `<Name><时间戳>`、`name` 属性与类名一致、
 * SQL 用反引号标识符、`CREATE TABLE IF NOT EXISTS`（既有库形态下容器启动可重跑，`migrationsRun: true`）。
 *
 * ⚠️ `key` 为 MySQL **保留字** ⇒ 标识符必须反引号（同族教训 `admin-changes.service.ts:22-24`：
 * 旧稿裸写 `WHERE key=?` 在真栈 1064、配置 PUT 全 500）。
 *
 * ⚠️ **时间戳 `1792000000000`** 是顺延既有序列的下一个空号（1789200000000 / 1789500000000 /
 * 1789700000000 / 1789800000000 / 1789900000000 / 1790000001000 / 1791000001000 已占用；
 * 全仓唯一由 `test/migration.test.ts` ⑫″ 钉住）。**无种子**（出厂 = 未配置——行为等价于
 * 「暗上线无密钥」；唯一写口 = 管理面 PUT / 拉取通道，见 T4/T5）。
 *
 * `value_enc` = `v1:` 前缀密文（AES-256-GCM，§2.3）；`fingerprint` = canonical 明文的
 * sha256 hex 前 12 位（脱敏识别用）；时间列 `datetime(3)`（UTC）。
 */
export class PayChannelConfig1792000000000 implements MigrationInterface {
  name = 'PayChannelConfig1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `pay_channel_config` (' +
        ' `key` varchar(64) NOT NULL,' +
        ' `value_enc` text NOT NULL,' +
        ' `fingerprint` char(12) NOT NULL,' +
        ' `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        ' `updated_by` varchar(64) NOT NULL,' +
        ' PRIMARY KEY (`key`)' +
        ' ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `pay_channel_config`');
  }
}
