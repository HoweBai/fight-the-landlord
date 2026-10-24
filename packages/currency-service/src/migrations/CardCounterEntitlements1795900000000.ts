import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 记牌器收费片：权益 / 购买 / 消费三表。
 *
 * - `card_counter_entitlements`：按玩家持有（credits = 单局卡张数；pass_expires_at = 包时到期）；
 * - `card_counter_purchases`：逐笔购买（action_id 唯一 = 幂等锚；kind/hours/credits/price）；
 * - `card_counter_consumptions`：每房每人至多一行（同房二次开局幂等；kind/pass|credit|none）。
 *
 * ⚠️ 类名**不得**匹配 `/^Currency\d+$/`（readdir 抢位防线）；时间戳 > 1795700000000 且全仓唯一。
 */
export class CardCounterEntitlements1795900000000 implements MigrationInterface {
  name = 'CardCounterEntitlements1795900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `card_counter_entitlements` (' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`credits` int NOT NULL DEFAULT 0, ' +
        '`pass_expires_at` datetime(3) NULL, ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`owner_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `card_counter_purchases` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`action_id` varchar(128) NOT NULL, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`kind` varchar(16) NOT NULL, ' +
        '`hours` int NULL, ' +
        '`credits` int NULL, ' +
        '`price` int NOT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_cc_purchase_action` (`action_id`), ' +
        'KEY `idx_cc_purchase_owner` (`owner_id`, `id`), ' +
        'KEY `idx_cc_purchase_created` (`created_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `card_counter_consumptions` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`room_code` varchar(16) NOT NULL, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`seat` int NULL, ' +
        '`kind` varchar(16) NOT NULL, ' +
        '`expires_at` datetime(3) NULL, ' +
        '`trace_id` varchar(64) NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_cc_consume_room_owner` (`room_code`, `owner_id`), ' +
        'KEY `idx_cc_consume_owner` (`owner_id`, `id`), ' +
        'KEY `idx_cc_consume_created` (`created_at`, `kind`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `card_counter_consumptions`');
    await queryRunner.query('DROP TABLE IF EXISTS `card_counter_purchases`');
    await queryRunner.query('DROP TABLE IF EXISTS `card_counter_entitlements`');
  }
}
