import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 设备绑定片：第 **49** 键 `risk.deviceBindingEnabled` 的种子迁移——
 * 单账号设备绑定总开关，严格 boolean，**暗上线 = `false`** ⇒ 登录/WS 两条绑定闸整体短路，
 * 行为与今天逐字节一致；管理后台置 true 才生效（启用后存量玩家首登静默绑定当前设备）。
 *
 * ⚠️ 形状逐字照 `1795200000000-EntryFeePercentsSeed.ts`：
 * 类名 `<Name><时间戳>`、`name` 属性与类名一致、SQL 用反引号标识符。
 * ⚠️ **时间戳 1795600000000 —— 合并期由 1795300000000 改号**：本片与主线已有的
 * `1795300000000-ClientAccessGateSeed.ts` **撞了同一个时间戳**（TypeORM 平手 ⇒ 次序非确定）。
 * 合并裁决 = 主线保 1795300000000，本迁移让位 1795600000000（仍 > 既有最大 1795500000000）。
 * 本迁移此前从未在任何库执行过 ⇒ 改名不留已执行记录的孤儿。
 *
 * ⚠️ **`INSERT IGNORE`（升级安全）**：合并前跑过本片旧时间戳（1795300000000）的库，
 * `platform_config` 里可能已有 `risk.deviceBindingEnabled`、但 `migrations_config` 记的是
 * 旧类名 —— 普通 INSERT 会在升级到本版时主键冲突、config-service 启动即失败。`IGNORE`
 * 让「键已存在」退化为跳过（保留库里现值，不覆盖运营改过的开关），迁移记录照常写入。
 */
export class RiskDeviceBindingSeed1795600000000 implements MigrationInterface {
  name = 'RiskDeviceBindingSeed1795600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里是 JSON boolean 字面量 false（严格 boolean——写入口拒字符串）。
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('risk.deviceBindingEnabled', 'false', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'risk.deviceBindingEnabled'");
  }
}
