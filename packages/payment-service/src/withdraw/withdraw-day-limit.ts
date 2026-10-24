/**
 * 支付片 T13：提现**日限口径**的共享读（规格 §3.2 逐字）——`WithdrawService.apply`
 * （锁内闸，传事务 `manager`）与钱包 summary（`dailyWithdrawRemainingCoins`，传 `dataSource`）
 * **双消费面共用，禁第二实现**（双份口径漂移的症状 = 钱包显示的可申额度与申请闸判的对不上，
 * 只有真流量看得见）。叶子模块（零业务 import）——照 T9 `scan/replay-anchor.ts` 的同款纪律。
 *
 * 口径（§3.2）：归日 = `created_at` 落入 **+08:00 自然日**；计入
 * status ∈ {`holding,pending,approved,paid,rolling_back`}；`rejected/timeout_rolled_back/failed`
 * 不计。时间判定一律 DB `NOW(3)`（单点权威）；`CONVERT_TZ` 偏移写法照 ③ `finance-query` 先例
 * （不依赖 MySQL tz 表）。
 */

/** 日限合计 SQL（参数 `[userId]`；文本自 `withdraw.service.ts` 原文迁入——口径单点）。 */
export const WITHDRAW_DAY_TOTAL_SQL =
  "SELECT COALESCE(SUM(`coins`), 0) AS `total` FROM `payment_withdrawals` WHERE `user_id` = ? AND `status` IN ('holding','pending','approved','paid','rolling_back') AND CONVERT_TZ(`created_at`, '+00:00', '+08:00') >= DATE(CONVERT_TZ(NOW(3), '+00:00', '+08:00')) AND CONVERT_TZ(`created_at`, '+00:00', '+08:00') < DATE(CONVERT_TZ(NOW(3), '+00:00', '+08:00')) + INTERVAL 1 DAY";

/** SQL 执行器的最小面（`DataSource` 与事务 `EntityManager` 共同满足）。 */
export interface SqlQueryExecutor {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * 当日已占（五态合计）——**共享读**；数值列**严格**读取（读不出 ⇒ 响亮抛，
 * 不静默 NaN 进金额/日限路径；口径同各服务的 `toSafeInt`）。
 */
export async function queryWithdrawDayTotal(executor: SqlQueryExecutor, userId: string): Promise<number> {
  const rows = (await executor.query(WITHDRAW_DAY_TOTAL_SQL, [userId])) as Array<{ total?: unknown }>;
  const raw = rows[0]?.total ?? 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`withdrawals.dayTotal：读出的值不是安全整数（收到 ${JSON.stringify(raw)}）`);
  }
  return n;
}

/**
 * 剩余可申额度 = `dailyMax − 当日已占`，**下钳 0**。
 *
 * ⚠️ **实现选择**（卡/规格未钉该边界）：字面式在「已占 > 日上限」（如运营中途调低日限、
 * 存量在途超线）时会产出负值——显示面语义「剩余」不允许负数。下钳只作用于展示值：
 * 申请闸（`dayTotal + coins > max` ⇒ 15004）与 reconcile 口径**不受影响**。
 */
export function remainingDailyWithdrawCoins(dailyMax: number, dayTotal: number): number {
  return Math.max(0, dailyMax - dayTotal);
}
