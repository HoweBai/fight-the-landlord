import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 风控三表（风控片 T4；规格 §2.2 **逐字** / 设计 §5.3；迁移号 ⚙️1 写死）。
 *
 * - `user_devices`：设备指纹链（K3：`device_id` 原文入库；玩家面永不出站）。
 *   `UNIQUE KEY uk_user_device (user_id, device_id)` 是 upsert（⚙️11）的**幂等硬闸**；
 *   `idx_device`（按设备查关联账号）与 `idx_last_seen`（保留期清理，T4 的
 *   `devices-cleanup.service.ts`）服务两个查询面。
 * - `risk_reviews`：审核队列（T5 扫描 upsert / T6 管理面读）。`score` = 命中项数×25；
 *   `reasons` 是结构数组 JSON；`handled_by` = 管理员用户名 | 'system'。
 * - `risk_actions`：处置审计（T6 写；`action` 注释 = **动作全集八值**：七值含 `reopen`
 *   —— `reopen` 系统专用，管理面五值合法集是它的子集；设备绑定片追加管理面 `device_unbind`
 *   （第八值；varchar(16) 容得下 13 字符）。三组都以这份注释为全集登记面）。
 *
 * ⚠️ **形状逐字照 `1789400000000-GameRecords`**（其自身照更早三份）：类名
 * `<Name><timestamp>`、`name` 属性与类名一致、`CREATE TABLE IF NOT EXISTS`（现有库上
 * `migrationsRun` 可重跑）、每列一行式拼接。
 * ⚠️ **与规格 §2.2 字面的唯一差异**：`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` 后补
 * `COLLATE=utf8mb4_0900_ai_ci` —— 与既有四表**逐字一致**（进 JOIN 的 `user_id` 与
 * `users.id`/`game_record_players.user_id` 必须同口径）；MySQL 8 的 utf8mb4 默认排序规则
 * 即此值，属**口径钉死**不是行为改动（先例 = GameRecords 迁移同款处理）。
 * ⚠️ **行内 `--` 注释逐字保留**（规格 §2.2 的 DDL 注释含 `reopen` 语料；每段注释后接 `\n`
 * ——MySQL 的 `-- ` 注释到行尾，不会吞下一列）。
 *
 * ⚠️ **down 是 up 的镜像**：逆序 DROP（risk_actions → risk_reviews → user_devices）。
 */
export class RiskControl1790000000000 implements MigrationInterface {
  name = 'RiskControl1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `user_devices` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`user_id` varchar(64) NOT NULL, ' +
        '`device_id` varchar(64) NOT NULL, -- K3：原文入库；玩家面永不出站\n' +
        '`first_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_user_device` (`user_id`,`device_id`), ' +
        'KEY `idx_device` (`device_id`), ' +
        'KEY `idx_last_seen` (`last_seen_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `risk_reviews` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`user_id` varchar(64) NOT NULL, ' +
        "`score` int NOT NULL, -- 命中项数×25（∈{25,50}）\n" +
        "`reasons` json NOT NULL, -- [{check:'winRate'|'devices'|'revived', detail:{...}}]\n" +
        "`status` varchar(12) NOT NULL DEFAULT 'open', -- open|dismissed|throttled|banned\n" +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        "`handled_by` varchar(32) NULL, -- 管理员用户名 | 'system'\n" +
        '`handled_at` datetime(3) NULL, ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_status_id` (`status`,`id`), ' +
        'KEY `idx_user_id` (`user_id`,`id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `risk_actions` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`user_id` varchar(64) NOT NULL, ' +
        '`action` varchar(16) NOT NULL, -- auto_throttle|throttle|unthrottle|ban|unban|dismiss|reopen|device_unbind\n' +
        "`actor` varchar(32) NOT NULL, -- 管理员用户名 | 'system'\n" +
        '`reason` varchar(200) NULL, ' +
        '`review_id` bigint NULL, ' +
        '`detail` json NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_user_created` (`user_id`,`id`), ' +
        'KEY `idx_created` (`created_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `risk_actions`');
    await queryRunner.query('DROP TABLE IF EXISTS `risk_reviews`');
    await queryRunner.query('DROP TABLE IF EXISTS `user_devices`');
  }
}
