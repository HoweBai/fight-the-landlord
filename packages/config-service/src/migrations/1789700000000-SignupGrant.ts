import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 货币核心片（P2-①）T2：第 11 个配置键 `currency.signupGrant` 的种子迁移
 * （货币核心规格 §2.8：int、`0 ≤ n ≤ 1,000,000`、**种子 = 0**；消费方 = user-service
 * 注册链路的配置缓存 getter（缺失/坏值回落 0），§2.7）。
 *
 * ⚠️ **形状逐字照 `1789500000000-RecordRetention.ts`**：类名 `<Name><时间戳>`、
 * `name` 属性与类名一致、SQL 用反引号标识符。
 *
 * ⚠️ **只 INSERT 新键一行**：迁移只跑一次（记录在**独立**的 `migrations_config` 表），
 * 既有 10 行属于前两个迁移 —— 三者按时间戳顺序执行（`1789700000000` 晚于它们，
 * 保持「同一库内时间戳单调」的习惯）。
 */
export class SignupGrant1789700000000 implements MigrationInterface {
  name = 'SignupGrant1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里的 `0` 是 JSON 数字字面量（不是字符串），
    // 与 `parseConfigValue('currency.signupGrant', …)` 的 int 口径一致。
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('currency.signupGrant', '0', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆操作 = 让本迁移种下的那一行退场（值可能已被管理面改过；down 的语义是「第 11 键退场」）。
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'currency.signupGrant'");
  }
}
