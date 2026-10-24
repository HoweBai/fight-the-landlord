import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 支付片 T3（规格 §2.3 DDL **逐字**）：`payment_orders` / `payment_refunds` /
 * `payment_withdrawals` / `payment_notify_log` / `payment_user_locks` 五表。
 *
 * - **编号口径**：1791000000000 晚于四服务全部既有迁移（user `1789400000000-GameRecords`、
 *   config 至 `1790000001000-RiskConfigSeed`、currency `1789600000000`）—— 四服务共库但
 *   迁移表各一份（⚙️1：本服务的迁移表 = `migrations_payment`，见 `database.config.ts`），
 *   编号只用于本表内排序。
 * - **`payment_` 前缀防撞名**：与 user/config/currency 共库（`fight_the_landlord`），
 *   裸 `orders`/`refunds` 这种名字迟早与别家或 DBA 手工表撞车；索引名同样带族前缀
 *   （`idx_orders_*`/`idx_refunds_*`/`idx_withdrawals_*`/`idx_notify_log_*`）。
 * - **⚙️15 幂等槽（DDL 只编码约束，语义在代码侧 §3.6 锁内条件更新）**：
 *   `payment_refunds` 的 `UNIQUE(order_no, active_slot)` 与 `payment_withdrawals` 的
 *   `UNIQUE(user_id, active_slot)` 是两槽的硬闸 —— 在途 = 1；提现终态
 *   （`paid/rejected/timeout_rolled_back/failed`）置 NULL 释放槽；退款 `refunded`
 *   **保留 1**（已退结构标记：一单只退一次），仅 `rejected/failed` 置 NULL。
 *   MySQL 的 UNIQUE 对 NULL 不去重（多行 NULL 可共存）⇒ 槽的释放**依赖
 *   `active_slot` 可空且无 DEFAULT**（写成 NOT NULL/带默认值 ⇒ 终态槽永远释放不了）。
 *   `payment_orders` **不带**槽（下单按 §2.1 复用规则，不设一人一单）。
 * - **`payment_user_locks`**：一人一行的物化锁行（PK = user_id），全局资金串行点
 *   （§3.6）靠对它的行锁实现；`updated_at` 的 `ON UPDATE` 只服务运维直读。
 * - **`payment_notify_log` 仅记「验签通过」件**（§2.3 注）：验签失败只计数+日志
 *   （`payment_notify_total{result="bad_sign"}`，不落库）；写入点在 T8。
 * - **字段写点注**（§2.3）：`last_error`（orders=过期关闭/补单查询失败摘要；
 *   refunds=渠道退款失败摘要；withdrawals=解析/回滚失败摘要）；
 *   `hold_confirmed_at`（refunds/withdrawals：holding→pending 落账时刻，§3.2/§3.3）。
 * - 时间列：`created_at`/`received_at` 全部由**列默认值**承担（INSERT 语句不含它）；
 *   `updated_at` 的 `ON UPDATE CURRENT_TIMESTAMP(3)` 只服务运维直读（wire 不读它）。
 * - **金额全为 int**（分 / 金币整数；无浮点列 —— 金额类改动纪律）。
 *
 * ⚠️ **形状逐字照 `1789600000000-Currency` 先例**：类名 `<Name><timestamp>`、
 * `name` 属性与类名一致、全部 `CREATE TABLE IF NOT EXISTS`（现有库上 `migrationsRun`
 * 可重跑）、charset/collation 与既有表一致（`user_id` 与 `users.id` 同口径）。
 *
 * ⚠️ **down 是 up 的镜像（逆序）**：五表**无外键**，逆序即镜像
 * （user_locks → notify_log → withdrawals → refunds → orders）。
 */
export class Payment1791000000000 implements MigrationInterface {
  name = 'Payment1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ① 订单：`uk_order_no` 是幂等锚；三索引各有主 —— 玩家列表 keyset（user_created）、
    //    过期扫描（status_expires）、补单扫描（status_paid）。
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `payment_orders` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`order_no` varchar(32) NOT NULL, ' +
        '`user_id` varchar(36) NOT NULL, ' +
        '`package_yuan` int NOT NULL, ' +
        '`amount_fen` int NOT NULL, ' +
        '`coins` int NOT NULL, ' +
        '`coin_per_yuan` int NOT NULL, ' +
        "`status` varchar(16) NOT NULL DEFAULT 'created', " +
        "`channel` varchar(16) NOT NULL DEFAULT 'alipay', " +
        '`trade_no` varchar(64) NULL, ' +
        '`expires_at` datetime(3) NOT NULL, ' +
        '`paid_at` datetime(3) NULL, ' +
        '`credited_at` datetime(3) NULL, ' +
        '`closed_at` datetime(3) NULL, ' +
        '`late_reopen_at` datetime(3) NULL, ' +
        '`last_error` varchar(255) NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_order_no` (`order_no`), ' +
        'KEY `idx_orders_user_created` (`user_id`,`created_at`), ' +
        'KEY `idx_orders_status_expires` (`status`,`expires_at`), ' +
        'KEY `idx_orders_status_paid` (`status`,`paid_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    // ② 退款：`uk_refund_no` 幂等锚；`uk_refunds_order_active` = ⚙️15 槽（文件头）。
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `payment_refunds` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`refund_no` varchar(32) NOT NULL, ' +
        '`order_no` varchar(32) NOT NULL, ' +
        '`user_id` varchar(36) NOT NULL, ' +
        '`amount_fen` int NOT NULL, ' +
        '`coins` int NOT NULL, ' +
        "`status` varchar(16) NOT NULL DEFAULT 'holding', " +
        '`reason` varchar(255) NOT NULL, ' +
        '`reviewed_by` varchar(64) NULL, ' +
        '`reviewed_at` datetime(3) NULL, ' +
        '`review_note` varchar(255) NULL, ' +
        '`channel_out_request_no` varchar(64) NOT NULL, ' +
        '`channel_refund_no` varchar(64) NULL, ' +
        '`hold_confirmed_at` datetime(3) NULL, ' +
        '`refunded_at` datetime(3) NULL, ' +
        '`last_error` varchar(255) NULL, ' +
        '`active_slot` tinyint NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_refund_no` (`refund_no`), ' +
        'UNIQUE KEY `uk_refunds_order_active` (`order_no`,`active_slot`), ' +
        'KEY `idx_refunds_user_created` (`user_id`,`created_at`), ' +
        'KEY `idx_refunds_status_created` (`status`,`created_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    // ③ 提现：`uk_withdraw_no` 幂等锚；`uk_withdrawals_user_active` = ⚙️15 槽（一人一在途）。
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `payment_withdrawals` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`withdraw_no` varchar(32) NOT NULL, ' +
        '`user_id` varchar(36) NOT NULL, ' +
        '`coins` int NOT NULL, ' +
        '`amount_fen` int NOT NULL, ' +
        "`status` varchar(24) NOT NULL DEFAULT 'holding', " +
        '`timeout_at` datetime(3) NOT NULL, ' +
        '`hold_confirmed_at` datetime(3) NULL, ' +
        '`reviewed_by` varchar(64) NULL, ' +
        '`reviewed_at` datetime(3) NULL, ' +
        '`review_note` varchar(255) NULL, ' +
        '`confirmed_by` varchar(64) NULL, ' +
        '`confirmed_at` datetime(3) NULL, ' +
        '`voucher` varchar(64) NULL, ' +
        '`confirm_note` varchar(255) NULL, ' +
        '`rolled_back_at` datetime(3) NULL, ' +
        '`rollback_reason` varchar(16) NULL, ' +
        '`last_error` varchar(255) NULL, ' +
        '`active_slot` tinyint NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_withdraw_no` (`withdraw_no`), ' +
        'UNIQUE KEY `uk_withdrawals_user_active` (`user_id`,`active_slot`), ' +
        'KEY `idx_withdrawals_status_timeout` (`status`,`timeout_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    // ④ 回调日志：**仅验签通过件**（失败只计数+日志）；管理详情按 order 回查尾 N 条。
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `payment_notify_log` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`order_no` varchar(32) NOT NULL, ' +
        '`result` varchar(24) NOT NULL, ' +
        '`trade_status` varchar(32) NULL, ' +
        '`amount_fen` int NULL, ' +
        '`raw_payload` text NULL, ' +
        '`client_ip` varchar(64) NULL, ' +
        '`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'KEY `idx_notify_log_order` (`order_no`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    // ⑤ 资金锁行：一人一行（PK = user_id），§3.6 的全局资金串行点靠对它的行锁实现。
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `payment_user_locks` (' +
        '`user_id` varchar(36) NOT NULL, ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`user_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆序：user_locks → notify_log → withdrawals → refunds → orders（见文件头「down 是 up 的镜像」）
    await queryRunner.query('DROP TABLE IF EXISTS `payment_user_locks`');
    await queryRunner.query('DROP TABLE IF EXISTS `payment_notify_log`');
    await queryRunner.query('DROP TABLE IF EXISTS `payment_withdrawals`');
    await queryRunner.query('DROP TABLE IF EXISTS `payment_refunds`');
    await queryRunner.query('DROP TABLE IF EXISTS `payment_orders`');
  }
}
