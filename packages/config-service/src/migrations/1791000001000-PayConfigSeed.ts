import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 支付片 T5：第 26–34 个配置键的种子迁移（规格 §2.5 九键逐字表）——
 * `pay.rechargeEnabled=false` / `pay.withdrawEnabled=false` / `pay.coinPerYuan=100`
 * / `pay.rechargePackages=[6,30,68,128,328]` / `pay.withdrawMinCoins=1000`
 * / `pay.withdrawMaxCoinsPerOrder=50000` / `pay.withdrawDailyMaxCoins=100000`
 * / `pay.orderExpireMinutes=30` / `pay.withdrawTimeoutMinutes=4320`。
 *
 * ⚠️ **两开关默认关 = 暗上线**（P5 裁决：软白名单，生产开启按手册五步——设计 §12）。
 *
 * ⚠️ **形状逐字照 `1790000001000-RiskConfigSeed.ts`**（其自身照 `1789800000000-GoldRoom.ts`
 * → `1789700000000-SignupGrant.ts` → `1789500000000-RecordRetention.ts`）：
 * 类名 `<Name><时间戳>`、`name` 属性与类名一致、SQL 用反引号标识符。
 *
 * ⚠️ **只 INSERT 这九个新键**（一条语句、九个 VALUE 元组，照 `1789200000000-PlatformConfig.ts`
 * 九键种子的一语句多行形态）：迁移只跑一次（记录在**独立**的 `migrations_config` 表），
 * 既有 25 行属于前五个迁移 —— 六者按时间戳顺序执行（`1791000001000` 最晚，
 * 保持「同一库内时间戳单调」的习惯；与 payment-service 的 `1791000000000-Payment.ts`
 * 号段独立、无碰撞）。
 *
 * 种子值的语义（规格 §2.5 表）：
 *  - `pay.rechargeEnabled` / `pay.withdrawEnabled=false` —— 暗上线开关（只挡新建单）；
 *  - `pay.coinPerYuan=100` —— 1 元 = 100 金币（下单时快照，后续改配置不影响在途单）；
 *  - `pay.rechargePackages=[6,30,68,128,328]` —— 充值档位（元）；
 *  - `pay.withdrawMinCoins=1000` —— 提现门槛（金币）；
 *  - `pay.withdrawMaxCoinsPerOrder=50000` —— 单笔上限（=500 元 @1:100）；
 *  - `pay.withdrawDailyMaxCoins=100000` —— 单日/人上限（=1000 元 @1:100）；
 *  - `pay.orderExpireMinutes=30` —— 订单有效期（分钟）；
 *  - `pay.withdrawTimeoutMinutes=4320` —— 超时回滚 72h（分钟；测试注入用小值）。
 */
export class PayConfigSeed1791000001000 implements MigrationInterface {
  name = 'PayConfigSeed1791000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里的 `false`/`100`/`[6,30,68,128,328]` 是 JSON 字面量
    // （不是字符串），与 `parseConfigValue(key, …)` 的严格 boolean / int / 数组口径一致。
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('pay.rechargeEnabled', 'false', 1, NOW(3), 'seed'), " +
        "('pay.withdrawEnabled', 'false', 1, NOW(3), 'seed'), " +
        "('pay.coinPerYuan', '100', 1, NOW(3), 'seed'), " +
        "('pay.rechargePackages', '[6,30,68,128,328]', 1, NOW(3), 'seed'), " +
        "('pay.withdrawMinCoins', '1000', 1, NOW(3), 'seed'), " +
        "('pay.withdrawMaxCoinsPerOrder', '50000', 1, NOW(3), 'seed'), " +
        "('pay.withdrawDailyMaxCoins', '100000', 1, NOW(3), 'seed'), " +
        "('pay.orderExpireMinutes', '30', 1, NOW(3), 'seed'), " +
        "('pay.withdrawTimeoutMinutes', '4320', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆操作 = 让本迁移种下的九行退场（值可能已被管理面改过；down 的语义是「第 26–34 键退场」）。
    await queryRunner.query(
      'DELETE FROM `platform_config` WHERE `key` IN ' +
        "('pay.rechargeEnabled', 'pay.withdrawEnabled', 'pay.coinPerYuan', " +
        "'pay.rechargePackages', 'pay.withdrawMinCoins', 'pay.withdrawMaxCoinsPerOrder', " +
        "'pay.withdrawDailyMaxCoins', 'pay.orderExpireMinutes', 'pay.withdrawTimeoutMinutes')",
    );
  }
}
