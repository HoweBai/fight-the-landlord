import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 机器人补位开关片：第 45–47 键的种子迁移——
 * `room.freeBotFillEnabled=true` / `room.goldBotFillEnabled=true` /
 * `room.matchNoBotMaxWaitMs=300000`。
 *
 * ⚠️ 形状逐字照 `1795200000000-EntryFeePercentsSeed.ts`：类名 `<Name><时间戳>`、
 * `name` 属性与类名一致、SQL 用反引号标识符、一语句多 VALUE 元组。
 *
 * ⚠️ **时间戳 1795400000000 —— 合并期由 1795300000000 改号**：本片与「客户端接入片」
 * （`1795300000000-ClientAccessGateSeed.ts`）在各自分支上**撞了同一个时间戳**；两者同库
 * 共存时 TypeORM 按时间戳排序、**平手 ⇒ 次序非确定**。合并裁决 = 主线（dev，已推 origin）
 * 保留 1795300000000，本迁移让位改 1795400000000（仍 > 既有最大 1795300000000）。
 * 本迁移此前从未在任何库执行过 ⇒ 改名不留下已执行记录的孤儿。
 *
 * ⚠️ **`INSERT IGNORE`（升级安全）**：合并前跑过本片旧时间戳（1795300000000）的库，
 * `platform_config` 里可能已有这三键、但 `migrations_config` 记的是旧类名 —— 普通 INSERT
 * 会在升级到本版时主键冲突、config-service 启动即失败。`IGNORE` 让「键已存在」退化为
 * 跳过（保留库里现值，不覆盖运营改过的配置），迁移记录照常写入。
 *
 * 种子语义（两个开关均 `true` ⇒ **暗上线，匹配行为与今天逐字节一致**；
 * 只有运营在管理面关掉某一场的开关后，缺人才改为发 `match.wait_prompt` 而非补机器人，
 * 此时 `room.matchNoBotMaxWaitMs` 才生效：真人等待总上限 300000ms=5 分钟）。
 */
export class BotFillConfigSeed1795400000000 implements MigrationInterface {
  name = 'BotFillConfigSeed1795400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里的 `true`/`300000` 是 JSON 字面量（不是字符串），
    // 与 `parseConfigValue(key, …)` 的严格 boolean / int 口径一致。
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('room.freeBotFillEnabled', 'true', 1, NOW(3), 'seed'), " +
        "('room.goldBotFillEnabled', 'true', 1, NOW(3), 'seed'), " +
        "('room.matchNoBotMaxWaitMs', '300000', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM `platform_config` WHERE `key` IN " +
        "('room.freeBotFillEnabled', 'room.goldBotFillEnabled', 'room.matchNoBotMaxWaitMs')",
    );
  }
}
