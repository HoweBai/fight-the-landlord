import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 广告小片（T5）：广告渠道第四键空间的存储表（规格 §2.3 DDL **逐字**照
 * `1793000000000-NotifyChannelConfig.ts:26-33`，仅表名换 `ad_channel_config`）
 * —— `ad_channel_config`（与 config-service 同库 `fight_the_landlord`）。
 *
 * ⚠️ **形状逐字照 `1793000000000-NotifyChannelConfig.ts`**：类名 `<Name><时间戳>`、`name` 属性与类名一致、
 * SQL 用反引号标识符、`CREATE TABLE IF NOT EXISTS`（既有库形态下容器启动可重跑，`migrationsRun: true`）。
 *
 * ⚠️ `key` 为 MySQL **保留字** ⇒ 标识符必须反引号（同族教训 `admin-changes.service.ts:22-24`：
 * 旧稿裸写 `WHERE key=?` 在真栈 1064、配置 PUT 全 500）。
 *
 * ⚠️ **时间戳 `1795000000000`** 是顺延既有序列的号段（…1794000000000 已占用；`1795100000000`
 * = 第 41 键种子，号段在其后、按序随后执行）；全仓唯一由 `test/migration.test.ts` ⑯″ 钉住。
 * **无种子**（出厂 = 未配置——键 `ad.callbackSecret` 缺失即未开通，行为等价于「暗上线」；
 * 唯一写口 = 管理面 PUT/DELETE（T6）、读口 = 管理 GET + 专用拉取通道 RPC `config.adChannel.get`（T7））。
 *
 * `value_enc` = `v1:` 前缀密文（AES-256-GCM，§2.3，复用支付片设施；主钥复用 `PAY_CONFIG_ENC_KEY`）；
 * `fingerprint` = canonical 明文的 sha256 hex 前 12 位（脱敏识别用）；时间列 `datetime(3)`（UTC）。
 */
export class AdChannelConfig1795000000000 implements MigrationInterface {
  name = 'AdChannelConfig1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `ad_channel_config` (' +
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
    await queryRunner.query('DROP TABLE IF EXISTS `ad_channel_config`');
  }
}
