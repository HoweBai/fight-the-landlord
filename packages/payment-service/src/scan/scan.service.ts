// packages/payment-service/src/scan/scan.service.ts
import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  forwardRef,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { runWithTrace } from '@fight-the-landlord/shared';
import { DataSource } from 'typeorm';
import {
  ConfigCacheService,
  PAY_RECONCILE_DEFAULT_INTERVAL_MS,
  PAY_SCAN_DEFAULT_INTERVAL_MS,
  SNAPSHOT_BOOT_WAIT_MS,
} from '../config/config-cache.service';
import {
  paymentFundopOldestAgeSeconds,
  paymentFundopPending,
  paymentOrderPending,
  paymentReconcileDiff,
  paymentRechargeCreditedTotal,
  paymentRechargeFenTotal,
} from '../metrics/payment.metrics';
import { ORDER_PAID_TO_CREDITED_SQL } from '../orders/order-state';
import { OrdersService } from '../orders/orders.service';
import { RefundService } from '../refund/refund.service';
import { CurrencyRpcClient } from '../rpc/currency.client';
import { WithdrawService } from '../withdraw/withdraw.service';
import { fundOpAnchor, replayAnchor } from './replay-anchor';

/**
 * 支付片 T9：**扫描骨架 + 循环③入账重试**（规格 §3.4③ · §3.6 · §2.6 · ⚙️16；
 * 设计 §2.5 恢复模型的扫描面）。
 *
 * ─── 骨架（本卡）─────────────────────────────────────────────────────────────
 *  - **定时挂载**：间隔 = 配置第 35 键 `pay.scanIntervalMs`（默认 60000；缺键/坏值/快照整体
 *    不可用 ⇒ 回落种子常数 —— 唯一真源 = `ConfigCacheService`；本片 ⚙️5–⚙️7）；
 *    **自重排**（一轮跑完才排下一轮 ⇒ 慢轮天然不重叠；间隔**排期处现读**——改键自该轮收尾
 *    起生效）；关停闸照片⑦/风控 T5 的 `shuttingDown` 成例。首轮在本周期后（= 间隔后）跑。
 *    旧 env 注入面 `PAY_SCAN_INTERVAL_MS` 已退役（本片 ⚙️8）。
 *  - 🔴 **首排动作**（本片 ⚙️5）：`onModuleInit` **同步返回**；`hasSnapshot()` 就绪 ⇒ 同帧
 *    解析+打启动行+排首轮；未就绪 ⇒ 有界等待 `race(首快照, SNAPSHOT_BOOT_WAIT_MS)` ——
 *    超时/就绪两路经 **once 闸**汇入 `afterSnapshotReady()`（至多一次；超时后快照迟到 ⇒
 *    就绪路 no-op，败方定时器清除）。⚠️ **一服务两链合一**：扫描链与日自检链共用**这一次**
 *    等待（`afterSnapshotReady()` 同帧连打两行、连排两串）——各排各的等待会造四条链
 *    （`onApplicationShutdown` 只清得掉两个句柄，另两条复活）。等待发生在**排期面**
 *    （不阻塞容器就绪）。
 *  - **一轮全序**（`runOnce`）：① 过期关闭（T7 `closeExpired`）→ ② 主动查询补单
 *    （T7 `sweepCreated`）→ ③ 入账重试（T9 `creditPending`）→ ④ 提现冻结解析
 *    （T10 `withdraw.resolveHolding`）→ ⑤ 提现超时扫描 + 回滚恢复（T10 `withdraw.rollbackTimeout`）
 *    → ⑥ 退款冻结解析（T11 `refunds.resolveHolding`）→ ⑦ 退款回滚恢复（T11
 *    `refunds.rollbackRecovery`）→ ⑧ 退款**未知结果**低频重放（T11+波 4 `refunds.replayUnknown`；
 *    v1.1.4 §3.3：`unknown:` 标记行每周期 1 发，72h 窗内）。⚠️ fail-fast：任一步抛错（DB 级
 *    故障类）⇒ 本轮中止、error 日志留痕，下一轮（≤周期）自然重试；条件更新幂等（⚙️16）⇒
 *    重复执行安全。
 *
 * ─── 循环③（入账重试）─────────────────────────────────────────────────────────
 *  `status='paid'` ⇒ 重放 `pay:<orderNo>`（`currency.apply{source:'recharge'}`，
 *  **锚先于入账**——锚随 apply 请求过线）⇒ 成功 ⇒ 条件更新 `paid→credited` + `credited_at`
 *  （T7 常量复用；affected=0 = 并发已落账 ⇒ 幂等面）；**结果未知 ⇒ 停留 `paid`**
 *  （原则①）、**明确失败 ⇒ 保留 `paid`**（pay 没有 failed 态；`last_error` 写点清单不含
 *  入账失败——由 age 告警转人工，§2.3/§2.5）。
 *  入账收敛时序硬约束（设计 §4.4）：**先 `paid` 落库、后 apply** —— 即使 apply 永远失败，
 *  钱的事实已在库（可重试可审计）；`paid` 落库点在 T7/T8（回调/补单），本卡只做 apply。
 *
 * ─── 指标写点（§2.6·3/4/5 + 同读刷 §2.6·2）───────────────────────────────────
 *  `payment_fundop_pending{op='pay'}` = `paid` 行数 · `payment_fundop_oldest_age_seconds
 *  {op='pay'}` = 最老 `paid_at` 年龄（秒；无行 ⇒ 0；DB 时钟算——单点权威）·
 *  `payment_fundop_retry_total{op}` 由 `replayAnchor` 在每次重放时计（本文件不重复计）。
 *  同一条统计读顺手刷 `payment_order_pending{state='paid_uncredited'}`（与 op=pay 同数，
 *  保持读数新鲜；T7 的 `refreshOrderPendingGauges` 语义不变）。
 *  T10/T11 的 ④⑤⑥⑦ 循环各自刷 `op ∈ {withdraw_hold,withdraw_rb,refund_hold,refund_rb}`
 *  的 pending/age（同一对 gauge，标签不同）。
 *
 * ─── 日自检（T15；规格 §3.5/⚙️17；`pay.reconcileIntervalMs` 第 36 键）────────────────
 *  与扫描循环**独立**的第二条定时链（`reconcileTimer`；共用关停闸；**首排动作与扫描链
 *  合一共用一次等待** —— 见骨架节）：
 *  - **入账勾稽** = |Σ `payment_orders.coins(status='credited')` − Σ recharge 源流水
 *    `f.delta`（`source` 在 ops 不在 flows——finance-query 先例 JOIN 写法）|（全表；
 *    「任一勾稽非零」是全局不变量，不设窗口）；
 *  - **锚勾稽** = 窗口（**滚动 24h** = ⚙️17「当日」的落地——日跑周期下与「当日」等价
 *    覆盖且无午夜缝；`NOW(3)` 单点权威）内：孤儿锚（ops 有锚、本地无行 ⇒ 计入 +
 *    响亮日志；修复判据=设计 §14 R12）+ 行无锚（**非法态**计入：credited 订单缺 `pay:`
 *    锚 · hold 已确认缺 hold 锚 · rejected/timeout_rolled_back 缺 rb 锚——**holding/failed
 *    结构豁免**：「仅 holding 合法」的字面外延；failed 恒无锚（明确失败=整批回滚），
 *    计入会假警）；
 *  - gauge = 三项之和（**任一非零 ⇒ >0**；分项读数在日志行）；**失败轮不擦旧值**。
 *  ⚠️ 多实例登记（片⑥ 同款口径）：纯读 + per-进程 gauge 置值，幂等、无锁、无选举。
 */

/** 扫描默认周期（规格 ⚙️16：60000ms）—— 唯一真源已迁 `ConfigCacheService`（本片 T4）；此处 re-export 保引用面。 */
export { PAY_SCAN_DEFAULT_INTERVAL_MS };

/** 日自检默认周期（规格 ⚙️16：86400000ms=24h）—— 唯一真源已迁 `ConfigCacheService`（本片 T4）；此处 re-export 保引用面。 */
export { PAY_RECONCILE_DEFAULT_INTERVAL_MS };

/** 日自检**启动后首跑延迟**（⚙️16：30s，照记录片先例——配置面只改**间隔**，不改它）。 */
export const PAY_RECONCILE_FIRST_RUN_DELAY_MS = 30_000;

/**
 * 锚勾稽窗口（小时）：⚙️17「当日」的落地 = **滚动 24h**——日跑周期（默认 24h）下与
 * 「当日」等价覆盖，且免掉「按自然日切窗 + 定时刻日跑」的午夜缝（23:59 产生的锚在两窗
 * 之间会漏检）。边界一律 `NOW(3) - INTERVAL 24 HOUR`——DB 时钟单点权威。
 */
export const RECONCILE_WINDOW_HOURS = 24;

/* ─────────────────────────── 日自检 SQL（⚙️17 逐字口径；全文钉在套件里）─────────────────────────── */

/** 入账勾稽 A 面（⚙️17 逐字）：`Σ payment_orders.coins(status='credited')`。 */
export const RECONCILE_CREDITED_SUM_SQL =
  "SELECT COALESCE(SUM(`coins`), 0) AS `coins` FROM `payment_orders` WHERE `status` = 'credited'";

/**
 * 入账勾稽 B 面（⚙️17 逐字）：recharge 源流水 delta 合计——`source` 在 **ops** 不在 flows
 * （照 `currency-service/src/admin/finance-query.service.ts:55-58` 先例 JOIN 写法）。
 */
export const RECONCILE_RECHARGE_FLOW_SUM_SQL =
  "SELECT COALESCE(SUM(f.`delta`), 0) AS `delta` FROM `currency_flows` f JOIN `currency_ops` o ON o.id = f.op_id WHERE o.`source` = 'recharge'";

/** 孤儿锚三查（有锚无行 ⇒ 计入 diff；窗口内）。 */
export const RECONCILE_ORPHAN_PAY_SQL =
  "SELECT COUNT(*) AS `cnt` FROM `currency_ops` o WHERE o.`created_at` >= NOW(3) - INTERVAL " + RECONCILE_WINDOW_HOURS + " HOUR AND o.`action_id` LIKE 'pay:%' AND NOT EXISTS (SELECT 1 FROM `payment_orders` p WHERE CONCAT('pay:', p.`order_no`) = o.`action_id`)";

export const RECONCILE_ORPHAN_REFUND_SQL =
  "SELECT COUNT(*) AS `cnt` FROM `currency_ops` o WHERE o.`created_at` >= NOW(3) - INTERVAL " + RECONCILE_WINDOW_HOURS + " HOUR AND (o.`action_id` LIKE 'refund:%' OR o.`action_id` LIKE 'refund_rb:%') AND NOT EXISTS (SELECT 1 FROM `payment_refunds` r WHERE CONCAT('refund:', r.`refund_no`) = o.`action_id` OR CONCAT('refund_rb:', r.`refund_no`) = o.`action_id`)";

export const RECONCILE_ORPHAN_WITHDRAW_SQL =
  "SELECT COUNT(*) AS `cnt` FROM `currency_ops` o WHERE o.`created_at` >= NOW(3) - INTERVAL " + RECONCILE_WINDOW_HOURS + " HOUR AND (o.`action_id` LIKE 'withdraw:%' OR o.`action_id` LIKE 'withdraw_rb:%') AND NOT EXISTS (SELECT 1 FROM `payment_withdrawals` w WHERE CONCAT('withdraw:', w.`withdraw_no`) = o.`action_id` OR CONCAT('withdraw_rb:', w.`withdraw_no`) = o.`action_id`)";

/**
 * 行无锚五查（非法态 ⇒ 计入 diff；窗口内）。豁免口径（见文件头）：holding/failed 无锚合法；
 * `rolling_back`/`rejecting` 的 rb 锚「可能未落账」⇒ 结构豁免（rb 方向只看已落账终态）。
 */
export const RECONCILE_UNANCHORED_ORDER_SQL =
  "SELECT COUNT(*) AS `cnt` FROM `payment_orders` p WHERE p.`created_at` >= NOW(3) - INTERVAL " + RECONCILE_WINDOW_HOURS + " HOUR AND p.`status` = 'credited' AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('pay:', p.`order_no`))";

export const RECONCILE_UNANCHORED_WITHDRAW_HOLD_SQL =
  "SELECT COUNT(*) AS `cnt` FROM `payment_withdrawals` w WHERE w.`created_at` >= NOW(3) - INTERVAL " + RECONCILE_WINDOW_HOURS + " HOUR AND w.`hold_confirmed_at` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('withdraw:', w.`withdraw_no`))";

export const RECONCILE_UNANCHORED_WITHDRAW_RB_SQL =
  "SELECT COUNT(*) AS `cnt` FROM `payment_withdrawals` w WHERE w.`created_at` >= NOW(3) - INTERVAL " + RECONCILE_WINDOW_HOURS + " HOUR AND w.`status` IN ('rejected', 'timeout_rolled_back') AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('withdraw_rb:', w.`withdraw_no`))";

export const RECONCILE_UNANCHORED_REFUND_HOLD_SQL =
  "SELECT COUNT(*) AS `cnt` FROM `payment_refunds` r WHERE r.`created_at` >= NOW(3) - INTERVAL " + RECONCILE_WINDOW_HOURS + " HOUR AND r.`hold_confirmed_at` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('refund:', r.`refund_no`))";

export const RECONCILE_UNANCHORED_REFUND_RB_SQL =
  "SELECT COUNT(*) AS `cnt` FROM `payment_refunds` r WHERE r.`created_at` >= NOW(3) - INTERVAL " + RECONCILE_WINDOW_HOURS + " HOUR AND r.`status` = 'rejected' AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('refund_rb:', r.`refund_no`))";

/** 日自检一轮的机械回执（测试/运维/日志用；`diff` = 置入 gauge 的总差异）。 */
export interface ReconcileRoundResult {
  /** 入账勾稽 |Σ credited.coins − Σ recharge 流水|（币）。 */
  creditedDiffCoins: number;
  /** 锚勾稽：孤儿锚（ops 有锚、本地无行）计数。 */
  orphanAnchors: number;
  /** 锚勾稽：行无锚（非法态）计数。 */
  unanchoredRows: number;
  /** 置入 `payment_reconcile_diff` 的总差异（任一勾稽非零 ⇒ >0）。 */
  diff: number;
}

/** 循环③候选：全部 `paid` 行（先老后新——最老的先收敛；量级 = 卡住的行数，无界无虞）。 */
export const SELECT_PAID_ORDERS_SQL =
  "SELECT `order_no` FROM `payment_orders` WHERE `status` = 'paid' ORDER BY `paid_at` ASC, `id` ASC";

/** 单行读（creditOrder：notify/sync 即时入账与循环共用同一读法——**不带 user 条件**）。 */
export const SELECT_CREDIT_TARGET_SQL =
  'SELECT `order_no`, `status`, `user_id`, `coins`, `amount_fen` FROM `payment_orders` WHERE `order_no` = ?';

/**
 * pending/age 同读（DB 时钟算年龄；无 paid 行 ⇒ oldest=0）。
 * 「进入 paid 的时刻」= `COALESCE(paid_at, late_reopen_at)`：重开行恒无 `paid_at`
 * （重开 SQL 逐字不含它）——不取 COALESCE 则纯重开积压的 age 恒 0、哨兵静默（波 3 评审 🟡-2）。
 */
export const PAID_STATS_SQL =
  "SELECT COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(COALESCE(`paid_at`, `late_reopen_at`)), NOW(3)), 0) AS `oldest` FROM `payment_orders` WHERE `status` = 'paid'";

/** `creditOrder` 的处置面（notify/sync 只看 `stalled` 与否——成功语义与它无关）。 */
export type CreditOutcome = 'credited' | 'already' | 'stalled' | 'skipped';

/** 一轮的机械回执（测试/运维/日志用）。 */
export interface ScanRoundResult {
  closed: number;
  swept: number;
  credited: number;
  /** 循环④：本轮提现冻结解析收敛（条件更新命中）行数。 */
  holdingResolved: number;
  /** 循环⑤：本轮提现回滚落账（达终态）行数。 */
  rolledBack: number;
  /** 循环⑥（T11）：本轮退款冻结解析收敛（条件更新命中）行数。 */
  refundHoldingResolved: number;
  /** 循环⑦（T11）：本轮退款回滚落账（达终态）行数。 */
  refundRolledBack: number;
  /** 循环⑧（v1.1.4）：本轮退款未知结果重放**收敛**（达 `refunded`）行数。 */
  refundUnknownReplayed: number;
}

/** 单行读的行形态（列名即 SQL 别名）。 */
interface CreditTargetRow {
  order_no: string;
  status: string;
  user_id: string;
  coins: number | string;
  amount_fen: number | string;
}

/** 条件 UPDATE 的 `affectedRows` 判读（照 orders.service 收紧口径：非整数 ⇒ 抛）。 */
function affectedRowsOf(result: unknown, context: string): number {
  const affected = (result as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof affected !== 'number' || !Number.isInteger(affected) || affected < 0) {
    throw new Error(`${context}：驱动未返回 affectedRows（收到 ${JSON.stringify(result)}）—— 拒绝继续`);
  }
  return affected;
}

/** 数值列 ⇒ 安全整数（读不出 ⇒ 抛，不静默 NaN 进金额路径）。 */
function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/** 统计读的行形态。 */
interface PaidStatsRow {
  cnt?: number | string;
  oldest?: number | string;
}

@Injectable()
export class ScanService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ScanService.name);
  /** 自重排定时器（`setTimeout` 链；风控 T5 同款形态）。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 日自检的自重排定时器（T15；独立链，同一关停闸）。 */
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸：在途一轮的迟到自重排不得复活循环。 */
  private shuttingDown = false;

  /** ⚠️ **值导入**六个依赖（DI 陷阱纪律；`ScanService ⇄ OrdersService` 的环**两侧都用
   *  `forwardRef`** 打断（`OrdersService.scan` 属性注入 ↔ 本类构造注入）——只断一侧的话，
   *  CJS 环下另一侧的装饰器求值会读到半载模块 = 静默 DI 破损。T10 的 `WithdrawService` 与
   *  T11 的 `RefundService` 都单向依赖（各自不反向依赖本类）⇒ 无环、无需 forwardRef；
   *  本片 T9 追加的 `ConfigCacheService` 同向单向（它不反向依赖本类）⇒ 无环，注入照本服务
   *  既有惯例显式 `@Inject`（`OrdersService`/`WithdrawService`/`WalletController` 同款）。 */
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(forwardRef(() => OrdersService)) private readonly orders: OrdersService,
    @Inject(CurrencyRpcClient) private readonly currency: CurrencyRpcClient,
    @Inject(WithdrawService) private readonly withdraw: WithdrawService,
    @Inject(RefundService) private readonly refunds: RefundService,
    @Inject(ConfigCacheService) private readonly configCache: ConfigCacheService,
  ) {}

  onModuleInit(): void {
    // 首排动作（本片 T9 ⚙️5）：两链的首排都经此（判据物两行都须带解析值）。
    this.bootFirstScheduling();
  }

  /**
   * 首排动作（本片 T9 ⚙️5，D2；`onModuleInit` **同步返回**，此处不阻塞容器就绪）：
   * **一服务两链合一**——扫描链与日自检链共用**这一次**有界等待（一次 `settle` ⇒
   * `afterSnapshotReady()` 同帧连打两行、连排两串），绝不各排各的等待。
   *
   * - **快路径（真同步）**：`hasSnapshot()` 就绪 ⇒ 同帧解析+打两行+排两串（不经 await/微任务）；
   * - **有界等待**：未就绪 ⇒ `race(首快照, SNAPSHOT_BOOT_WAIT_MS)` —— 超时/就绪两路经 **once 闸
   *   `settle`** 汇入（先到先赢、后到 no-op、败方定时器清除）。🔴 不可放宽：没有它，「超时后
   *   快照迟到」会二次排期（**四条链** —— `onApplicationShutdown` 只清得掉两个句柄，另两条复活）；
   * - 降级拓扑（配置服务不可用）：≤10s 后按缺省解析先打行排期，下一轮重排自愈。
   */
  private bootFirstScheduling(): void {
    if (this.configCache.hasSnapshot()) {
      this.afterSnapshotReady(); // 快路径：同帧（真同步）
      return;
    }
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.afterSnapshotReady();
    };
    const timeout = setTimeout(settle, SNAPSHOT_BOOT_WAIT_MS);
    void this.configCache.waitForFirstSnapshot().then(settle, settle);
  }

  /**
   * 首排动作**唯一落点**（快/超时/就绪 三路共用；once 闸保证至多一次 —— 见 `bootFirstScheduling`）。
   * 续体先查关停闸（照关停闸纪律）：关停发生在等待期间 ⇒ 迟到的续体不得打行/排期。
   * **两链合一**：同帧连打**两行**启动行（两格式**逐字不变**，解析位 = 缓存值）并分别排首轮 ——
   * 扫描链 `scheduleNext(scan)`（首轮 = 一个完整周期后）、日自检链
   * `scheduleNextReconcile(PAY_RECONCILE_FIRST_RUN_DELAY_MS)`（**配置的是间隔，不是首跑延迟**）。
   */
  private afterSnapshotReady(): void {
    if (this.shuttingDown) return;
    const scan = this.resolveScanIntervalMs();
    this.logger.log(
      `Payment scan loop started (first round in ${scan}ms; loops: ① closeExpired ② sweepCreated ③ creditPending ④ resolveHolding ⑤ rollbackTimeout ⑥ refundResolveHolding ⑦ refundRollbackRecovery ⑧ refundUnknownReplay)`,
    );
    this.scheduleNext(scan);
    this.logger.log(
      `Payment reconcile loop started (first run in ${PAY_RECONCILE_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveReconcileIntervalMs()}ms; 入账勾稽 + 锚勾稽 ⇒ payment_reconcile_diff)`,
    );
    this.scheduleNextReconcile(PAY_RECONCILE_FIRST_RUN_DELAY_MS);
  }

  /** 扫描间隔解析（本片 ⚙️7）：启动行与重排处**同一入口**；内部 = 缓存键级 getter（现读）。 */
  private resolveScanIntervalMs(): number {
    return this.configCache.scanIntervalMs();
  }

  /** 日自检间隔解析（同款；启动行与重排处同一入口 —— ⚙️7）。 */
  private resolveReconcileIntervalMs(): number {
    return this.configCache.reconcileIntervalMs();
  }

  /** 排下一轮（首轮 = 一个完整周期后；自重排 ⇒ 慢轮不重叠）。 */
  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => this.runRound(), delayMs);
  }

  /** 排下一轮日自检（与扫描链同形；独立 timer + 共用关停闸）。 */
  private scheduleNextReconcile(delayMs: number): void {
    this.reconcileTimer = setTimeout(() => this.runReconcileRound(), delayMs);
  }

  /** 定时器起的一轮：ALS 包裹（自建 id + `timer` 来源 ⇒ 下游 RPC 的 meta 带上 traceId）。 */
  private runRound(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      void this.runOnce()
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.error(`payment scan round failed（fail-fast；下一轮重试）: ${reason}`);
        })
        .finally(() => {
          // 关停闸：在途一轮的迟到回执不得在关停后再排定时器；
          // 间隔在**重排处现读**（本片 ⚙️7：改键自该轮收尾排期起生效）。
          if (!this.shuttingDown) this.scheduleNext(this.resolveScanIntervalMs());
        });
    });
  }

  /**
   * 日自检的一轮（定时链入口）：ALS 包裹 → 跑 → 成败都留痕 → 关停闸后自重排。
   * 失败轮**不擦旧值**（gauge 保留上一次读数——宁可陈旧，不把真实差异抹成 0；照记录片
   * 「采样失败保留旧值」同款口径）；失败不终止循环。
   */
  private runReconcileRound(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      void this.runReconcileOnce()
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.error(`payment reconcile round failed（保留旧值；下一轮重试）: ${reason}`);
        })
        .finally(() => {
          // 关停闸：迟到回执不得复活循环；间隔**重排处现读**（本片 ⚙️7）。
          if (!this.shuttingDown) this.scheduleNextReconcile(this.resolveReconcileIntervalMs());
        });
    });
  }

  /**
   * 日自检一轮（**公开**：测试/运维手触发；规格 §3.5/⚙️17）：
   * 入账勾稽（两合计之差）+ 锚勾稽（孤儿锚 + 行无锚计数）⇒ 合计置 `payment_reconcile_diff`
   * ⇒ 日志（非零 ⇒ warn 响亮）。任一步抛错 ⇒ 整轮中止（fail-fast），由 `runReconcileRound`
   * 收日志；**不置 gauge**（调用方据此保留旧值）。
   */
  async runReconcileOnce(): Promise<ReconcileRoundResult> {
    // 入账勾稽（全表；DB 时钟/驱动形态都由 SQL 与 toSafeInt 钉住——读不出 ⇒ 抛，不静默归 0）。
    const creditedRows = (await this.dataSource.query(RECONCILE_CREDITED_SUM_SQL)) as Array<{
      coins?: number | string;
    }>;
    const flowRows = (await this.dataSource.query(RECONCILE_RECHARGE_FLOW_SUM_SQL)) as Array<{
      delta?: number | string;
    }>;
    const creditedSum = toSafeInt(creditedRows[0]?.coins ?? 0, 'reconcile Σ payment_orders.coins');
    const rechargeFlowSum = toSafeInt(flowRows[0]?.delta ?? 0, 'reconcile Σ recharge flows.delta');
    const creditedDiffCoins = Math.abs(creditedSum - rechargeFlowSum);

    // 锚勾稽（孤儿锚三条 + 行无锚五条；COUNT ⇒ 恒单行）。
    const count = async (sql: string, label: string): Promise<number> => {
      const rows = (await this.dataSource.query(sql)) as Array<{ cnt?: number | string }>;
      return toSafeInt(rows[0]?.cnt ?? 0, `reconcile ${label}`);
    };
    const orphanAnchors =
      (await count(RECONCILE_ORPHAN_PAY_SQL, 'orphan pay anchors')) +
      (await count(RECONCILE_ORPHAN_REFUND_SQL, 'orphan refund anchors')) +
      (await count(RECONCILE_ORPHAN_WITHDRAW_SQL, 'orphan withdraw anchors'));
    const unanchoredRows =
      (await count(RECONCILE_UNANCHORED_ORDER_SQL, 'unanchored credited orders')) +
      (await count(RECONCILE_UNANCHORED_WITHDRAW_HOLD_SQL, 'unanchored withdraw holds')) +
      (await count(RECONCILE_UNANCHORED_WITHDRAW_RB_SQL, 'unanchored withdraw rollbacks')) +
      (await count(RECONCILE_UNANCHORED_REFUND_HOLD_SQL, 'unanchored refund holds')) +
      (await count(RECONCILE_UNANCHORED_REFUND_RB_SQL, 'unanchored refund rollbacks'));

    const diff = creditedDiffCoins + orphanAnchors + unanchoredRows;
    paymentReconcileDiff.set(diff);
    const line =
      `payment reconcile done: creditedSum=${creditedSum} rechargeFlowSum=${rechargeFlowSum} ` +
      `creditedDiff=${creditedDiffCoins} orphanAnchors=${orphanAnchors} unanchoredRows=${unanchoredRows} diff=${diff}`;
    if (diff > 0) {
      // 响亮（钱的事故面第一道铃）；修复判据 = 设计 §14 R12（孤儿：同单已有行 ⇒ 回滚孤儿；
      // 无行 ⇒ 补行按冻结事实记 pending）。
      this.logger.warn(`${line}（任一勾稽非零 ⇒ payment_reconcile_diff>0；处置=设计 §14 R12）`);
    } else {
      this.logger.log(line);
    }
    return { creditedDiffCoins, orphanAnchors, unanchoredRows, diff };
  }

  /**
   * 一轮全序（**公开**：测试/运维手触发；T11 的循环 ⑥⑦ 已挂进这里）。
   * 返回本轮机械回执；任一步抛错 ⇒ 整轮中止（fail-fast），由 `runRound` 收日志。
   */
  async runOnce(): Promise<ScanRoundResult> {
    const closed = await this.orders.closeExpired(); // ①
    const swept = await this.orders.sweepCreated(); // ②
    const credited = await this.creditPending(); // ③
    const holdingResolved = await this.withdraw.resolveHolding(); // ④
    const rolledBack = await this.withdraw.rollbackTimeout(); // ⑤
    const refundHoldingResolved = await this.refunds.resolveHolding(); // ⑥
    const refundRolledBack = await this.refunds.rollbackRecovery(); // ⑦
    const refundUnknownReplayed = await this.refunds.replayUnknown(); // ⑧（v1.1.4 §3.3）
    return {
      closed,
      swept,
      credited,
      holdingResolved,
      rolledBack,
      refundHoldingResolved,
      refundRolledBack,
      refundUnknownReplayed,
    };
  }

  /**
   * 循环③：入账重试（见文件头）。返回本轮**条件更新命中（affected=1）的入账行数**
   * ——竞争失败（他方已 credited）与停留/失败都不计。
   */
  async creditPending(): Promise<number> {
    const rows = (await this.dataSource.query(SELECT_PAID_ORDERS_SQL)) as Array<{ order_no: unknown }>;
    let credited = 0;
    for (const row of rows) {
      const outcome = await this.creditOrder(String(row.order_no), { countRetry: true }); // 循环内 = 重放面
      if (outcome === 'credited') credited += 1;
    }
    await this.refreshFundOpGauges();
    return credited;
  }

  /**
   * **单订单即时入账**（notify/sync 的「paid 之后立即尝试入账」与循环③共用；设计 §4.4）。
   *
   * 语义：读现状 → 非 `paid` ⇒ `skipped`（幂等面，零 RPC）；`paid` ⇒ 重放入账锚 ⇒
   * 成功 ⇒ 条件更新 `paid→credited`（affected=0 = 并发已落账 ⇒ `already`）；非成功 ⇒
   * `stalled`（停留 `paid`；日志在 `replayAnchor` 内，**不抛**——调用方「失败静默留给
   * 扫描」）。DB 级异常照抛（调用方各自的 catch 承接：notify/sync 静默 + 下轮扫描）。
   *
   * @param opts.countRetry 默认 **false**（首尝试面：notify/sync 的即时入账不是重放）；
   *        循环③显式传 true。
   */
  async creditOrder(orderNo: string, opts: { countRetry?: boolean } = {}): Promise<CreditOutcome> {
    const rows = (await this.dataSource.query(SELECT_CREDIT_TARGET_SQL, [orderNo])) as CreditTargetRow[];
    const row = rows[0];
    if (!row || row.status !== 'paid') return 'skipped';

    const outcome = await replayAnchor(
      this.currency,
      'pay',
      fundOpAnchor('pay', orderNo),
      {
        source: 'recharge',
        refId: orderNo,
        entries: [{ ownerId: String(row.user_id), delta: toSafeInt(row.coins, 'orders.coins') }],
      },
      { countRetry: opts.countRetry ?? false },
    );

    let result: CreditOutcome;
    if (outcome.kind === 'applied') {
      const updated = await this.dataSource.query(ORDER_PAID_TO_CREDITED_SQL, [orderNo]);
      result = affectedRowsOf(updated, `订单 ${orderNo} paid→credited`) === 1 ? 'credited' : 'already';
      this.logger.log(
        `入账落账 ${orderNo}（opId=${outcome.data.opId} replayed=${outcome.data.replayed}）⇒ ${result === 'credited' ? 'credited' : 'already（并发已落账）'}`,
      );
    } else {
      // 明确失败/未知/回滚例外面（pay 无回滚）——一律停留 `paid`（不迁任何终态）。
      result = 'stalled';
      this.logger.warn(`入账未收敛 ${orderNo}（${outcome.kind}）⇒ 停留 paid，交扫描重试/告警面`);
    }
    if (result === 'credited') {
      paymentRechargeCreditedTotal.inc();
      const fen = Number(row.amount_fen);
      if (Number.isSafeInteger(fen) && fen >= 0) paymentRechargeFenTotal.inc(fen);
    }
    await this.refreshFundOpGauges();
    return result;
  }

  /**
   * `op='pay'` 的 pending/age 刷新（§2.6·3/4）+ 顺手刷 `paid_uncredited`（§2.6·2；
   * 同一条统计读 = 同一读数，两个 gauge 面）。
   */
  async refreshFundOpGauges(): Promise<void> {
    const rows = (await this.dataSource.query(PAID_STATS_SQL)) as PaidStatsRow[];
    const count = Number(rows[0]?.cnt ?? 0);
    const oldest = Number(rows[0]?.oldest ?? 0);
    paymentFundopPending.labels('pay').set(Number.isFinite(count) ? count : 0);
    paymentFundopOldestAgeSeconds.labels('pay').set(Number.isFinite(oldest) ? oldest : 0);
    paymentOrderPending.labels('paid_uncredited').set(Number.isFinite(count) ? count : 0);
  }

  onApplicationShutdown(): void {
    // 第一行置闸：在途一轮的 `.finally` 据此不再排新定时器（照风控 T5/片⑦ 成例）。
    this.shuttingDown = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // T15：日自检链同款关停（同一闸管两条链）。
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }
}
