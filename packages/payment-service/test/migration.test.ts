/**
 * 支付片 T3（规格 §2.3 / ⚙️15 **逐字**）：五表迁移 `1791000000000-Payment.ts` 的形状。
 *
 * ⚠️ **本仓单测不用真 DB**（不引入数据库依赖）—— 强度靠「执行**真迁移类** + 逐列/逐索引
 * **完整定义**断言」补齐，风格逐字照 `currency-service/test/migration.test.ts` 先例：
 *  - `up()` **恰五条**语句（`toEqual` 逐条）：多建一张表 / 少建一张都当场红；
 *  - 每张表逐列完整定义（`varchar(36) NOT NULL` 这一级），并**反向**核对列数
 *    （不得悄悄多出一列）；
 *  - 索引名与列序**逐字**（如 `` (`user_id`,`created_at`) `` —— 逗号后无空格，照规格原文）；
 *  - `down()` 恰五条 DROP、**逆序**（up 的镜像）；
 *  - 选项层：`migrationsTableName = 'migrations_payment'`（⚙️1，与 user/config/currency
 *    共库的迁移表第四份独立）+ `synchronize: false` + `migrationsRun: true`
 *    （boot.test.ts 已有 T2 同型判据；本文件从迁移面再钉一遍，防两处漂移）。
 *
 * ⚙️15 幂等槽（**语义在代码侧**（§3.6 锁内条件更新；写点属 T10/T11），DDL 只编码约束）：
 *  - refunds `UNIQUE(order_no, active_slot)`：一单同时至多一条在途/已退 —— 在途 = 1；
 *    `refunded` **保留 1**（已退结构标记，硬闸「一单只退一次」）；仅 `rejected/failed`
 *    置 NULL 释放槽；
 *  - withdrawals `UNIQUE(user_id, active_slot)`：一人同时至多一条在途申请；提现终态
 *    （`paid/rejected/timeout_rolled_back/failed`）置 NULL 释放槽；
 *  - MySQL 的 UNIQUE 对 NULL **不去重**（多行 NULL 可共存）⇒ 槽的释放恰恰依赖
 *    `active_slot` 可空 —— 所以「`tinyint NULL` 且**无** DEFAULT」本身就是判据：
 *    若写成 NOT NULL（或给了 DEFAULT），终态无法释放槽、第二笔申请/退款必撞键。
 *
 * ⚠️ 「`migrations_payment` 表里恰记录 1791000000000」的**真读**载体是真栈演练
 * （T3 第 2 步 exec mysql）—— 本文件没有 DB，答案只有「迁移已注册且形状正确」。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { paymentDatabaseOptions } from '../src/database.config';
import { Payment1791000000000 } from '../src/migrations/1791000000000-Payment';

const SRC_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** 记录 SQL 的假 QueryRunner（先例：currency-service `migration.test.ts`）。 */
function recordingRunner() {
  const statements: string[] = [];
  const runner = {
    query: async (sql: string) => {
      statements.push(sql);
      return undefined;
    },
  } as unknown as QueryRunner;
  return { runner, statements };
}

/** 反向核对一张表的键数（PRIMARY KEY / UNIQUE KEY / KEY 三个都算）。 */
function keyCount(sql: string): number {
  return (sql.match(/(PRIMARY KEY|UNIQUE KEY|KEY) `?\w*`? ?\(/g) ?? []).length;
}

/** 反向核对一张表的列数（覆盖五表用到的全部类型词）。 */
function columnCount(sql: string): number | undefined {
  return sql.match(/`\w+` (bigint|varchar|int|text|datetime|tinyint)(\(\d+\))? (NOT NULL|NULL)/g)
    ?.length ?? undefined;
}

describe('支付片 T3：Payment 迁移建出 payment_orders / refunds / withdrawals / notify_log / user_locks 五表（规格 §2.3 逐字）', () => {
  it('① `src/migrations/` 下存在类名匹配 /^Payment\\d+$/ 的迁移，且时间戳为 1791000000000', () => {
    // 从源码提取导出类名（不钉文件路径：改名/挪文件而类名不变时，这条照样有判别力）。
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names, `src/migrations/ 里没有 Payment<时间戳>：${names.join(', ')}`).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Payment\d+$/)]),
    );
    const cls = names.find((name) => /^Payment\d+$/.test(name));
    if (cls === undefined) throw new Error('上一行已断言 —— 本断言不得静默变绿');
    // 编号是**语义**（规格写死 1791000000000；晚于 user/config/currency 全部既有迁移）：
    // 同库四服务迁移表虽各一份，但这条编号是计划/演练命令的引用锚点（T3 真栈证据），改了必须有人主动改这里。
    expect(cls).toBe('Payment1791000000000');
  });

  it('② 选项层：迁移表独立（migrations_payment）+ synchronize 关闭 + migrationsRun 开启', () => {
    const options = paymentDatabaseOptions();

    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(true);
    // ⚙️1：与 user-service（默认 `migrations`）/ config-service（`migrations_config`）/
    // currency-service（`migrations_currency`）**共库** ⇒ 第四份独立迁移表；这条错了类型系统
    // 与单测都看不见，只有真库里四张迁移表互相搅乱时才爆。
    expect(options.migrationsTableName).toBe('migrations_payment');
    const migrations = options.migrations;
    expect(Array.isArray(migrations), 'migrations 必须是列表形态（MixedList 的数组分支）').toBe(true);
    if (!Array.isArray(migrations)) throw new Error('unreachable: 上一行已断言');
    expect(String(migrations[0])).toMatch(/migrations[/\\]\*\.js$/);
  });

  it('③ up()：恰五条 CREATE TABLE IF NOT EXISTS（orders → refunds → withdrawals → notify_log → user_locks）—— 列/索引/charset 逐字对齐（§2.3）', async () => {
    const { runner, statements } = recordingRunner();

    await new Payment1791000000000().up(runner);

    // 恰五条（`toHaveLength`）：多建一表/多塞种子 = 当场红。
    expect(statements).toHaveLength(5);
    const [ordersSql, refundsSql, withdrawalsSql, notifySql, locksSql] = statements as [
      string,
      string,
      string,
      string,
      string,
    ];

    // ── payment_orders（18 列）───────────────────────────────────────────
    // 现有库形态下容器启动可重跑（`migrationsRun`）⇒ 必须 IF NOT EXISTS。
    expect(ordersSql).toContain('CREATE TABLE IF NOT EXISTS `payment_orders`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`order_no` varchar(32) NOT NULL',
      '`user_id` varchar(36) NOT NULL',
      '`package_yuan` int NOT NULL',
      '`amount_fen` int NOT NULL',
      '`coins` int NOT NULL',
      '`coin_per_yuan` int NOT NULL',
      "`status` varchar(16) NOT NULL DEFAULT 'created'",
      "`channel` varchar(16) NOT NULL DEFAULT 'alipay'",
      '`trade_no` varchar(64) NULL',
      '`expires_at` datetime(3) NOT NULL',
      '`paid_at` datetime(3) NULL',
      '`credited_at` datetime(3) NULL',
      '`closed_at` datetime(3) NULL',
      '`late_reopen_at` datetime(3) NULL',
      '`last_error` varchar(255) NULL',
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
    ]) {
      expect(ordersSql, `payment_orders 缺少列定义 ${column}`).toContain(column);
    }
    // 键：PK + 单号唯一（幂等复用的锚）+ 三查询索引（玩家列表 keyset / 扫描族两态）
    expect(ordersSql).toContain('PRIMARY KEY (`id`)');
    expect(ordersSql).toContain('UNIQUE KEY `uk_order_no` (`order_no`)');
    expect(ordersSql).toContain('KEY `idx_orders_user_created` (`user_id`,`created_at`)');
    expect(ordersSql).toContain('KEY `idx_orders_status_expires` (`status`,`expires_at`)');
    expect(ordersSql).toContain('KEY `idx_orders_status_paid` (`status`,`paid_at`)');
    expect(ordersSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：恰 18 列、恰 5 个键（不得悄悄多列/多索引）
    expect(columnCount(ordersSql), 'payment_orders 列数不等于 18').toBe(18);
    expect(keyCount(ordersSql), 'payment_orders 键数不等于 5').toBe(5);

    // ── payment_refunds（19 列）──────────────────────────────────────────
    expect(refundsSql).toContain('CREATE TABLE IF NOT EXISTS `payment_refunds`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`refund_no` varchar(32) NOT NULL',
      '`order_no` varchar(32) NOT NULL',
      '`user_id` varchar(36) NOT NULL',
      '`amount_fen` int NOT NULL',
      '`coins` int NOT NULL',
      "`status` varchar(16) NOT NULL DEFAULT 'holding'",
      '`reason` varchar(255) NOT NULL',
      '`reviewed_by` varchar(64) NULL',
      '`reviewed_at` datetime(3) NULL',
      '`review_note` varchar(255) NULL',
      '`channel_out_request_no` varchar(64) NOT NULL',
      '`channel_refund_no` varchar(64) NULL',
      '`hold_confirmed_at` datetime(3) NULL',
      '`refunded_at` datetime(3) NULL',
      '`last_error` varchar(255) NULL',
      '`active_slot` tinyint NULL',
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
    ]) {
      expect(refundsSql, `payment_refunds 缺少列定义 ${column}`).toContain(column);
    }
    expect(refundsSql).toContain('PRIMARY KEY (`id`)');
    expect(refundsSql).toContain('UNIQUE KEY `uk_refund_no` (`refund_no`)');
    expect(refundsSql).toContain('UNIQUE KEY `uk_refunds_order_active` (`order_no`,`active_slot`)');
    expect(refundsSql).toContain('KEY `idx_refunds_user_created` (`user_id`,`created_at`)');
    expect(refundsSql).toContain('KEY `idx_refunds_status_created` (`status`,`created_at`)');
    expect(refundsSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    expect(columnCount(refundsSql), 'payment_refunds 列数不等于 19').toBe(19);
    expect(keyCount(refundsSql), 'payment_refunds 键数不等于 5').toBe(5);

    // ── payment_withdrawals（21 列）──────────────────────────────────────
    expect(withdrawalsSql).toContain('CREATE TABLE IF NOT EXISTS `payment_withdrawals`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`withdraw_no` varchar(32) NOT NULL',
      '`user_id` varchar(36) NOT NULL',
      '`coins` int NOT NULL',
      '`amount_fen` int NOT NULL',
      "`status` varchar(24) NOT NULL DEFAULT 'holding'",
      '`timeout_at` datetime(3) NOT NULL',
      '`hold_confirmed_at` datetime(3) NULL',
      '`reviewed_by` varchar(64) NULL',
      '`reviewed_at` datetime(3) NULL',
      '`review_note` varchar(255) NULL',
      '`confirmed_by` varchar(64) NULL',
      '`confirmed_at` datetime(3) NULL',
      '`voucher` varchar(64) NULL',
      '`confirm_note` varchar(255) NULL',
      '`rolled_back_at` datetime(3) NULL',
      '`rollback_reason` varchar(16) NULL',
      '`last_error` varchar(255) NULL',
      '`active_slot` tinyint NULL',
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
    ]) {
      expect(withdrawalsSql, `payment_withdrawals 缺少列定义 ${column}`).toContain(column);
    }
    expect(withdrawalsSql).toContain('PRIMARY KEY (`id`)');
    expect(withdrawalsSql).toContain('UNIQUE KEY `uk_withdraw_no` (`withdraw_no`)');
    expect(withdrawalsSql).toContain('UNIQUE KEY `uk_withdrawals_user_active` (`user_id`,`active_slot`)');
    expect(withdrawalsSql).toContain('KEY `idx_withdrawals_status_timeout` (`status`,`timeout_at`)');
    expect(withdrawalsSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    expect(columnCount(withdrawalsSql), 'payment_withdrawals 列数不等于 21').toBe(21);
    expect(keyCount(withdrawalsSql), 'payment_withdrawals 键数不等于 4').toBe(4);

    // ── payment_notify_log（8 列；**仅记验签通过件**，失败只计数+日志 —— 写点在 T8）──
    expect(notifySql).toContain('CREATE TABLE IF NOT EXISTS `payment_notify_log`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`order_no` varchar(32) NOT NULL',
      '`result` varchar(24) NOT NULL',
      '`trade_status` varchar(32) NULL',
      '`amount_fen` int NULL',
      '`raw_payload` text NULL',
      '`client_ip` varchar(64) NULL',
      '`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
    ]) {
      expect(notifySql, `payment_notify_log 缺少列定义 ${column}`).toContain(column);
    }
    expect(notifySql).toContain('PRIMARY KEY (`id`)');
    expect(notifySql).toContain('KEY `idx_notify_log_order` (`order_no`)');
    expect(notifySql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    expect(columnCount(notifySql), 'payment_notify_log 列数不等于 8').toBe(8);
    expect(keyCount(notifySql), 'payment_notify_log 键数不等于 2').toBe(2);

    // ── payment_user_locks（2 列；一人一行 —— 全局资金锁的物化行）─────────
    expect(locksSql).toContain('CREATE TABLE IF NOT EXISTS `payment_user_locks`');
    expect(locksSql).toContain('`user_id` varchar(36) NOT NULL');
    expect(locksSql).toContain(
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
    );
    expect(locksSql).toContain('PRIMARY KEY (`user_id`)');
    expect(locksSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：恰 2 列、只有 PK 一个键（UPDATE 语义的额外索引在此表无意义）
    expect(columnCount(locksSql), 'payment_user_locks 列数不等于 2').toBe(2);
    expect(keyCount(locksSql), 'payment_user_locks 键数不等于 1').toBe(1);
  });

  it('③′ up() 顺序：orders → refunds → withdrawals → notify_log → user_locks —— 依序五条', async () => {
    const { runner, statements } = recordingRunner();
    await new Payment1791000000000().up(runner);
    const tables = statements.map((sql) => /`(payment_\w+)`/.exec(sql)?.[1]);
    expect(tables).toEqual([
      'payment_orders',
      'payment_refunds',
      'payment_withdrawals',
      'payment_notify_log',
      'payment_user_locks',
    ]);
  });

  it('④ down()：恰五条 DROP、逆序（user_locks → notify_log → withdrawals → refunds → orders）—— up 的镜像', async () => {
    const { runner, statements } = recordingRunner();
    await new Payment1791000000000().down(runner);
    // 逐字五条（`toEqual` 而不是 `toContain`）：多删/错序任何一处都当场红。
    expect(statements).toEqual([
      'DROP TABLE IF EXISTS `payment_user_locks`',
      'DROP TABLE IF EXISTS `payment_notify_log`',
      'DROP TABLE IF EXISTS `payment_withdrawals`',
      'DROP TABLE IF EXISTS `payment_refunds`',
      'DROP TABLE IF EXISTS `payment_orders`',
    ]);
  });

  it('⑤ 迁移类满足 TypeORM 的形状（name/up/down）', () => {
    const migration = new Payment1791000000000();
    expect(migration.name).toBe('Payment1791000000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });

  it('⑥ ⚙️15 幂等槽：两条 UNIQUE(order_no|user_id, active_slot) 在列，且 active_slot 可空无 DEFAULT（槽释放的充要形状）', async () => {
    const { runner, statements } = recordingRunner();
    await new Payment1791000000000().up(runner);
    const [ordersSql, refundsSql, withdrawalsSql] = statements as [string, string, string];

    // 在途唯一约束（两个槽的硬闸都在 DDL 层 —— 代码侧条件更新只是常规路径）
    expect(refundsSql).toContain('UNIQUE KEY `uk_refunds_order_active` (`order_no`,`active_slot`)');
    expect(withdrawalsSql).toContain('UNIQUE KEY `uk_withdrawals_user_active` (`user_id`,`active_slot`)');
    // refunds**不得**在 (order_no) 上做全量唯一 —— 否则「拒绝后可再申请、退款后不能再退」
    // 的槽语义（⚙️15）就被过约束；唯一性只挂在带 active_slot 的复合键上。
    expect(refundsSql).not.toMatch(/UNIQUE KEY[^,(]*\(`order_no`\)/);
    expect(withdrawalsSql).not.toMatch(/UNIQUE KEY[^,(]*\(`user_id`\)/);

    // 释放槽依赖 NULL 不撞唯一键 ⇒ active_slot 必须 `tinyint NULL` 且**无** DEFAULT
    expect(refundsSql).toContain('`active_slot` tinyint NULL');
    expect(withdrawalsSql).toContain('`active_slot` tinyint NULL');
    expect(refundsSql, 'active_slot 不得有 DEFAULT（默认值会改变槽语义）').not.toMatch(
      /`active_slot` tinyint[^,]*DEFAULT/,
    );
    expect(withdrawalsSql, 'active_slot 不得有 DEFAULT（默认值会改变槽语义）').not.toMatch(
      /`active_slot` tinyint[^,]*DEFAULT/,
    );
    // orders 表**不带**槽（订单不设一人一单限制，复用规则在代码侧 §2.1）
    expect(ordersSql).not.toContain('active_slot');
  });
});
