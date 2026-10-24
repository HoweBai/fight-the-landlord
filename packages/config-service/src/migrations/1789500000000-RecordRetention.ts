import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 记录片 T1：第 10 个配置键 `record.retentionDays` 的种子迁移
 * （记录片规格 §2.4：int、`1 ≤ n ≤ 3650`、**种子 = 365**；消费方 = user-service
 * 记录清理任务，缓存缺省 365）。
 *
 * ⚠️ **形状逐字照 `1789200000000-PlatformConfig.ts`**：类名 `<Name><时间戳>`、
 * `name` 属性与类名一致、SQL 用反引号标识符。
 *
 * ⚠️ **只 INSERT 新键一行**：迁移只跑一次（记录在**独立**的 `migrations_config` 表），
 * 既有的 9 行属于 `1789200000000` 那个迁移 —— 两者在同一次启动里按时间戳顺序执行
 * （时间戳 `1789500000000` 晚于它，保持「同一库内时间戳单调」的习惯）。
 */
export class RecordRetention1789500000000 implements MigrationInterface {
  name = 'RecordRetention1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里的 `365` 是 JSON 数字字面量（不是字符串），
    // 与 `parseConfigValue('record.retentionDays', …)` 的 int 口径一致。
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('record.retentionDays', '365', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆操作 = 让本迁移种下的那一行退场（值可能已被管理面改过；down 的语义是「第 10 键退场」）。
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'record.retentionDays'");
  }
}
