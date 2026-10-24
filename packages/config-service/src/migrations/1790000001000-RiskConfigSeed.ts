import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 风控片 T1（⚙️1）：第 18–25 个配置键的种子迁移（规格 §2.1-3 八键逐字表 + §2.2 种子段）——
 * `risk.predicate.sameDevice=false` / `risk.predicate.sameIp=false` / `risk.winRateThreshold=0.8`
 * / `risk.minGames=100` / `risk.deviceLimit=3` / `risk.deviceWindowDays=30`
 * / `risk.autoThrottle=true` / `risk.deviceRetentionDays=365`。
 *
 * ⚠️ **谓词默认关**（设计全局约束：`risk.predicate.*` 种子 `false`；生产开启按手顺）。
 *
 * ⚠️ **形状逐字照 `1789800000000-GoldRoom.ts`**（其自身照 `1789700000000-SignupGrant.ts`
 * → `1789500000000-RecordRetention.ts`）：类名 `<Name><时间戳>`、`name` 属性与类名一致、
 * SQL 用反引号标识符。
 *
 * ⚠️ **只 INSERT 这八个新键**（一条语句、八个 VALUE 元组，照 `1789200000000-PlatformConfig.ts`
 * 九键种子的一语句多行形态）：迁移只跑一次（记录在**独立**的 `migrations_config` 表），
 * 既有 17 行属于前四个迁移 —— 五者按时间戳顺序执行（`1790000001000` 最晚，
 * 保持「同一库内时间戳单调」的习惯）。
 *
 * 种子值的语义（规格 §2.1-3 表；K5 = 阈值照搬 + 配置化）：
 *  - `risk.predicate.sameDevice` / `risk.predicate.sameIp=false` —— 匹配期谓词**默认关**；
 *  - `risk.winRateThreshold=0.8` —— 胜率线（0.5 ≤ n ≤ 1.0、≤2 位小数）；
 *  - `risk.minGames=100` —— 最少局数（`games > minGames` 才算命中素材）；
 *  - `risk.deviceLimit=3` —— 单设备关联账号上限（窗口内）；
 *  - `risk.deviceWindowDays=30` —— 设备扫描窗口天数；
 *  - `risk.autoThrottle=true` —— 命中自动限流（与谓词开关独立）；
 *  - `risk.deviceRetentionDays=365` —— 设备记录保留天数（清理任务 cutoff）。
 */
export class RiskConfigSeed1790000001000 implements MigrationInterface {
  name = 'RiskConfigSeed1790000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里的 `false`/`0.8`/`100` 是 JSON 字面量（不是字符串），
    // 与 `parseConfigValue(key, …)` 的严格 boolean / number / int 口径一致。
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('risk.predicate.sameDevice', 'false', 1, NOW(3), 'seed'), " +
        "('risk.predicate.sameIp', 'false', 1, NOW(3), 'seed'), " +
        "('risk.winRateThreshold', '0.8', 1, NOW(3), 'seed'), " +
        "('risk.minGames', '100', 1, NOW(3), 'seed'), " +
        "('risk.deviceLimit', '3', 1, NOW(3), 'seed'), " +
        "('risk.deviceWindowDays', '30', 1, NOW(3), 'seed'), " +
        "('risk.autoThrottle', 'true', 1, NOW(3), 'seed'), " +
        "('risk.deviceRetentionDays', '365', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆操作 = 让本迁移种下的八行退场（值可能已被管理面改过；down 的语义是「第 18–25 键退场」）。
    await queryRunner.query(
      'DELETE FROM `platform_config` WHERE `key` IN ' +
        "('risk.predicate.sameDevice', 'risk.predicate.sameIp', 'risk.winRateThreshold', " +
        "'risk.minGames', 'risk.deviceLimit', 'risk.deviceWindowDays', 'risk.autoThrottle', " +
        "'risk.deviceRetentionDays')",
    );
  }
}
