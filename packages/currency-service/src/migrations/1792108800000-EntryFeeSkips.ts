import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 台费片 T3：`currency_entry_fee_skips` 表（规格 §2.4b **逐字**；本服务第三迁移）。
 *  - 免单**逐笔记账**（审计表、非资金表；不进管理审计族、不可管理面冲正）；
 *  - 幂等写：`(room_code, owner_id)` 唯一键 + `INSERT IGNORE`（同房二开跨调用防重）；
 *  - `idx_skips_created` 服务财务「台费漏收」块窗口聚合；`idx_skips_room` 服务分房明细 runbook。
 * ⚠️ 类名不得匹配 `/^Currency\d+$/`（`migration.test` 以 readdir 首个匹配取类 ⇒ 抢位假红）；
 * 时间戳 1792108800000 > BurnOnOp 1792022400000（同库内按序执行）。
 */
export class EntryFeeSkips1792108800000 implements MigrationInterface {
  name = 'EntryFeeSkips1792108800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `currency_entry_fee_skips` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`room_code` varchar(16) NOT NULL, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`seat` int NULL, ' +
        '`base_score` int NOT NULL, ' +
        '`fee_amount` int NOT NULL, ' +
        '`reason` varchar(32) NOT NULL, ' +
        '`trace_id` varchar(64) NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_skips_room_owner` (`room_code`, `owner_id`), ' +
        'KEY `idx_skips_created` (`created_at`), ' +
        'KEY `idx_skips_room` (`room_code`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `currency_entry_fee_skips`');
  }
}
