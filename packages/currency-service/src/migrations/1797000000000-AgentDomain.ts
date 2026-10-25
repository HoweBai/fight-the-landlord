import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 代理分润域（2026-10-26）：17 张表 + `agent_settings` 单行种子。
 *
 * 设计真源：`docs/superpowers/specs/2026-10-26-agent-commission-design.md` §3。
 *
 * ⚠️ 类名**不得**以 `Currency` 开头：`test/migration.test.ts` 按 `/^Currency\d+$/` 取
 * 首个匹配（会抢位）。本类名 = `AgentDomain1797000000000`。
 * ⚠️ 时间戳与 config-service 的 `1796900000000-AgentInviteKey` **不同号**。
 * ⚠️ 全部 `CREATE TABLE IF NOT EXISTS`（`migrationsRun` 可在现有库上重跑）；
 * charset/collation 与既有表一致（进 JOIN 的 owner_id 与 users.id 同口径）。
 * ⚠️ 资金算术列（micro/carry/watermark）一律 `BIGINT NOT NULL DEFAULT 0` ——
 * NULL 会让 `floor((NULL+total)/10000)` 变 NaN、`id > NULL` 恒空。
 */
export class AgentDomain1797000000000 implements MigrationInterface {
  name = 'AgentDomain1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const suffix =
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_settings` (' +
        '`id` tinyint NOT NULL, ' +
        '`enabled` tinyint(1) NOT NULL DEFAULT 0, ' +
        '`effective_from` datetime(3) NULL DEFAULT NULL, ' +
        '`default_rate_bp` int NOT NULL DEFAULT 0, ' +
        '`min_settlement_yuan` int NOT NULL DEFAULT 100, ' +
        '`coin_per_yuan` int NOT NULL DEFAULT 100, ' +
        '`quota_hold_days` int NOT NULL DEFAULT 0, ' +
        '`quota_admin_adjust_daily_limit_coins` int NOT NULL DEFAULT 50000, ' +
        '`adjust_max_yuan_per_op` int NOT NULL DEFAULT 10000, ' +
        '`adjust_max_yuan_per_day` int NOT NULL DEFAULT 20000, ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        '`updated_by` varchar(50) NULL DEFAULT NULL, ' +
        'PRIMARY KEY (`id`)' +
        suffix,
    );
    await queryRunner.query('INSERT IGNORE INTO `agent_settings` (`id`) VALUES (1)');

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_accounts` (' +
        '`id` varchar(40) NOT NULL, ' +
        '`name` varchar(50) NOT NULL, ' +
        '`phone` varchar(20) NOT NULL, ' +
        '`password_hash` varchar(255) NOT NULL, ' +
        '`parent_id` varchar(40) NULL DEFAULT NULL, ' +
        '`rate_bp` int NOT NULL DEFAULT 0, ' +
        '`region` varchar(50) NULL DEFAULT NULL, ' +
        '`contact_name` varchar(50) NULL DEFAULT NULL, ' +
        '`payout_name` varchar(100) NULL DEFAULT NULL, ' +
        '`payout_account` varchar(100) NULL DEFAULT NULL, ' +
        '`payout_bank` varchar(100) NULL DEFAULT NULL, ' +
        "`status` varchar(10) NOT NULL DEFAULT 'active', " +
        '`must_change_password` tinyint(1) NOT NULL DEFAULT 1, ' +
        '`token_version` int NOT NULL DEFAULT 0, ' +
        '`micro_carry` bigint NOT NULL DEFAULT 0, ' +
        '`settled_watermark` bigint NOT NULL DEFAULT 0, ' +
        '`pending_settlement_id` bigint NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_agent_phone` (`phone`), ' +
        'KEY `idx_agent_parent` (`parent_id`), ' +
        'KEY `idx_agent_status` (`status`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_invite_codes` (' +
        '`code` varchar(16) NOT NULL, ' +
        '`agent_id` varchar(40) NOT NULL, ' +
        "`status` varchar(10) NOT NULL DEFAULT 'active', " +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`code`), ' +
        'KEY `idx_code_agent` (`agent_id`, `status`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_bindings` (' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`agent_id` varchar(40) NOT NULL, ' +
        '`bound_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`source` varchar(10) NOT NULL, ' +
        '`bound_by` varchar(50) NULL DEFAULT NULL, ' +
        '`phone_hash` char(64) NOT NULL, ' +
        'PRIMARY KEY (`owner_id`), ' +
        'KEY `idx_binding_agent` (`agent_id`, `bound_at`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_binding_history` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`agent_id` varchar(40) NULL DEFAULT NULL, ' +
        '`action` varchar(10) NOT NULL, ' +
        '`actor` varchar(50) NULL DEFAULT NULL, ' +
        '`reason` varchar(255) NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_bh_owner` (`owner_id`, `id`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_rates` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`agent_id` varchar(40) NOT NULL, ' +
        '`rate_bp` int NOT NULL, ' +
        '`actor` varchar(50) NULL DEFAULT NULL, ' +
        '`reason` varchar(255) NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_rate_agent` (`agent_id`, `id`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_status_history` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`agent_id` varchar(40) NOT NULL, ' +
        '`status` varchar(10) NOT NULL, ' +
        '`actor` varchar(50) NULL DEFAULT NULL, ' +
        '`reason` varchar(255) NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_sh_agent` (`agent_id`, `id`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_player_quota` (' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`inflow_total` bigint NOT NULL DEFAULT 0, ' +
        '`consumed_total` bigint NOT NULL DEFAULT 0, ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`owner_id`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_quota_inflows` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`source_op_id` bigint NOT NULL, ' +
        '`amount` int NOT NULL, ' +
        '`matures_at` datetime(3) NOT NULL, ' +
        '`matured_at` datetime(3) NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_qi_op_owner` (`source_op_id`, `owner_id`), ' +
        'KEY `idx_qi_mature` (`matures_at`, `matured_at`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_admin_quota_credits` (' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`day` date NOT NULL, ' +
        '`credited_coins` int NOT NULL DEFAULT 0, ' +
        'PRIMARY KEY (`owner_id`, `day`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_revenue_events` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`agent_id` varchar(40) NULL DEFAULT NULL, ' +
        '`source_op_id` bigint NOT NULL, ' +
        '`fee_amount` int NOT NULL, ' +
        '`base_amount` int NOT NULL DEFAULT 0, ' +
        '`quota_consumed` int NOT NULL DEFAULT 0, ' +
        '`top_rate_bp` int NOT NULL DEFAULT 0, ' +
        '`expected_max_micro` bigint NOT NULL DEFAULT 0, ' +
        '`chain_json` json NULL, ' +
        '`skipped_reason` varchar(20) NULL DEFAULT NULL, ' +
        '`ref_id` varchar(128) NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_re_owner_op` (`source_op_id`, `owner_id`), ' +
        'KEY `idx_re_agent` (`agent_id`, `created_at`), ' +
        'KEY `idx_re_owner` (`owner_id`, `created_at`), ' +
        'KEY `idx_re_skip` (`skipped_reason`, `created_at`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_commission_entries` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`agent_id` varchar(40) NOT NULL, ' +
        '`owner_id` varchar(36) NULL DEFAULT NULL, ' +
        '`revenue_event_id` bigint NULL DEFAULT NULL, ' +
        '`source_op_id` bigint NULL DEFAULT NULL, ' +
        '`kind` varchar(10) NOT NULL, ' +
        '`level` int NOT NULL DEFAULT 0, ' +
        '`rate_bp` int NOT NULL DEFAULT 0, ' +
        '`paid_bp` int NOT NULL DEFAULT 0, ' +
        '`commission_micro` bigint NOT NULL DEFAULT 0, ' +
        '`reason` varchar(255) NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_ce_op_agent` (`source_op_id`, `agent_id`), ' +
        'KEY `idx_ce_agent` (`agent_id`, `id`), ' +
        'KEY `idx_ce_owner` (`owner_id`, `id`), ' +
        'KEY `idx_ce_revenue` (`revenue_event_id`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_settlements` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`settlement_no` varchar(32) NOT NULL, ' +
        '`agent_id` varchar(40) NOT NULL, ' +
        '`client_request_id` varchar(64) NOT NULL, ' +
        "`status` varchar(10) NOT NULL DEFAULT 'pending', " +
        '`from_entry_id` bigint NOT NULL DEFAULT 0, ' +
        '`to_entry_id` bigint NOT NULL DEFAULT 0, ' +
        '`total_micro` bigint NOT NULL DEFAULT 0, ' +
        '`total_coins` bigint NOT NULL DEFAULT 0, ' +
        '`items_count` int NOT NULL DEFAULT 0, ' +
        '`carry_before` bigint NOT NULL DEFAULT 0, ' +
        '`carry_after` bigint NOT NULL DEFAULT 0, ' +
        '`coin_per_yuan` int NOT NULL DEFAULT 100, ' +
        '`payout_json` json NULL, ' +
        '`min_yuan` int NOT NULL DEFAULT 100, ' +
        '`items_hash` char(64) NOT NULL, ' +
        '`requested_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`decided_at` datetime(3) NULL DEFAULT NULL, ' +
        '`decided_by` varchar(50) NULL DEFAULT NULL, ' +
        '`paid_at` datetime(3) NULL DEFAULT NULL, ' +
        '`paid_by` varchar(50) NULL DEFAULT NULL, ' +
        '`voucher_no` varchar(64) NULL DEFAULT NULL, ' +
        '`reject_reason` varchar(255) NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_settlement_no` (`settlement_no`), ' +
        'UNIQUE KEY `uk_settlement_client` (`agent_id`, `client_request_id`), ' +
        'KEY `idx_settle_agent` (`agent_id`, `status`, `id`), ' +
        'KEY `idx_settle_status` (`status`, `id`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_adjustments` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`agent_id` varchar(40) NOT NULL, ' +
        '`delta_micro` bigint NOT NULL, ' +
        '`reason` varchar(255) NOT NULL, ' +
        "`status` varchar(10) NOT NULL DEFAULT 'pending', " +
        '`requested_by` varchar(50) NOT NULL, ' +
        '`approved_by` varchar(50) NULL DEFAULT NULL, ' +
        '`commission_entry_id` bigint NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`decided_at` datetime(3) NULL DEFAULT NULL, ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_adj_agent` (`agent_id`, `status`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_admin_audit` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`actor` varchar(50) NOT NULL, ' +
        '`action` varchar(50) NOT NULL, ' +
        '`target_type` varchar(30) NOT NULL, ' +
        '`target_id` varchar(64) NOT NULL, ' +
        '`before_json` json NULL, ' +
        '`after_json` json NULL, ' +
        '`reason` varchar(255) NULL DEFAULT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_audit_target` (`target_type`, `target_id`, `id`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_ledger_gaps` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`source_op_id` bigint NOT NULL, ' +
        '`owner_id` varchar(36) NULL DEFAULT NULL, ' +
        '`source` varchar(32) NOT NULL, ' +
        '`error` varchar(500) NOT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_gap_op` (`source_op_id`)' +
        suffix,
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `agent_settings_history` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`enabled` tinyint(1) NOT NULL, ' +
        '`effective_from` datetime(3) NULL DEFAULT NULL, ' +
        '`changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`actor` varchar(50) NULL DEFAULT NULL, ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_settings_changed` (`changed_at`)' +
        suffix,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'agent_settings_history',
      'agent_ledger_gaps',
      'agent_admin_audit',
      'agent_adjustments',
      'agent_settlements',
      'agent_commission_entries',
      'agent_revenue_events',
      'agent_admin_quota_credits',
      'agent_quota_inflows',
      'agent_player_quota',
      'agent_status_history',
      'agent_rates',
      'agent_binding_history',
      'agent_bindings',
      'agent_invite_codes',
      'agent_accounts',
      'agent_settings',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
  }
}
