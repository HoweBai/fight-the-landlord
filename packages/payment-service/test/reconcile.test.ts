/**
 * 支付片 T15：**日自检（入账勾稽 + 锚勾稽）**套件（任务卡 Test；规格 §3.5 / ⚙️16 / ⚙️17；
 * 设计 §8/§10/§14 R12）。
 *
 * 覆盖面（六块）：
 *  ① SQL/常量形状：九条勾稽 SQL **全文钉** + 三常量逐值（默认 86400000 / 首跑 30000 /
 *     窗口 24h——「当日」的滚动落地）；
 *  ② 正例：干净库（零订单/零锚/零流水）⇒ 四项读数全 0 ⇒ `payment_reconcile_diff` = 0；
 *  ③ **脏 SQL 造孤儿锚 ⇒ diff>0 ⇒ 恢复 ⇒ 0**（卡内逐字用例；ops 有锚、本地无行）；
 *  ④ 反向（行无锚）：非法态计入（credited 无 pay: 锚 / 提现与退款「已确认 hold」无 hold 锚 /
 *     rejected 无 rb 锚）；**合法态不计**（created/closed/paid 订单、holding/failed 提现与退款
 *     ——「仅 holding 合法」的结构外延：failed 恒无锚（明确失败=整批回滚），计入会假警）；
 *  ⑤ 入账勾稽：Σ credited.coins ≠ Σ recharge 流水 ⇒ diff = |差|；相等 ⇒ 0；任一勾稽非零 ⇒
 *     总额置 >0（合并口径）；锚勾稽窗口外（created_at 早于 24h）不计入；
 *  ⑥ 定时挂载：启动后 **30s 首跑**（配置只改间隔）· 间隔 = 第 36 键 `pay.reconcileIntervalMs`
 *     （假缓存注入；**排期处现读**）· 自重排 · 关停闸 · 失败轮（响亮 error + **不擦旧值** +
 *     下一轮照排）。
 *
 * 夹具：假 DataSource（精确形状识别——SQL 一漂移即「未识别的 SQL」红；按 24h 窗口如实过滤）·
 * 五个依赖替身 + 假 ConfigCache（本片 T9：两 interval getter + 首排两把手；缺省 = 快路径就绪；
 * 本套件只走 reconcile 面——替身全空实现，照 scan.test.ts 成例）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// ⚠️ **值导入**：`DataSource` 同时是 DI token（service 构造参）——`import type` 会在运行期 undefined。
import { DataSource } from 'typeorm';
import type { OrdersService } from '../src/orders/orders.service';
import { paymentReconcileDiff } from '../src/metrics/payment.metrics';
import type { CurrencyRpcClient } from '../src/rpc/currency.client';
import type { RefundService } from '../src/refund/refund.service';
import type { WithdrawService } from '../src/withdraw/withdraw.service';
import type { ConfigCacheService } from '../src/config/config-cache.service';
import {
  PAY_RECONCILE_DEFAULT_INTERVAL_MS,
  PAY_RECONCILE_FIRST_RUN_DELAY_MS,
  PAY_SCAN_DEFAULT_INTERVAL_MS,
  RECONCILE_CREDITED_SUM_SQL,
  RECONCILE_ORPHAN_PAY_SQL,
  RECONCILE_ORPHAN_REFUND_SQL,
  RECONCILE_ORPHAN_WITHDRAW_SQL,
  RECONCILE_RECHARGE_FLOW_SUM_SQL,
  RECONCILE_UNANCHORED_ORDER_SQL,
  RECONCILE_UNANCHORED_REFUND_HOLD_SQL,
  RECONCILE_UNANCHORED_REFUND_RB_SQL,
  RECONCILE_UNANCHORED_WITHDRAW_HOLD_SQL,
  RECONCILE_UNANCHORED_WITHDRAW_RB_SQL,
  RECONCILE_WINDOW_HOURS,
  ScanService,
} from '../src/scan/scan.service';

/* ======================================================================== *
 * ① SQL / 常量（全文钉）
 * ======================================================================== */
describe('① 勾稽 SQL 与常量（全文钉；规格 §3.5/⚙️17 逐字口径）', () => {
  it('入账勾稽 A 面：Σ credited.coins（全表——不设窗口：「任一勾稽非零」是全局不变量）', () => {
    expect(RECONCILE_CREDITED_SUM_SQL).toBe(
      "SELECT COALESCE(SUM(`coins`), 0) AS `coins` FROM `payment_orders` WHERE `status` = 'credited'",
    );
  });

  it('入账勾稽 B 面：Σ recharge 流水（`source` 在 ops 不在 flows——finance-query 先例 JOIN 写法）', () => {
    expect(RECONCILE_RECHARGE_FLOW_SUM_SQL).toBe(
      "SELECT COALESCE(SUM(f.`delta`), 0) AS `delta` FROM `currency_flows` f JOIN `currency_ops` o ON o.id = f.op_id WHERE o.`source` = 'recharge'",
    );
  });

  it('锚勾稽·孤儿锚三条（有锚无行）：窗口 = 滚动 24h（DB 时钟 NOW(3)——单点权威）', () => {
    expect(RECONCILE_ORPHAN_PAY_SQL).toBe(
      "SELECT COUNT(*) AS `cnt` FROM `currency_ops` o WHERE o.`created_at` >= NOW(3) - INTERVAL 24 HOUR AND o.`action_id` LIKE 'pay:%' AND NOT EXISTS (SELECT 1 FROM `payment_orders` p WHERE CONCAT('pay:', p.`order_no`) = o.`action_id`)",
    );
    expect(RECONCILE_ORPHAN_REFUND_SQL).toBe(
      "SELECT COUNT(*) AS `cnt` FROM `currency_ops` o WHERE o.`created_at` >= NOW(3) - INTERVAL 24 HOUR AND (o.`action_id` LIKE 'refund:%' OR o.`action_id` LIKE 'refund_rb:%') AND NOT EXISTS (SELECT 1 FROM `payment_refunds` r WHERE CONCAT('refund:', r.`refund_no`) = o.`action_id` OR CONCAT('refund_rb:', r.`refund_no`) = o.`action_id`)",
    );
    expect(RECONCILE_ORPHAN_WITHDRAW_SQL).toBe(
      "SELECT COUNT(*) AS `cnt` FROM `currency_ops` o WHERE o.`created_at` >= NOW(3) - INTERVAL 24 HOUR AND (o.`action_id` LIKE 'withdraw:%' OR o.`action_id` LIKE 'withdraw_rb:%') AND NOT EXISTS (SELECT 1 FROM `payment_withdrawals` w WHERE CONCAT('withdraw:', w.`withdraw_no`) = o.`action_id` OR CONCAT('withdraw_rb:', w.`withdraw_no`) = o.`action_id`)",
    );
  });

  it('锚勾稽·行无锚五条（非法态计入；holding/failed 结构豁免——见块④）', () => {
    expect(RECONCILE_UNANCHORED_ORDER_SQL).toBe(
      "SELECT COUNT(*) AS `cnt` FROM `payment_orders` p WHERE p.`created_at` >= NOW(3) - INTERVAL 24 HOUR AND p.`status` = 'credited' AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('pay:', p.`order_no`))",
    );
    expect(RECONCILE_UNANCHORED_WITHDRAW_HOLD_SQL).toBe(
      "SELECT COUNT(*) AS `cnt` FROM `payment_withdrawals` w WHERE w.`created_at` >= NOW(3) - INTERVAL 24 HOUR AND w.`hold_confirmed_at` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('withdraw:', w.`withdraw_no`))",
    );
    expect(RECONCILE_UNANCHORED_WITHDRAW_RB_SQL).toBe(
      "SELECT COUNT(*) AS `cnt` FROM `payment_withdrawals` w WHERE w.`created_at` >= NOW(3) - INTERVAL 24 HOUR AND w.`status` IN ('rejected', 'timeout_rolled_back') AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('withdraw_rb:', w.`withdraw_no`))",
    );
    expect(RECONCILE_UNANCHORED_REFUND_HOLD_SQL).toBe(
      "SELECT COUNT(*) AS `cnt` FROM `payment_refunds` r WHERE r.`created_at` >= NOW(3) - INTERVAL 24 HOUR AND r.`hold_confirmed_at` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('refund:', r.`refund_no`))",
    );
    expect(RECONCILE_UNANCHORED_REFUND_RB_SQL).toBe(
      "SELECT COUNT(*) AS `cnt` FROM `payment_refunds` r WHERE r.`created_at` >= NOW(3) - INTERVAL 24 HOUR AND r.`status` = 'rejected' AND NOT EXISTS (SELECT 1 FROM `currency_ops` o WHERE o.`action_id` = CONCAT('refund_rb:', r.`refund_no`))",
    );
  });

  it('三常量逐值（⚙️16：86400000 / 启动后 30s 首跑；窗口 24h）', () => {
    expect(PAY_RECONCILE_DEFAULT_INTERVAL_MS).toBe(86_400_000);
    expect(PAY_RECONCILE_FIRST_RUN_DELAY_MS).toBe(30_000);
    expect(RECONCILE_WINDOW_HOURS).toBe(24);
  });
});

/* ======================================================================== *
 * 夹具（假 DataSource：按 SQL 常量精确识别；窗口按 now-24h 如实过滤）
 * ======================================================================== */
interface FakeOpRow {
  id: number;
  action_id: string;
  source: string;
  created_at: Date;
}
interface FakeOrderRow {
  order_no: string;
  status: string;
  coins: number;
  created_at: Date;
}
interface FakeWithdrawRow {
  withdraw_no: string;
  status: string;
  hold_confirmed_at: Date | null;
  created_at: Date;
}
interface FakeRefundRow {
  refund_no: string;
  status: string;
  hold_confirmed_at: Date | null;
  created_at: Date;
}

class FakeReconcileDb {
  now = new Date('2026-10-06T04:00:00.000Z');
  ops: FakeOpRow[] = [];
  flows: Array<{ op_id: number; delta: number }> = [];
  orders: FakeOrderRow[] = [];
  withdrawals: FakeWithdrawRow[] = [];
  refunds: FakeRefundRow[] = [];
  /** 置为某 SQL 常量 ⇒ 该查询抛（失败轮用例）。 */
  failOn: string | null = null;

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  private nextOpId = 1;

  /** 造一条**当日**锚（默认在窗口内；`ageHours` 拉出窗口用）。 */
  seedOp(actionId: string, opts: { source?: string; ageHours?: number } = {}): FakeOpRow {
    const row: FakeOpRow = {
      id: this.nextOpId++,
      action_id: actionId,
      source: opts.source ?? 'recharge',
      created_at: new Date(this.now.getTime() - (opts.ageHours ?? 0) * 3_600_000),
    };
    this.ops.push(row);
    return row;
  }

  seedOrder(over: Partial<FakeOrderRow> & { order_no: string }): FakeOrderRow {
    const row: FakeOrderRow = {
      status: 'created',
      coins: 600,
      created_at: new Date(this.now.getTime() - 60_000),
      ...over,
    };
    this.orders.push(row);
    return row;
  }

  seedWithdraw(over: Partial<FakeWithdrawRow> & { withdraw_no: string }): FakeWithdrawRow {
    const row: FakeWithdrawRow = {
      status: 'holding',
      hold_confirmed_at: null,
      created_at: new Date(this.now.getTime() - 60_000),
      ...over,
    };
    this.withdrawals.push(row);
    return row;
  }

  seedRefund(over: Partial<FakeRefundRow> & { refund_no: string }): FakeRefundRow {
    const row: FakeRefundRow = {
      status: 'holding',
      hold_confirmed_at: null,
      created_at: new Date(this.now.getTime() - 60_000),
      ...over,
    };
    this.refunds.push(row);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, _params: unknown[] = []): Promise<unknown> {
    if (this.failOn !== null && sql === this.failOn) throw new Error('mock DB failure');
    const windowStart = this.now.getTime() - RECONCILE_WINDOW_HOURS * 3_600_000;
    const inWindow = (d: Date): boolean => d.getTime() >= windowStart;
    const hasOp = (actionId: string): boolean => this.ops.some((o) => o.action_id === actionId);

    if (sql === RECONCILE_CREDITED_SUM_SQL) {
      const coins = this.orders.filter((o) => o.status === 'credited').reduce((acc, o) => acc + o.coins, 0);
      return [{ coins }];
    }
    if (sql === RECONCILE_RECHARGE_FLOW_SUM_SQL) {
      const delta = this.flows
        .filter((f) => this.ops.find((o) => o.id === f.op_id)?.source === 'recharge')
        .reduce((acc, f) => acc + f.delta, 0);
      return [{ delta }];
    }
    if (sql === RECONCILE_ORPHAN_PAY_SQL) {
      const cnt = this.ops.filter(
        (o) => inWindow(o.created_at) && o.action_id.startsWith('pay:') && !this.orders.some((p) => `pay:${p.order_no}` === o.action_id),
      ).length;
      return [{ cnt }];
    }
    if (sql === RECONCILE_ORPHAN_REFUND_SQL) {
      const cnt = this.ops.filter(
        (o) =>
          inWindow(o.created_at)
          && (o.action_id.startsWith('refund:') || o.action_id.startsWith('refund_rb:'))
          && !this.refunds.some((r) => `refund:${r.refund_no}` === o.action_id || `refund_rb:${r.refund_no}` === o.action_id),
      ).length;
      return [{ cnt }];
    }
    if (sql === RECONCILE_ORPHAN_WITHDRAW_SQL) {
      const cnt = this.ops.filter(
        (o) =>
          inWindow(o.created_at)
          && (o.action_id.startsWith('withdraw:') || o.action_id.startsWith('withdraw_rb:'))
          && !this.withdrawals.some((w) => `withdraw:${w.withdraw_no}` === o.action_id || `withdraw_rb:${w.withdraw_no}` === o.action_id),
      ).length;
      return [{ cnt }];
    }
    if (sql === RECONCILE_UNANCHORED_ORDER_SQL) {
      const cnt = this.orders.filter(
        (p) => inWindow(p.created_at) && p.status === 'credited' && !hasOp(`pay:${p.order_no}`),
      ).length;
      return [{ cnt }];
    }
    if (sql === RECONCILE_UNANCHORED_WITHDRAW_HOLD_SQL) {
      const cnt = this.withdrawals.filter(
        (w) => inWindow(w.created_at) && w.hold_confirmed_at !== null && !hasOp(`withdraw:${w.withdraw_no}`),
      ).length;
      return [{ cnt }];
    }
    if (sql === RECONCILE_UNANCHORED_WITHDRAW_RB_SQL) {
      const cnt = this.withdrawals.filter(
        (w) =>
          inWindow(w.created_at)
          && ['rejected', 'timeout_rolled_back'].includes(w.status)
          && !hasOp(`withdraw_rb:${w.withdraw_no}`),
      ).length;
      return [{ cnt }];
    }
    if (sql === RECONCILE_UNANCHORED_REFUND_HOLD_SQL) {
      const cnt = this.refunds.filter(
        (r) => inWindow(r.created_at) && r.hold_confirmed_at !== null && !hasOp(`refund:${r.refund_no}`),
      ).length;
      return [{ cnt }];
    }
    if (sql === RECONCILE_UNANCHORED_REFUND_RB_SQL) {
      const cnt = this.refunds.filter(
        (r) => inWindow(r.created_at) && r.status === 'rejected' && !hasOp(`refund_rb:${r.refund_no}`),
      ).length;
      return [{ cnt }];
    }
    throw new Error(`未识别的 SQL（服务侧语句形状漂移？）：${sql}`);
  }
}

/**
 * 假 ConfigCache（本片 T9：两 interval getter + 首排两把手；缺省 = 快路径就绪 + 两缺省
 * ——`scanIntervalMs` 也被扫描链启动行消费）。构造替身五件树成 ScanService 第六参形状。
 */
function makeCache(reconcileMs: number = PAY_RECONCILE_DEFAULT_INTERVAL_MS): ConfigCacheService {
  return {
    scanIntervalMs: () => PAY_SCAN_DEFAULT_INTERVAL_MS,
    reconcileIntervalMs: () => reconcileMs,
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
  } as unknown as ConfigCacheService;
}

/** 五个依赖的最小替身 + 假缓存（本套件只走 reconcile 面——前四个全空实现）。 */
function makeScan(db: FakeReconcileDb, configCache: ConfigCacheService = makeCache()): ScanService {
  const orders = {} as unknown as OrdersService;
  const client = {} as unknown as CurrencyRpcClient;
  const withdraw = {} as unknown as WithdrawService;
  const refunds = {} as unknown as RefundService;
  return new ScanService(db.dataSource, orders, client, withdraw, refunds, configCache);
}

/** `payment_reconcile_diff` 当前读数（无样本 ⇒ undefined）。 */
async function gaugeValue(): Promise<number | undefined> {
  return (await paymentReconcileDiff.get()).values[0]?.value;
}

beforeEach(() => {
  paymentReconcileDiff.reset();
});

/* ======================================================================== *
 * ② 正例 / ③ 孤儿锚（卡内逐字） / ④ 反向 / ⑤ 入账勾稽
 * ======================================================================== */
describe('② 正例：干净库 ⇒ 四项全 0 ⇒ gauge = 0', () => {
  it('零订单/零锚/零流水 ⇒ diff = 0 且写点已置（样本在场）', async () => {
    const db = new FakeReconcileDb();
    const svc = makeScan(db);

    const result = await svc.runReconcileOnce();

    expect(result).toEqual({ creditedDiffCoins: 0, orphanAnchors: 0, unanchoredRows: 0, diff: 0 });
    expect(await gaugeValue()).toBe(0);
  });

  it('合法世界（有数据的干净库）：credited↔锚↔行 自洽 + 提现/退款合法态无锚 ⇒ 仍 0', async () => {
    const db = new FakeReconcileDb();
    // 一笔完整充值：订单 credited + pay: 锚 + recharge 流水同额。
    const op = db.seedOp('pay:pay_t15ok1', { source: 'recharge' });
    db.flows.push({ op_id: op.id, delta: 600 });
    db.seedOrder({ order_no: 'pay_t15ok1', status: 'credited' });
    // 合法无锚：created / closed / paid 订单；holding / failed 提现与退款。
    db.seedOrder({ order_no: 'pay_t15new1', status: 'created' });
    db.seedOrder({ order_no: 'pay_t15closed1', status: 'closed' });
    db.seedOrder({ order_no: 'pay_t15paid1', status: 'paid' });
    db.seedWithdraw({ withdraw_no: 'wd_t15hold1', status: 'holding' });
    db.seedWithdraw({ withdraw_no: 'wd_t15fail1', status: 'failed' });
    db.seedRefund({ refund_no: 'rf_t15hold1', status: 'holding' });
    db.seedRefund({ refund_no: 'rf_t15fail1', status: 'failed' });
    const svc = makeScan(db);

    const result = await svc.runReconcileOnce();

    expect(result).toEqual({ creditedDiffCoins: 0, orphanAnchors: 0, unanchoredRows: 0, diff: 0 });
    expect(await gaugeValue()).toBe(0);
  });
});

describe('③ 脏 SQL 造孤儿锚 ⇒ diff>0 ⇒ 恢复 ⇒ 0（卡内逐字用例）', () => {
  it('孤儿 pay: 锚（ops 有锚、本地无行）计入；清掉后回 0', async () => {
    const db = new FakeReconcileDb();
    const svc = makeScan(db);
    expect((await svc.runReconcileOnce()).diff).toBe(0);

    const orphan = db.seedOp('pay:pay_t15orphan1', { source: 'recharge' });
    const dirty = await svc.runReconcileOnce();
    expect(dirty.orphanAnchors).toBe(1);
    expect(dirty.diff).toBeGreaterThan(0);
    expect(await gaugeValue()).toBe(1);

    db.ops = db.ops.filter((o) => o.id !== orphan.id); // 清脏（修复判据=设计 §14 R12）
    const healed = await svc.runReconcileOnce();
    expect(healed).toEqual({ creditedDiffCoins: 0, orphanAnchors: 0, unanchoredRows: 0, diff: 0 });
    expect(await gaugeValue()).toBe(0);
  });

  it('孤儿 refund_rb: / withdraw_rb: 锚（回滚锚同样纳入孤儿面）', async () => {
    const db = new FakeReconcileDb();
    db.seedOp('refund_rb:rf_t15x1');
    db.seedOp('withdraw_rb:wd_t15x1');
    const svc = makeScan(db);

    const result = await svc.runReconcileOnce();

    expect(result.orphanAnchors).toBe(2);
    expect(result.diff).toBe(2);
  });

  it('窗口外孤儿锚（created_at 早于 24h）不计入——「当日」由滚动 24h 承载', async () => {
    const db = new FakeReconcileDb();
    db.seedOp('pay:pay_t15old1', { ageHours: 25 });
    const svc = makeScan(db);

    const result = await svc.runReconcileOnce();

    expect(result.orphanAnchors).toBe(0);
    expect(result.diff).toBe(0);
  });
});

describe('④ 反向（行无锚）：非法态计入；holding/failed 结构豁免', () => {
  it('credited 订单无 pay: 锚 ⇒ 计入（入账=apply 已提交，锚必须在）', async () => {
    const db = new FakeReconcileDb();
    db.seedOrder({ order_no: 'pay_t15un1', status: 'credited' });
    const svc = makeScan(db);

    const result = await svc.runReconcileOnce();

    expect(result.unanchoredRows).toBe(1);
    expect(result.creditedDiffCoins).toBe(600); // 同世界的入账勾稽照算（600 无流水）——分项可分辨
    expect(result.diff).toBe(601);
  });

  it('hold 已确认（hold_confirmed_at 非空）的提现/退款无 hold 锚 ⇒ 计入；holding/failed 无锚 ⇒ 不計', async () => {
    const db = new FakeReconcileDb();
    db.seedWithdraw({ withdraw_no: 'wd_t15p1', status: 'pending', hold_confirmed_at: db.now });
    db.seedRefund({ refund_no: 'rf_t15p1', status: 'pending', hold_confirmed_at: db.now });
    const svc = makeScan(db);

    const result = await svc.runReconcileOnce();

    expect(result.unanchoredRows).toBe(2);
  });

  it('rejected/timeout_rolled_back 提现无 withdraw_rb: 锚 ⇒ 计入；refund rejected 无 refund_rb: 锚 ⇒ 计入；其余态不计', async () => {
    const db = new FakeReconcileDb();
    // hold 锚齐备（隔离出 rb 方向）；rb 锚全缺。
    for (const no of ['wd_t15r1', 'wd_t15r2', 'wd_t15rb']) db.seedOp(`withdraw:${no}`);
    for (const no of ['rf_t15r1', 'rf_t15rj']) db.seedOp(`refund:${no}`);
    db.seedWithdraw({ withdraw_no: 'wd_t15r1', status: 'rejected', hold_confirmed_at: db.now });
    db.seedWithdraw({ withdraw_no: 'wd_t15r2', status: 'timeout_rolled_back', hold_confirmed_at: db.now });
    db.seedRefund({ refund_no: 'rf_t15r1', status: 'rejected', hold_confirmed_at: db.now });
    // rolling_back / rejecting 是「rb 已 claim 未落账」——rb 锚可能尚未存在 ⇒ 结构豁免（不计）。
    db.seedWithdraw({ withdraw_no: 'wd_t15rb', status: 'rolling_back', hold_confirmed_at: db.now });
    db.seedRefund({ refund_no: 'rf_t15rj', status: 'rejecting', hold_confirmed_at: db.now });
    const svc = makeScan(db);

    const result = await svc.runReconcileOnce();

    expect(result.unanchoredRows).toBe(3); // 两条 withdraw_rb 缺锚 + 一条 refund_rb 缺锚
  });

  it('全锚齐备的终态世界 ⇒ 反向全 0（正对照：不该恒红）', async () => {
    const db = new FakeReconcileDb();
    db.seedOp('withdraw:wd_t15ok9');
    db.seedOp('withdraw_rb:wd_t15ok9');
    db.seedWithdraw({ withdraw_no: 'wd_t15ok9', status: 'timeout_rolled_back', hold_confirmed_at: db.now });
    db.seedOp('refund:rf_t15ok9');
    db.seedOp('refund_rb:rf_t15ok9');
    db.seedRefund({ refund_no: 'rf_t15ok9', status: 'rejected', hold_confirmed_at: db.now });
    const svc = makeScan(db);

    const result = await svc.runReconcileOnce();

    expect(result).toEqual({ creditedDiffCoins: 0, orphanAnchors: 0, unanchoredRows: 0, diff: 0 });
  });
});

describe('⑤ 入账勾稽：Σ credited.coins vs Σ recharge 流水', () => {
  it('差额 ⇒ diff = |Δ|；相等 ⇒ 0（任一勾稽非零 ⇒ 总额 >0 的合并口径）', async () => {
    const db = new FakeReconcileDb();
    const op = db.seedOp('pay:pay_t15s1', { source: 'recharge' });
    db.flows.push({ op_id: op.id, delta: 500 });
    db.seedOrder({ order_no: 'pay_t15s1', status: 'credited', coins: 600 });
    const svc = makeScan(db);

    const drift = await svc.runReconcileOnce();
    expect(drift.creditedDiffCoins).toBe(100);
    expect(drift.diff).toBe(100);
    expect(await gaugeValue()).toBe(100);

    db.flows[0]!.delta = 600; // 对齐（修复）
    const healed = await svc.runReconcileOnce();
    expect(healed.diff).toBe(0);
    expect(await gaugeValue()).toBe(0);
  });

  it('非 recharge 源流水不参与入账勾稽（refund/withdraw 源的 ±delta 不进分子）', async () => {
    const db = new FakeReconcileDb();
    const recharge = db.seedOp('pay:pay_t15s2', { source: 'recharge' });
    db.flows.push({ op_id: recharge.id, delta: 600 });
    const refundHold = db.seedOp('refund:rf_t15s2', { source: 'refund_hold' });
    db.flows.push({ op_id: refundHold.id, delta: -600 }); // 退款冻结：source 不同 ⇒ 不影响勾稽；行在场 ⇒ 非孤儿
    db.seedRefund({ refund_no: 'rf_t15s2', status: 'holding' });
    db.seedOrder({ order_no: 'pay_t15s2', status: 'credited', coins: 600 });
    const svc = makeScan(db);

    const result = await svc.runReconcileOnce();

    expect(result.creditedDiffCoins).toBe(0);
    expect(result).toEqual({ creditedDiffCoins: 0, orphanAnchors: 0, unanchoredRows: 0, diff: 0 });
  });
});

/* ======================================================================== *
 * ⑥ 定时挂载（30s 首跑 · 间隔注入 · 自重排 · 关停闸 · 失败轮）
 * ======================================================================== */
describe('⑥ 定时挂载：启动后 30s 首跑 + 假缓存注入的间隔自重排 + 关停闸', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('onModuleInit：30s 首跑（29.999s 不动）；随后按注入间隔 2000ms 自重排；关停后停排', async () => {
    vi.useFakeTimers();
    const db = new FakeReconcileDb();
    const svc = makeScan(db, makeCache(2_000));
    const spy = vi.spyOn(svc, 'runReconcileOnce');

    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(1); // 首跑 = 启动后 30s（配置只改**间隔**）

    await vi.advanceTimersByTimeAsync(2_000);
    expect(spy).toHaveBeenCalledTimes(2); // 自重排：按现读的间隔

    svc.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).toHaveBeenCalledTimes(2); // 关停闸：不再排
  });

  it('失败轮：响亮 error（不擦旧值）+ 下一轮照排（失败不终止循环）', async () => {
    vi.useFakeTimers();
    const db = new FakeReconcileDb();
    const svc = makeScan(db, makeCache(2_000));
    const errorSpy = vi.spyOn((svc as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error');

    // 先跑一轮成功（旧值 = 0，样本在场）。
    await svc.runReconcileOnce();
    expect(await gaugeValue()).toBe(0);

    // 世界变脏（孤儿锚）+ DB 故障注入 ⇒ 失败轮：旧值**不得**被擦成 1，也不得重置。
    db.seedOp('pay:pay_t15fail1');
    db.failOn = RECONCILE_CREDITED_SUM_SQL;
    const spy = vi.spyOn(svc, 'runReconcileOnce');
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await gaugeValue()).toBe(0); // 失败轮保留旧值（宁可陈旧不擦）
    expect(errorSpy).toHaveBeenCalled();

    // 故障恢复 ⇒ 下一轮（自重排）读到脏世界 = 1。
    db.failOn = null;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await gaugeValue()).toBe(1);

    svc.onApplicationShutdown();
  });
});
