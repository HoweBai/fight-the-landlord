import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 节奏/清理片 T2：第 35–40 个配置键的种子迁移（规格 ⚙️3 / 设计 D4；⚙️1 六键逐字表）——
 * `pay.scanIntervalMs=60000` / `pay.reconcileIntervalMs=86400000`
 * / `currency.reconcileIntervalMs=3600000` / `risk.scanIntervalMs=3600000`
 * / `risk.devicesCleanupIntervalMs=3600000` / `record.cleanupIntervalMs=3600000`。
 *
 * 🔴 **值 = 现行默认（env / 硬编码常数）⇒ 行为保持** —— 六循环的代码默认常数即本表值，
 * 迁移种下后各服务经配置链路读到同值；**生产第 0 天行为零变化（行为等价日 0）**：
 * 本迁移只把「出厂默认」的存放处从代码/env 迁到配置表，不引入任何行为变化（设计 D4）。
 *
 * ⚠️ **形状逐字照 `1791000001000-PayConfigSeed.ts`**（其自身照 `1790000001000-RiskConfigSeed.ts`
 * → `1789800000000-GoldRoom.ts` → `1789700000000-SignupGrant.ts` → `1789500000000-RecordRetention.ts`）：
 * 类名 `<Name><时间戳>`、`name` 属性与类名一致、SQL 用反引号标识符。
 *
 * ⚠️ **只 INSERT 这六个新键**（一条语句、六个 VALUE 元组，照 `1789200000000-PlatformConfig.ts`
 * 九键种子的一语句多行形态）：迁移只跑一次（记录在**独立**的 `migrations_config` 表），
 * 既有 34 行属于前六个种子迁移 —— 七者按时间戳顺序执行（`1794000000000` 最晚，
 * 前一个 = `1793000000000-NotifyChannelConfig`〔建表、无种子〕；保持「同一库内时间戳单调」
 * 的习惯；与 payment-service 的 `1791000000000-Payment.ts` 号段独立、无碰撞）。
 *
 * 种子值的语义（规格 ⚙️1 表 + ⚙️4 消费方）：
 *  - `pay.scanIntervalMs=60000` —— 支付扫描周期 60s：八条补偿循环
 *    （过期关闭/重放入账/④–⑧）的统一节奏，消费方 payment-service；
 *  - `pay.reconcileIntervalMs=86400000` —— 支付日自检周期 24h（入账勾稽 + 锚勾稽），
 *    消费方 payment-service；
 *  - `currency.reconcileIntervalMs=3600000` —— 货币对账周期 1h
 *    （账实相符/缓存漂移自愈/孤儿诊断），消费方 currency-service；
 *  - `risk.scanIntervalMs=3600000` —— 风控扫描周期 1h（内置闸 + 双谓词判定），
 *    消费方 user-service；
 *  - `risk.devicesCleanupIntervalMs=3600000` —— 风控设备记录清理周期 1h
 *    （按 `risk.deviceRetentionDays` 保留期批删），消费方 user-service；
 *  - `record.cleanupIntervalMs=3600000` —— 对局记录保留期清理周期 1h
 *    （保留天数在 `record.retentionDays` 单独调），消费方 user-service。
 */
export class IntervalConfigSeed1794000000000 implements MigrationInterface {
  name = 'IntervalConfigSeed1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里的 `60000`/`86400000`/`3600000` 是 JSON 数字字面量
    // （不是字符串），与 `parseIntervalMs` 的严格 int 口径一致。
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('pay.scanIntervalMs', '60000', 1, NOW(3), 'seed'), " +
        "('pay.reconcileIntervalMs', '86400000', 1, NOW(3), 'seed'), " +
        "('currency.reconcileIntervalMs', '3600000', 1, NOW(3), 'seed'), " +
        "('risk.scanIntervalMs', '3600000', 1, NOW(3), 'seed'), " +
        "('risk.devicesCleanupIntervalMs', '3600000', 1, NOW(3), 'seed'), " +
        "('record.cleanupIntervalMs', '3600000', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆操作 = 让本迁移种下的六行退场（值可能已被管理面改过；down 的语义是「第 35–40 键退场」）。
    await queryRunner.query(
      'DELETE FROM `platform_config` WHERE `key` IN ' +
        "('pay.scanIntervalMs', 'pay.reconcileIntervalMs', 'currency.reconcileIntervalMs', " +
        "'risk.scanIntervalMs', 'risk.devicesCleanupIntervalMs', 'record.cleanupIntervalMs')",
    );
  }
}
