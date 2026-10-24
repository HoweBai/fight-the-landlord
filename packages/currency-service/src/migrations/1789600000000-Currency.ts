import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 货币核心（T3；规格 §2.10 DDL **逐字**）：`currency_accounts` / `currency_ops` / `currency_flows` 三表。
 *
 * - **编号口径**：1789600000000 晚于 user-service 全部迁移（`1789400000000-GameRecords` 之后）、
 *   早于 config-service 的 `1789700000000-SignupGrant` —— 三服务共库但迁移表各一份
 *   （⚙️9：本服务的迁移表 = `migrations_currency`，见 `database.config.ts`），编号只用于本表内排序。
 * - **`currency_` 前缀防撞名**：与 user/config 两服务共库（`fight_the_landlord`），
 *   裸 `accounts`/`ops`/`flows` 这种名字迟早与别家或 DBA 手工表撞车。
 * - **写入者建行 / 读不建行**（§2.10 表头约定）：`currency_accounts` 的行只由
 *   `currency.apply` 的余额步（条件 UPDATE 0 行 ⇒ `INSERT IGNORE`）建立；`currency.get`
 *   与玩家/管理 REST 查询**不建行**（不产垃圾行）。`currency_ops` 与 `currency_flows`
 *   只在 apply 的同一事务里成对出现（一次 apply = 1 行 op + N 行 flow）。
 * - **流水永久保留**：`currency_flows` 只增不改、永不清理（与对局记录 365 天保留期相反，
 *   明确区分）；`currency_ops` 是幂等锚（`uk_action_id`），同样只增。
 * - `updated_at` 的 `ON UPDATE CURRENT_TIMESTAMP(3)` 只服务运维直读（wire 不读它）；
 *   `created_at` 全部由列默认值承担（INSERT 语句不含它）。
 *
 * ⚠️ **形状逐字照 `1789400000000-GameRecords` 先例**：类名 `<Name><timestamp>`、
 * `name` 属性与类名一致、全部 `CREATE TABLE IF NOT EXISTS`（现有库上 `migrationsRun`
 * 可重跑）、charset/collation 与既有表一致（进 JOIN 的 `owner_id` 与 `users.id` 同口径）。
 *
 * ⚠️ **down 是 up 的镜像（逆序）**：先删流水（flows）再删操作（ops）最后删账户（accounts）
 * —— 依赖方向 accounts ← ops → flows（flows 经 op_id 指向 ops，ops 经 owner 语义指向 accounts）。
 */
export class Currency1789600000000 implements MigrationInterface {
  name = 'Currency1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ① 账户（余额物化行；PK = owner_id —— 一人一行，首写固化 owner_type）
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `currency_accounts` (' +
        "`owner_id` varchar(36) NOT NULL, " +
        "`owner_type` varchar(8) NOT NULL DEFAULT 'user', " +
        '`balance` int NOT NULL DEFAULT 0, ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`owner_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    // ② 操作（幂等锚）：一次 apply = 一行；`uk_action_id` 是重放/并发撞键的最终硬闸
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `currency_ops` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`action_id` varchar(128) NOT NULL, ' +
        '`request_hash` char(64) NOT NULL, ' +
        '`source` varchar(32) NOT NULL, ' +
        '`actor` varchar(64) NULL, ' +
        '`reason` varchar(255) NULL, ' +
        '`ref_id` varchar(128) NULL, ' +
        '`trace_id` varchar(64) NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_action_id` (`action_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    // ③ 流水（只增不改、永不清洗）：`idx_flow_owner` 服务按人回查（幂等重建/管理面），
    //    `idx_flow_op` 服务按 op 回查（重放重建 + 对账 JOIN）
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `currency_flows` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`op_id` bigint NOT NULL, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        "`owner_type` varchar(8) NOT NULL DEFAULT 'user', " +
        '`delta` int NOT NULL, ' +
        '`balance_after` int NOT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_flow_owner` (`owner_id`, `id`), ' +
        'KEY `idx_flow_op` (`op_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆序：flows → ops → accounts（见文件头「down 是 up 的镜像」）
    await queryRunner.query('DROP TABLE IF EXISTS `currency_flows`');
    await queryRunner.query('DROP TABLE IF EXISTS `currency_ops`');
    await queryRunner.query('DROP TABLE IF EXISTS `currency_accounts`');
  }
}
