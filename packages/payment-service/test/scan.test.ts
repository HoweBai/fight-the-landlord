/**
 * 支付片 T9：**入账重试扫描 + 恢复 helper 套件**（任务卡 Test: `scan.test.ts`；
 * 规格 §3.4③/§3.6/§2.6 · 设计 §2.5 统一恢复模型）。
 *
 * 覆盖面（十块）：
 *  ① SQL/常量形状：循环③两条读 SQL + 统计 SQL **全文钉**；五锚形（`fundOpAnchor`）逐字；
 *  ② 入账收敛正例：`paid` ⇒ `pay:<orderNo>` apply ⇒ `credited` + `credited_at`（条件更新）
 *     —— 锚/来源/refId/entries **逐字**断言；
 *  ③ 同锚重放：apply 回执 `replayed:true` 同样收敛；已 credited 行不再入循环；
 *  ④ **未知停留**（设计 §2.5①）：apply 传输失败 ⇒ 行留 `paid`、**不改终态**、重试计数 +1、
 *     年龄指标上涨；下一轮同锚重放；最终成功收敛；
 *  ⑤ **明确失败保留 paid**（pay 无 failed 态）：14001 ⇒ 留 paid（credits_at/last_error 不写）、
 *     重试计数照记 —— age 告警转人工（哨兵 = `payment_fundop_oldest_age_seconds`）；
 *  ⑥ 指标写点：`payment_fundop_pending{op=pay}` / `_oldest_age_seconds{op=pay}` /
 *     `_retry_total{op}` + 同读刷 `payment_order_pending{state=paid_uncredited}`；
 *  ⑦ `replayAnchor` 三分类矩阵 + **回滚例外**（设计 §2.5④：`withdraw_rb/refund_rb` 明确失败
 *     ⇒ `rollback_stalled`，**绝不** `definitive_failure`）+ countRetry 语义 + 锚形守卫；
 *  ⑧ `creditOrder` 公开面（notify/sync 即时入账的调用点）：skipped/credited/already/stalled；
 *  ⑨ 定时挂载（本片 T9：一服务两链 = 扫描链 + 日自检链）：间隔 = 配置第 35/36 键
 *     （**排期处现读**；旧 env 注入面已退役）· 首排动作（两链共用**一次**有界等待 + once 闸）·
 *     自重排（慢轮不重叠）· 关停闸覆**两条** timer；`runOnce` 全序 ①②③（循环 ①② 挂 T7 方法）；
 *  ⑩ 模块注册面 + meta 纪律源码钉。
 *
 * 夹具：假 DataSource（精确形状识别——SQL 一漂移即「未识别的 SQL」红）· 假 OrdersService
 * （①/② 计数）· 假 CurrencyRpcClient（apply 可编程回执）。金额/锚语义只在协议面断言。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
// ⚠️ **值导入**：`DataSource` 同时是 DI token（service 构造参）——`import type` 会在运行期 undefined。
import { DataSource } from 'typeorm';
import {
  ErrCode,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
} from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import { ORDER_PAID_TO_CREDITED_SQL } from '../src/orders/order-state';
import type { OrdersService } from '../src/orders/orders.service';
import {
  paymentFundopOldestAgeSeconds,
  paymentFundopPending,
  paymentFundopRetryTotal,
  paymentOrderPending,
} from '../src/metrics/payment.metrics';
import {
  CURRENCY_CLIENT_TIMEOUT_MS,
  CurrencyRpcClient,
  CurrencyServiceError,
  isDefinitiveFundOpFailureCode,
} from '../src/rpc/currency.client';
import {
  FUND_OP_ANCHOR_PREFIXES,
  fundOpAnchor,
  isRollbackFundOp,
  replayAnchor,
  ROLLBACK_FUND_OPS,
} from '../src/scan/replay-anchor';
import {
  PAY_RECONCILE_DEFAULT_INTERVAL_MS,
  PAY_SCAN_DEFAULT_INTERVAL_MS,
  PAID_STATS_SQL,
  SELECT_CREDIT_TARGET_SQL,
  SELECT_PAID_ORDERS_SQL,
  ScanService,
} from '../src/scan/scan.service';
import { SNAPSHOT_BOOT_WAIT_MS, type ConfigCacheService } from '../src/config/config-cache.service';
import { UserLockService } from '../src/locks/user-lock.service';
import type { RefundService } from '../src/refund/refund.service';
import type { WithdrawService } from '../src/withdraw/withdraw.service';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const CURRENCY_CLIENT_SRC = readFileSync(join(PACKAGE_DIR, 'src/rpc/currency.client.ts'), 'utf-8');

const USER = 'user-t9-0001';

/* ======================================================================== *
 * ① SQL / 锚形常量（全文钉）
 * ======================================================================== */
describe('① 循环③ SQL 与五锚形（全文钉）', () => {
  it('候选行：status=paid 全量（按 paid_at 先老后新——老的先收敛）', () => {
    expect(SELECT_PAID_ORDERS_SQL).toBe(
      "SELECT `order_no` FROM `payment_orders` WHERE `status` = 'paid' ORDER BY `paid_at` ASC, `id` ASC",
    );
  });

  it('单行读（creditOrder 面：notify/sync 即时入账与循环共用同一读法）', () => {
    expect(SELECT_CREDIT_TARGET_SQL).toBe(
      'SELECT `order_no`, `status`, `user_id`, `coins`, `amount_fen` FROM `payment_orders` WHERE `order_no` = ?',
    );
  });

  it('统计读（pending/age 同查询出：DB 时钟算年龄，单点权威；age 计 COALESCE(paid_at, late_reopen_at)）', () => {
    expect(PAID_STATS_SQL).toBe(
      "SELECT COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(COALESCE(`paid_at`, `late_reopen_at`)), NOW(3)), 0) AS `oldest` FROM `payment_orders` WHERE `status` = 'paid'",
    );
  });

  it('五锚形逐字（设计 §2.4：锚恰 5 形）+ 回滚族判定', () => {
    expect(FUND_OP_ANCHOR_PREFIXES).toEqual({
      pay: 'pay:',
      withdraw_hold: 'withdraw:',
      withdraw_rb: 'withdraw_rb:',
      refund_hold: 'refund:',
      refund_rb: 'refund_rb:',
    });
    expect(fundOpAnchor('pay', 'pay_abc')).toBe('pay:pay_abc');
    expect(fundOpAnchor('withdraw_hold', 'wd_1')).toBe('withdraw:wd_1');
    expect(fundOpAnchor('withdraw_rb', 'wd_1')).toBe('withdraw_rb:wd_1');
    expect(fundOpAnchor('refund_hold', 'rf_1')).toBe('refund:rf_1');
    expect(fundOpAnchor('refund_rb', 'rf_1')).toBe('refund_rb:rf_1');
    expect(ROLLBACK_FUND_OPS).toEqual(['withdraw_rb', 'refund_rb']);
    expect(isRollbackFundOp('pay')).toBe(false);
    expect(isRollbackFundOp('withdraw_rb')).toBe(true);
  });

  it('入账落账 SQL = T7 常量复用（条件更新幂等；不另写一份）', () => {
    expect(ORDER_PAID_TO_CREDITED_SQL).toBe(
      "UPDATE `payment_orders` SET `status`='credited', `credited_at`=NOW(3) WHERE `order_no`=? AND `status`='paid'",
    );
  });
});

/* ======================================================================== *
 * 夹具
 * ======================================================================== */

interface FakePaidRow {
  id: number;
  order_no: string;
  user_id: string;
  status: string;
  coins: number;
  /** 重开行（closed→paid）恒为 NULL——重开 SQL 逐字不含它。 */
  paid_at: Date | null;
  /** 重开行的「进入 paid 时刻」。 */
  late_reopen_at: Date | null;
  credited_at: Date | null;
  last_error: string | null;
}

class FakeScanDb {
  now = new Date('2026-10-06T04:00:00.000Z');
  rows: FakePaidRow[] = [];
  queries: Array<{ sql: string; params: unknown[] }> = [];
  private nextId = 1;

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  seed(over: Partial<FakePaidRow> = {}): FakePaidRow {
    const id = this.nextId++;
    const row: FakePaidRow = {
      id,
      order_no: over.order_no ?? `pay_t9seed${String(id).padStart(4, '0')}`,
      user_id: USER,
      status: 'paid',
      coins: 600,
      paid_at: new Date(this.now.getTime() - 120_000), // 默认「已停留 2 分钟」
      late_reopen_at: null,
      credited_at: null,
      last_error: null,
      ...over,
    };
    this.rows.push(row);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    this.queries.push({ sql, params });
    const nowMs = this.now.getTime();

    if (sql === SELECT_PAID_ORDERS_SQL) {
      return this.rows
        .filter((r) => r.status === 'paid')
        // 与真 SQL 同向：MySQL `ORDER BY paid_at ASC` 对 NULL 置前（重开行先收敛）。
        .sort((a, b) => (a.paid_at?.getTime() ?? -Infinity) - (b.paid_at?.getTime() ?? -Infinity) || a.id - b.id)
        .map((r) => ({ order_no: r.order_no }));
    }
    if (sql === SELECT_CREDIT_TARGET_SQL) {
      const row = this.rows.find((r) => r.order_no === params[0]);
      return row ? [{ order_no: row.order_no, status: row.status, user_id: row.user_id, coins: row.coins }] : [];
    }
    if (sql === ORDER_PAID_TO_CREDITED_SQL) {
      const row = this.rows.find((r) => r.order_no === params[0]);
      if (!row || row.status !== 'paid') return { affectedRows: 0 };
      row.status = 'credited';
      row.credited_at = new Date(nowMs);
      return { affectedRows: 1 };
    }
    if (sql === PAID_STATS_SQL) {
      const paid = this.rows.filter((r) => r.status === 'paid');
      if (paid.length === 0) return [{ cnt: 0, oldest: 0 }];
      // 与真 SQL 同向：进入 paid 的时刻 = COALESCE(paid_at, late_reopen_at)（重开行恒无 paid_at）。
      const entered = paid.map((r) => r.paid_at ?? r.late_reopen_at).filter((d): d is Date => d !== null);
      if (entered.length === 0) return [{ cnt: paid.length, oldest: 0 }];
      const minEntered = Math.min(...entered.map((d) => d.getTime()));
      return [{ cnt: paid.length, oldest: Math.max(0, Math.floor((nowMs - minEntered) / 1000)) }];
    }
    throw new Error(`未识别的 SQL（服务侧语句形状漂移？）：${sql}`);
  }
}

function makeOrders(over: { closeExpired?: () => Promise<number>; sweepCreated?: () => Promise<number> } = {}) {
  const closeExpired = vi.fn(over.closeExpired ?? (async () => 0));
  const sweepCreated = vi.fn(over.sweepCreated ?? (async () => 0));
  return { orders: { closeExpired, sweepCreated } as unknown as OrdersService, closeExpired, sweepCreated };
}

/** T10：`WithdrawService` 的最小替身（循环 ④⑤ 的挂载计数面；业务语义在 withdraw-state 套件）。 */
function makeWithdraw(
  over: { resolveHolding?: () => Promise<number>; rollbackTimeout?: () => Promise<number> } = {},
) {
  const resolveHolding = vi.fn(over.resolveHolding ?? (async () => 0));
  const rollbackTimeout = vi.fn(over.rollbackTimeout ?? (async () => 0));
  return {
    withdraw: { resolveHolding, rollbackTimeout } as unknown as WithdrawService,
    resolveHolding,
    rollbackTimeout,
  };
}

/** T11：`RefundService` 的最小替身（循环 ⑥⑦⑧ 的挂载计数面；业务语义在 refund-state 套件）。 */
function makeRefund(
  over: {
    resolveHolding?: () => Promise<number>;
    rollbackRecovery?: () => Promise<number>;
    replayUnknown?: () => Promise<number>;
  } = {},
) {
  const resolveHolding = vi.fn(over.resolveHolding ?? (async () => 0));
  const rollbackRecovery = vi.fn(over.rollbackRecovery ?? (async () => 0));
  const replayUnknown = vi.fn(over.replayUnknown ?? (async () => 0));
  return {
    refunds: { resolveHolding, rollbackRecovery, replayUnknown } as unknown as RefundService,
    resolveHolding,
    rollbackRecovery,
    replayUnknown,
  };
}

const okApplyData = (req: CurrencyApplyRequest, replayed = false): CurrencyApplyData => ({
  opId: 1,
  actionId: req.actionId,
  entries: req.entries.map((e) => ({ ownerId: e.ownerId, balanceAfter: e.delta })),
  replayed,
});

function makeClient(applyImpl?: (req: CurrencyApplyRequest) => Promise<CurrencyApplyData>) {
  const apply = vi.fn(applyImpl ?? (async (req: CurrencyApplyRequest) => okApplyData(req)));
  return { client: { apply } as unknown as CurrencyRpcClient, apply };
}

/**
 * 假 ConfigCache（本片 T9 起两链消费面五件：两 interval getter + 首排两把手；getter 是
 * `vi.fn`，用例可改值模拟「改键 + 缓存已刷新」。缺省 = 快路径就绪 + 两缺省）。
 * ⚠️ 「构造期不得读间隔」的判别力靠两 getter 句柄的调用计数。
 */
function makeCache(opts: { scanMs?: number; reconcileMs?: number } = {}): {
  cache: ConfigCacheService;
  scanIntervalMs: ReturnType<typeof vi.fn>;
  reconcileIntervalMs: ReturnType<typeof vi.fn>;
} {
  const scanIntervalMs = vi.fn(() => opts.scanMs ?? PAY_SCAN_DEFAULT_INTERVAL_MS);
  const reconcileIntervalMs = vi.fn(() => opts.reconcileMs ?? PAY_RECONCILE_DEFAULT_INTERVAL_MS);
  const cache = {
    scanIntervalMs,
    reconcileIntervalMs,
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
  } as unknown as ConfigCacheService;
  return { cache, scanIntervalMs, reconcileIntervalMs };
}

function makeScan(
  db: FakeScanDb,
  orders: OrdersService,
  client: CurrencyRpcClient,
  withdraw: WithdrawService = makeWithdraw().withdraw,
  refunds: RefundService = makeRefund().refunds,
  configCache: ConfigCacheService = makeCache().cache,
): ScanService {
  return new ScanService(db.dataSource, orders, client, withdraw, refunds, configCache);
}

/** 指标读数（各自直读 —— 与 orders-state.test.ts 的 gaugeValue 同式）。 */
const fundopPending = async (op: string): Promise<number | undefined> =>
  (await paymentFundopPending.get()).values.find((v) => v.labels.op === op)?.value;
const fundopOldest = async (op: string): Promise<number | undefined> =>
  (await paymentFundopOldestAgeSeconds.get()).values.find((v) => v.labels.op === op)?.value;
const fundopRetry = async (op: string): Promise<number | undefined> =>
  (await paymentFundopRetryTotal.get()).values.find((v) => v.labels.op === op)?.value;
const orderPaidUncredited = async (): Promise<number | undefined> =>
  (await paymentOrderPending.get()).values.find((v) => v.labels.state === 'paid_uncredited')?.value;

beforeEach(() => {
  paymentFundopPending.reset();
  paymentFundopOldestAgeSeconds.reset();
  paymentFundopRetryTotal.reset();
  paymentOrderPending.reset();
});

/* ======================================================================== *
 * ② 入账收敛正例
 * ======================================================================== */
describe('② 循环③正例：paid ⇒ apply{pay:<orderNo>} ⇒ credited', () => {
  it('两行收敛：锚/来源/refId/entries 逐字；credited_at 落库；计数与 gauge 归零', async () => {
    const db = new FakeScanDb();
    const a = db.seed({ order_no: 'pay_t9aaa', user_id: 'user-A', coins: 600 });
    const b = db.seed({ order_no: 'pay_t9bbb', user_id: 'user-B', coins: 6800, paid_at: new Date(db.now.getTime() - 60_000) });
    const { orders } = makeOrders();
    const { client, apply } = makeClient();
    const svc = makeScan(db, orders, client);

    const credited = await svc.creditPending();

    expect(credited).toBe(2);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: 'pay:pay_t9aaa', // 锚先于入账（随 apply 请求过线；幂等点在 currency_ops）
      source: 'recharge',
      refId: 'pay_t9aaa',
      entries: [{ ownerId: 'user-A', delta: 600 }],
    });
    expect(apply.mock.calls[1]![0]).toEqual({
      actionId: 'pay:pay_t9bbb',
      source: 'recharge',
      refId: 'pay_t9bbb',
      entries: [{ ownerId: 'user-B', delta: 6800 }],
    });
    expect(a.status).toBe('credited');
    expect(a.credited_at).toEqual(db.now);
    expect(b.status).toBe('credited');
    // §2.6·2 + §2.6·3 写点
    expect(await fundopPending('pay')).toBe(0);
    expect(await fundopOldest('pay')).toBe(0);
    expect(await orderPaidUncredited()).toBe(0);
    // 重试计数：循环内每次重放计一次（两行 ⇒ 2）
    expect(await fundopRetry('pay')).toBe(2);
  });

  it('同锚重放（replayed:true 回执）同样收敛（幂等：成功返回原结果）', async () => {
    const db = new FakeScanDb();
    const row = db.seed({});
    const { orders } = makeOrders();
    const { client } = makeClient(async (req) => okApplyData(req, true));
    const svc = makeScan(db, orders, client);

    expect(await svc.creditPending()).toBe(1);
    expect(row.status).toBe('credited');
  });

  it('入账后重复循环：已 credited 行不再入候选（幂等收敛，零新增 apply）', async () => {
    const db = new FakeScanDb();
    db.seed({});
    const { orders } = makeOrders();
    const { client, apply } = makeClient();
    const svc = makeScan(db, orders, client);

    expect(await svc.creditPending()).toBe(1);
    expect(await svc.creditPending()).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

/* ======================================================================== *
 * ③④ 未知停留 / 明确失败保留 paid
 * ======================================================================== */
describe('③④ 恢复模型①「停留原位」：未知 ⇒ 留 paid 重放；明确失败 ⇒ 留 paid 转人工', () => {
  it('apply 传输未知 ⇒ 行留 paid（不改终态/不写 last_error）、retry+1、age 上涨；下轮重放收敛', async () => {
    const db = new FakeScanDb();
    const row = db.seed({ paid_at: new Date(db.now.getTime() - 120_000) }); // 停留 120s
    const { orders } = makeOrders();
    let fail = true;
    const { client, apply } = makeClient(async (req) => {
      if (fail) throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
      return okApplyData(req);
    });
    const svc = makeScan(db, orders, client);

    // 第 1 轮：未知 ⇒ 停留
    expect(await svc.creditPending()).toBe(0);
    expect(row.status).toBe('paid');
    expect(row.credited_at).toBeNull();
    expect(row.last_error).toBeNull(); // §2.3 写点清单不含入账失败（告警面走 age 指标）
    expect(await fundopRetry('pay')).toBe(1);
    expect(await fundopPending('pay')).toBe(1);
    expect(await fundopOldest('pay')).toBe(120);

    // 第 2 轮：仍未知 ⇒ 再重放（同锚）
    expect(await svc.creditPending()).toBe(0);
    expect(await fundopRetry('pay')).toBe(2);
    expect(apply.mock.calls[1]![0].actionId).toBe(apply.mock.calls[0]![0].actionId);

    // 第 3 轮：远端已好 ⇒ 收敛
    fail = false;
    expect(await svc.creditPending()).toBe(1);
    expect(row.status).toBe('credited');
    expect(await fundopPending('pay')).toBe(0);
    expect(await fundopOldest('pay')).toBe(0);
  });

  it('apply 明确失败（14001 余额不足）⇒ 留 paid（pay 无 failed 态）+ retry 照记（age 告警转人工）', async () => {
    const db = new FakeScanDb();
    const row = db.seed({});
    const { orders } = makeOrders();
    const { client } = makeClient(async () => {
      throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'ownerId=user-t9-0001 余额不足：整批回滚（delta=-1）');
    });
    const svc = makeScan(db, orders, client);

    expect(await svc.creditPending()).toBe(0);
    expect(row.status).toBe('paid'); // 绝不误置任何终态
    expect(row.credited_at).toBeNull();
    expect(await fundopRetry('pay')).toBe(1);
    expect(await fundopPending('pay')).toBe(1);
  });
});

/* ======================================================================== *
 * ⑤ 指标语义（pending / age / retry）
 * ======================================================================== */
describe('⑤ 基金动作指标（§2.6：pending / oldest_age / retry_total）', () => {
  it('无 paid 行 ⇒ pending=0、oldest=0；有行 ⇒ oldest = 最老 paid_at 的年龄（秒）', async () => {
    const db = new FakeScanDb();
    const { orders } = makeOrders();
    const { client } = makeClient();
    const svc = makeScan(db, orders, client);

    await svc.refreshFundOpGauges();
    expect(await fundopPending('pay')).toBe(0);
    expect(await fundopOldest('pay')).toBe(0);
    expect(await orderPaidUncredited()).toBe(0);

    db.seed({ paid_at: new Date(db.now.getTime() - 121_000) }); // 121s
    db.seed({ paid_at: new Date(db.now.getTime() - 60_000) }); // 60s（非最老）
    await svc.refreshFundOpGauges();
    expect(await fundopPending('pay')).toBe(2);
    expect(await fundopOldest('pay')).toBe(121);
    expect(await orderPaidUncredited()).toBe(2); // 同读顺手刷 paid_uncredited（§2.6·2）
  });

  it('重开行（`paid_at=NULL` × `late_reopen_at`=121s 前）计入 age——纯重开积压不再哨兵盲（波 3 评审 🟡-2）', async () => {
    const db = new FakeScanDb();
    const { orders } = makeOrders();
    const { client } = makeClient();
    const svc = makeScan(db, orders, client);

    // 重开行：重开 SQL 逐字不含 `paid_at` ⇒ 进入 paid 的时刻 = `late_reopen_at`
    // （夹具与真 SQL 同向：COALESCE(paid_at, late_reopen_at)）。
    db.seed({ paid_at: null, late_reopen_at: new Date(db.now.getTime() - 121_000) }); // 121s（重开行）
    const normal = db.seed({ paid_at: new Date(db.now.getTime() - 60_000) }); // 60s（非最老）
    await svc.refreshFundOpGauges();
    expect(await fundopPending('pay')).toBe(2);
    expect(await fundopOldest('pay')).toBe(121); // 旧口径（MIN(paid_at) 忽略 NULL）在此恒 0 ⇒ 哨兵静默

    // **纯重开积压**（无任何普通 paid 行）：age 仍须上涨——告警面「>15m ⇒ 响」成立的盲点用例。
    normal.status = 'credited';
    await svc.refreshFundOpGauges();
    expect(await fundopPending('pay')).toBe(1);
    expect(await fundopOldest('pay')).toBe(121);
  });
});

/* ======================================================================== *
 * ⑥ replayAnchor：三分类矩阵 + 回滚例外 + countRetry + 锚形守卫
 * ======================================================================== */
describe('⑥ replayAnchor：同锚重放至明确结果；回滚例外绝不误置终态（设计 §2.5④）', () => {
  const req = { source: 'recharge', refId: 'pay_x', entries: [{ ownerId: 'u1', delta: 1 }] };

  it('applied：成功（含 replayed）⇒ `applied` 原样带 data', async () => {
    const { client } = makeClient(async (r) => okApplyData(r, true));
    const outcome = await replayAnchor(client, 'pay', 'pay:pay_x', req);
    expect(outcome).toEqual({
      kind: 'applied',
      data: expect.objectContaining({ actionId: 'pay:pay_x', replayed: true }),
    });
  });

  it('正向动作（pay/withdraw_hold/refund_hold）明确失败 ⇒ `definitive_failure`（可迁失败终态的面）', async () => {
    for (const op of ['pay', 'withdraw_hold', 'refund_hold'] as const) {
      for (const code of [ErrCode.BAD_PARAM, ErrCode.E_INSUFFICIENT_FUNDS, ErrCode.E_ACTION_CONFLICT]) {
        const { client } = makeClient(async () => {
          throw new CurrencyServiceError(code, `mock-${code}`);
        });
        const outcome = await replayAnchor(client, op, fundOpAnchor(op, 'x1'), req);
        expect(outcome, `${op}/${code}`).toEqual({
          kind: 'definitive_failure',
          code,
          message: `mock-${code}`,
        });
      }
    }
  });

  it('正向动作未知（传输/10007/非预期异常）⇒ `unknown`（停留原位）', async () => {
    const { client } = makeClient(async () => {
      throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
    });
    expect(await replayAnchor(client, 'pay', 'pay:x1', req)).toMatchObject({ kind: 'unknown' });

    const { client: client2 } = makeClient(async () => {
      throw new Error('ECONNREFUSED 172.28.0.11:3104');
    });
    expect(await replayAnchor(client2, 'pay', 'pay:x1', req)).toMatchObject({ kind: 'unknown' });
  });

  it('🔴 回滚例外：withdraw_rb/refund_rb **明确失败** ⇒ `rollback_stalled`（留停留态 + 告警；绝不 `definitive_failure`）', async () => {
    for (const op of ['withdraw_rb', 'refund_rb'] as const) {
      const { client } = makeClient(async () => {
        throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'mock');
      });
      const outcome = await replayAnchor(client, op, fundOpAnchor(op, 'x1'), req);
      expect(outcome, op).toEqual({
        kind: 'rollback_stalled',
        reason: 'definitive_failure',
        code: ErrCode.E_INSUFFICIENT_FUNDS,
        message: 'mock',
      });
      expect(outcome.kind).not.toBe('definitive_failure'); // 误置终态的入口在类型/实现两层都不存在
    }
  });

  it('回滚例外：未知 ⇒ 同样 `rollback_stalled`（reason=unknown，继续 + >1h 告警）', async () => {
    const { client } = makeClient(async () => {
      throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
    });
    expect(await replayAnchor(client, 'withdraw_rb', 'withdraw_rb:x1', req)).toMatchObject({
      kind: 'rollback_stalled',
      reason: 'unknown',
    });
  });

  it('重试计数：默认每次重放计一次；`countRetry:false`（首尝试路径）不计', async () => {
    const { client } = makeClient();
    await replayAnchor(client, 'pay', 'pay:x1', req);
    await replayAnchor(client, 'pay', 'pay:x1', req, { countRetry: false });
    await replayAnchor(client, 'withdraw_rb', 'withdraw_rb:x1', req);
    expect(await fundopRetry('pay')).toBe(1);
    expect(await fundopRetry('withdraw_rb')).toBe(1);
  });

  it('锚形守卫：op 与锚前缀不符 ⇒ 响亮抛（锚恰 5 形是纪律，不是建议）', async () => {
    const { client, apply } = makeClient();
    await expect(replayAnchor(client, 'pay', 'withdraw:wd_1', req)).rejects.toThrow(/形状不符/);
    await expect(replayAnchor(client, 'withdraw_rb', 'withdraw:wd_1', req)).rejects.toThrow(/形状不符/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('明确失败码判别面（isDefinitiveFundOpFailureCode）：恰 10001/14001/14002', () => {
    expect([ErrCode.BAD_PARAM, ErrCode.E_INSUFFICIENT_FUNDS, ErrCode.E_ACTION_CONFLICT].every(isDefinitiveFundOpFailureCode)).toBe(true);
    expect(isDefinitiveFundOpFailureCode(ErrCode.UPSTREAM_UNAVAILABLE)).toBe(false);
    expect(isDefinitiveFundOpFailureCode(ErrCode.E_ENTRY_THRESHOLD)).toBe(false);
  });
});

/* ======================================================================== *
 * ⑦ creditOrder（notify/sync 即时入账的公开面）
 * ======================================================================== */
describe('⑦ creditOrder：单订单即时入账（notify/sync 共用；幂等面全收口）', () => {
  it('非 paid（created/credited/不存在）⇒ skipped、零 apply', async () => {
    const db = new FakeScanDb();
    db.seed({ order_no: 'pay_created', status: 'created' });
    db.seed({ order_no: 'pay_credited', status: 'credited' });
    const { orders } = makeOrders();
    const { client, apply } = makeClient();
    const svc = makeScan(db, orders, client);

    expect(await svc.creditOrder('pay_created')).toBe('skipped');
    expect(await svc.creditOrder('pay_credited')).toBe('skipped');
    expect(await svc.creditOrder('pay_missing')).toBe('skipped');
    expect(apply).not.toHaveBeenCalled();
  });

  it('paid ⇒ credited（即时面默认**不**计重试——首尝试不是重放）；apply 锚逐字', async () => {
    const db = new FakeScanDb();
    const row = db.seed({ order_no: 'pay_now1' });
    const { orders } = makeOrders();
    const { client, apply } = makeClient();
    const svc = makeScan(db, orders, client);

    expect(await svc.creditOrder('pay_now1')).toBe('credited');
    expect(row.status).toBe('credited');
    expect(apply.mock.calls[0]![0].actionId).toBe('pay:pay_now1');
    expect(await fundopRetry('pay')).toBeUndefined(); // 未掷标签（零计数）
    expect(await fundopPending('pay')).toBe(0); // 写点已刷
  });

  it('并发已入账（apply 后行被他人置 credited ⇒ 条件更新 0 行）⇒ already（幂等面）', async () => {
    const db = new FakeScanDb();
    const row = db.seed({ order_no: 'pay_race1' });
    const { orders } = makeOrders();
    const { client } = makeClient(async (req) => {
      row.status = 'credited'; // 竞态：apply 期间他方落账
      row.credited_at = db.now;
      return okApplyData(req);
    });
    const svc = makeScan(db, orders, client);

    expect(await svc.creditOrder('pay_race1')).toBe('already');
  });

  it('apply 明确失败 ⇒ stalled（不抛；失败静默留给扫描——notify/sync 的 success 语义不变）', async () => {
    const db = new FakeScanDb();
    const row = db.seed({ order_no: 'pay_stall1' });
    const { orders } = makeOrders();
    const { client } = makeClient(async () => {
      throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'mock');
    });
    const svc = makeScan(db, orders, client);

    await expect(svc.creditOrder('pay_stall1')).resolves.toBe('stalled');
    expect(row.status).toBe('paid');
  });
});

/* ======================================================================== *
 * ⑧ 定时挂载（两链首排/重排现读/关停闸 · 自重排不重叠 · runOnce 全序）
 * ======================================================================== */
describe('⑧ 定时挂载与 runOnce 全序（两链首排/重排现读/关停闸；循环 ①② 挂 T7 方法、③ 本卡）', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  /** 本用例捕获到的启动行（`afterSnapshotReady` 是唯一打印落点；两链两行都经它）。 */
  const startedLines = (): string[] =>
    logSpy.mock.calls
      .map((args) => String(args[0]))
      .filter(
        (m) => m.includes('Payment scan loop started') || m.includes('Payment reconcile loop started'),
      );

  it('runOnce 全序：closeExpired → sweepCreated → creditPending → ④resolveHolding → ⑤rollbackTimeout → ⑥refunds.resolveHolding → ⑦refunds.rollbackRecovery → ⑧refunds.replayUnknown（返回值汇总）', async () => {
    const db = new FakeScanDb();
    db.seed({});
    const callOrder: string[] = [];
    const { orders } = makeOrders({
      closeExpired: async () => {
        callOrder.push('closeExpired');
        return 1;
      },
      sweepCreated: async () => {
        callOrder.push('sweepCreated');
        return 2;
      },
    });
    const { client } = makeClient();
    const { withdraw } = makeWithdraw({
      resolveHolding: async () => {
        callOrder.push('resolveHolding');
        return 3;
      },
      rollbackTimeout: async () => {
        callOrder.push('rollbackTimeout');
        return 4;
      },
    });
    const { refunds } = makeRefund({
      resolveHolding: async () => {
        callOrder.push('refund.resolveHolding');
        return 5;
      },
      rollbackRecovery: async () => {
        callOrder.push('refund.rollbackRecovery');
        return 6;
      },
      replayUnknown: async () => {
        callOrder.push('refund.replayUnknown');
        return 7;
      },
    });
    const svc = makeScan(db, orders, client, withdraw, refunds);

    const result = await svc.runOnce();
    expect(callOrder).toEqual([
      'closeExpired',
      'sweepCreated',
      'resolveHolding',
      'rollbackTimeout',
      'refund.resolveHolding',
      'refund.rollbackRecovery',
      'refund.replayUnknown',
    ]);
    expect(result).toEqual({
      closed: 1,
      swept: 2,
      credited: 1,
      holdingResolved: 3,
      rolledBack: 4,
      refundHoldingResolved: 5,
      refundRolledBack: 6,
      refundUnknownReplayed: 7,
    });
  });

  it('启动行两行逐字（快路径同帧；⚙️6 格式不变）：扫描链 first round in <解析值>ms + 日自检 first run in 30000ms, interval <解析值>ms', () => {
    vi.useFakeTimers();
    const db = new FakeScanDb();
    const { orders } = makeOrders();
    const { client } = makeClient();
    const { cache, scanIntervalMs: scanRead, reconcileIntervalMs: reconcileRead } = makeCache({
      scanMs: 2_000,
      reconcileMs: 5_000,
    });
    const svc = makeScan(db, orders, client, undefined, undefined, cache);

    // 快路径「真同步」的证明方式 = 本测试全程不 await、不推进定时器：
    // `onModuleInit` 返回时两行**已在 log spy 里**、两串定时器**已挂上**（同帧解析+打+排）。
    svc.onModuleInit();
    expect(startedLines()).toEqual([
      'Payment scan loop started (first round in 2000ms; loops: ① closeExpired ② sweepCreated ③ creditPending ④ resolveHolding ⑤ rollbackTimeout ⑥ refundResolveHolding ⑦ refundRollbackRecovery ⑧ refundUnknownReplay)',
      'Payment reconcile loop started (first run in 30000ms, interval 5000ms; 入账勾稽 + 锚勾稽 ⇒ payment_reconcile_diff)',
    ]);
    expect(scanRead, '两链启动行各恰读一次').toHaveBeenCalledTimes(1);
    expect(reconcileRead).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount(), '两串首轮定时器同帧排定').toBe(2);
    expect(db.queries, '排首轮 ≠ 跑首轮（同帧不得有查询）').toHaveLength(0);

    svc.onApplicationShutdown();
  });

  it('重排现读 · 扫描链（本片核心 ⚙️7）：构造期不读；一轮跑完现读 ⇒ 改值自下一轮收尾起生效、已排定的一轮不撤', async () => {
    vi.useFakeTimers();
    const db = new FakeScanDb();
    const { orders, closeExpired } = makeOrders();
    const { client } = makeClient();
    const { cache, scanIntervalMs: scanRead } = makeCache({ scanMs: 2_000 });
    const svc = makeScan(db, orders, client, undefined, undefined, cache);
    expect(
      scanRead,
      '构造期不得读间隔（旧形态 = 构造期读 env —— 「现读」的判别力靠这个前置态支撑）',
    ).not.toHaveBeenCalled();

    svc.onModuleInit(); // 快路径：同帧两行（扫描链读 #1）+ 两串排定
    expect(scanRead, '启动行恰读一次').toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000); // 首轮 = 一个完整周期后（注入值 2000）
    expect(closeExpired).toHaveBeenCalledTimes(1);
    expect(scanRead, '首轮收尾现读（读 #2）').toHaveBeenCalledTimes(2);

    scanRead.mockReturnValue(5_000); // 改值：已排定的一轮（@+4000）不撤
    await vi.advanceTimersByTimeAsync(1_999);
    expect(closeExpired, '改值不撤已排定的一轮（+3999 时第 2 轮仍未到）').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(closeExpired, '第 2 轮触发点 = 首轮收尾 + 2000（旧值）').toHaveBeenCalledTimes(2);

    // 第 2 轮收尾现读 = 新值 5000 ⇒ 第 3 轮 @+9000（启动期读一次的实现 +6000 就会出第 3 轮）。
    await vi.advanceTimersByTimeAsync(4_999);
    expect(closeExpired, '+8999：第 3 轮未到点（读一次的实现 +6000 已在场）').toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(closeExpired, '第 3 轮触发点 = 第 2 轮收尾 + 5000（现读）').toHaveBeenCalledTimes(3);

    svc.onApplicationShutdown();
    expect(vi.getTimerCount(), '关停后零定时器').toBe(0);
  });

  it('重排现读 · 日自检链（⚙️7）：首跑恒 30s 常数；一轮跑完现读 ⇒ 改值自下一轮收尾起生效', async () => {
    vi.useFakeTimers();
    const db = new FakeScanDb();
    const { orders } = makeOrders();
    const { client } = makeClient();
    const { cache, reconcileIntervalMs: reconcileRead } = makeCache({ reconcileMs: 5_000 });
    const svc = makeScan(db, orders, client, undefined, undefined, cache);
    // 透传真实现：假库不认勾稽 SQL ⇒ 每轮是失败轮（失败不终止循环）—— 恰好同测「失败轮照排」。
    const runSpy = vi.spyOn(svc, 'runReconcileOnce');
    expect(reconcileRead, '构造期不得读间隔').not.toHaveBeenCalled();

    svc.onModuleInit();
    expect(reconcileRead, '启动行恰读一次').toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(runSpy, '29.999s：首跑未到（首跑恒 30s 常数，不受配置影响）').not.toHaveBeenCalled();
    reconcileRead.mockReturnValue(7_000); // 首跑未到就改值 ⇒ 影响首跑收尾的现读
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy, '首跑 @30s').toHaveBeenCalledTimes(1);
    expect(reconcileRead, '首跑收尾现读（读 #2）').toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(6_999);
    expect(
      runSpy,
      '+36999：第 2 轮未到点（现读 7000；启动期读一次的实现在 +35000 就会出第 2 轮）',
    ).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy, '第 2 轮触发点 = 首跑收尾 + 7000（现读）').toHaveBeenCalledTimes(2);

    svc.onApplicationShutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onModuleInit 起循环：按缓存现读的 2000ms 触发（改键注入面）；running 期间**不重叠**；关停闸停排', async () => {
    vi.useFakeTimers();
    const db = new FakeScanDb();
    let releaseSlow!: () => void;
    const slow = new Promise<void>((res) => {
      releaseSlow = res;
    });
    let calls = 0;
    const { orders, closeExpired } = makeOrders({
      closeExpired: async () => {
        calls += 1;
        if (calls === 2) await slow; // 第 2 轮故意悬挂（慢轮）
        return 0;
      },
    });
    const { client } = makeClient();
    const svc = makeScan(db, orders, client, undefined, undefined, makeCache({ scanMs: 2000 }).cache);

    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(closeExpired).toHaveBeenCalledTimes(1);

    // 第 2 轮悬挂：多个周期过去也不得并发起第 3 轮（自重排 = 完成后才排下一个）
    await vi.advanceTimersByTimeAsync(2000);
    expect(closeExpired).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closeExpired).toHaveBeenCalledTimes(2);

    releaseSlow();
    await vi.advanceTimersByTimeAsync(2000);
    expect(closeExpired).toHaveBeenCalledTimes(3);

    svc.onApplicationShutdown();
    expect(vi.getTimerCount(), '两 timer 都被 clear（漏清一条 = 关停后复活）').toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closeExpired).toHaveBeenCalledTimes(3); // 关停后不再排
  });

  it('首排动作三态（两链合一共用一次等待）：晚到（缓存值两行）/超时（缺省两行）/超时后迟到 ⇒ 恰一次（两链各恰一串）', async () => {
    vi.useFakeTimers();
    // 态 1 · 晚到：hasSnapshot=false，快照在等待窗内就绪 ⇒ 两行用缓存值 + 两串各恰一枚 timer。
    {
      const db = new FakeScanDb();
      const { orders } = makeOrders();
      const { client } = makeClient();
      const { cache } = makeCache({ scanMs: 2_000, reconcileMs: 3_000 });
      let resolveWait!: () => void;
      const wait = new Promise<void>((r) => (resolveWait = r));
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => wait;
      const svc = makeScan(db, orders, client, undefined, undefined, cache);

      svc.onModuleInit();
      expect(startedLines(), '等待期：两行都还没打（唯一打印落点 = afterSnapshotReady）').toHaveLength(0);
      expect(vi.getTimerCount(), '有界等待定时器恰一枚（两链共用**一次**等待）').toBe(1);

      resolveWait(); // 快照就绪（早于超时）
      await vi.advanceTimersByTimeAsync(0); // 微任务冲刷：settle ⇒ afterSnapshotReady
      expect(startedLines(), '晚到路：两行启动行同帧打（两链各一行）').toHaveLength(2);
      expect(startedLines()[0], '扫描链 interval 位 = 缓存解析值').toContain('first round in 2000ms');
      expect(startedLines()[1], '日自检：首跑 30s 常数 + 缓存解析值').toContain(
        'first run in 30000ms, interval 3000ms',
      );
      expect(vi.getTimerCount(), '败方等待定时器已清 + 两串各恰一枚 = 2').toBe(2);

      svc.onApplicationShutdown();
    }

    // 态 2 · 超时：等待窗（SNAPSHOT_BOOT_WAIT_MS）到点 ⇒ 按缺省解析两行 + 两串（降级拓扑；下一轮重排自愈）。
    // ⚠️ 启动行捕获是全用例累积的（logSpy 属 describe 级）——计数按累计形态写（态 1 已 2 行）。
    {
      const db = new FakeScanDb();
      const { orders } = makeOrders();
      const { client } = makeClient();
      const { cache } = makeCache(); // 缺省 60000 / 86400000 = 缓存「快照不可用回落种子」的替身
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => new Promise<void>(() => {}); // 永不就绪
      const svc = makeScan(db, orders, client, undefined, undefined, cache);

      svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_BOOT_WAIT_MS - 1);
      expect(startedLines(), '超时前 1ms：仍未（打）新行（有界等待的上界）').toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(startedLines(), '超时到点：两行同帧打（累计 2 + 2）').toHaveLength(4);
      expect(startedLines()[2]).toContain('first round in 60000ms');
      expect(startedLines()[3]).toContain('first run in 30000ms, interval 86400000ms');
      expect(vi.getTimerCount(), '等待定时器已消费 + 两串在挂 = 2').toBe(2);

      svc.onApplicationShutdown();
    }

    // 态 3 · 超时后迟到：once 闸让就绪路 no-op —— 否则两链各双排期（四条链）。
    {
      const db = new FakeScanDb();
      const { orders, closeExpired } = makeOrders();
      const { client } = makeClient();
      const { cache } = makeCache({ scanMs: 2_000, reconcileMs: 3_000 });
      let resolveWait!: () => void;
      const wait = new Promise<void>((r) => (resolveWait = r));
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => wait;
      const svc = makeScan(db, orders, client, undefined, undefined, cache);
      const runSpy = vi.spyOn(svc, 'runReconcileOnce');

      svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_BOOT_WAIT_MS); // 超时路先赢（两行 + 两串）
      expect(startedLines(), '超时到点：累计 4 + 2').toHaveLength(6);

      resolveWait(); // 快照 >10s 迟到
      await vi.advanceTimersByTimeAsync(0);
      expect(startedLines(), 'once 闸：就绪路 no-op（不双打行）').toHaveLength(6);
      expect(vi.getTimerCount(), 'once 闸：不双排期（双链实现这里是 4）').toBe(2);

      // 两链各恰一串：扫描链按注入节拍（不叠跑）；日自检链 @（超时到点 + 30s）恰一跑。
      await vi.advanceTimersByTimeAsync(2_000);
      expect(closeExpired, '恰一条扫描链：+2000 恰跑一轮').toHaveBeenCalledTimes(1);
      expect(runSpy, '日自检链未到 30s').not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(28_000);
      expect(runSpy, '恰一条日自检链：30s 到点恰跑一轮（双链会跑两轮）').toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount(), '两链各自收尾重排 = 2').toBe(2);

      svc.onApplicationShutdown();
    }
  });

  it('首排动作：续体关停闸（等待期间 shutdown ⇒ 两链零排期、零启动行；getTimerCount()===0 终态）', async () => {
    vi.useFakeTimers();
    const db = new FakeScanDb();
    const { orders, closeExpired } = makeOrders();
    const { client } = makeClient();
    const { cache } = makeCache({ scanMs: 2_000 });
    let resolveWait!: () => void;
    const wait = new Promise<void>((r) => (resolveWait = r));
    cache.hasSnapshot = () => false;
    cache.waitForFirstSnapshot = () => wait;
    const svc = makeScan(db, orders, client, undefined, undefined, cache);

    svc.onModuleInit();
    expect(vi.getTimerCount(), '反空测：等待定时器在挂').toBe(1);

    svc.onApplicationShutdown(); // 等待期间关停
    resolveWait(); // 就绪路迟到：settle ⇒ afterSnapshotReady（关停闸在此拦住）
    await vi.advanceTimersByTimeAsync(0);

    expect(startedLines(), '关停闸：迟到的续体不得打两行、不得排期').toHaveLength(0);
    expect(vi.getTimerCount(), '终态：胜方 settle 清掉等待定时器 + 零排期').toBe(0);
    await vi.advanceTimersByTimeAsync(PAY_RECONCILE_DEFAULT_INTERVAL_MS + 1);
    expect(closeExpired, '关停后零轮（无复活链）').toHaveBeenCalledTimes(0);
  });

  it('关停闸覆两链：onModuleInit 后两 timer 齐挂 ⇒ shutdown ⇒ getTimerCount()===0（两条都清）', () => {
    vi.useFakeTimers();
    const db = new FakeScanDb();
    const { orders } = makeOrders();
    const { client } = makeClient();
    const svc = makeScan(db, orders, client);

    svc.onModuleInit(); // 快路径（全程同步）
    expect(vi.getTimerCount(), '两串首轮齐挂').toBe(2);

    svc.onApplicationShutdown();
    expect(vi.getTimerCount(), '两 timer 都被 clear（漏清一条 = 关停后复活）').toBe(0);
  });
});

/* ======================================================================== *
 * ⑨ 模块注册面 + meta 纪律（源码钉）
 * ======================================================================== */
describe('⑨ 注册面与 meta 纪律', () => {
  it('AppModule 注册：ScanService / UserLockService / CurrencyRpcClient ∈ providers（未注册 = 真容器 404/启动崩）', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    // `CurrencyRpcClient` 经 useFactory 对象形态提供（R216）——两种形态都认。
    const hasProvider = (token: unknown): boolean =>
      providers.some(
        (p) =>
          p === token ||
          (typeof p === 'object' && p !== null && (p as { provide?: unknown }).provide === token),
      );
    expect(hasProvider(ScanService)).toBe(true);
    expect(hasProvider(UserLockService)).toBe(true);
    expect(hasProvider(CurrencyRpcClient)).toBe(true);
  });

  it('meta 纪律：currency.client.ts 的唯一发送点带 `...metaFromTrace()`（meta 闸在 room-service/test/meta-on-every-rpc-send.gate.test.ts 全包扫）', () => {
    expect(CURRENCY_CLIENT_SRC).toContain('.send<');
    expect(CURRENCY_CLIENT_SRC).toContain('...metaFromTrace()');
    // 三调用（apply/get/withdrawable）都在场（四处发送 = 本边 3 调用 + config 拷件）
    expect(CURRENCY_CLIENT_SRC).toContain('RPC_PATTERNS.currencyApply');
    expect(CURRENCY_CLIENT_SRC).toContain('RPC_PATTERNS.currencyGet');
    expect(CURRENCY_CLIENT_SRC).toContain('RPC_PATTERNS.currencyWithdrawableGet');
  });

  it('超时纪律：CURRENCY_CLIENT_TIMEOUT_MS = 3000（⚙️2：与 `currency.client.ts:69` 同值）', () => {
    expect(CURRENCY_CLIENT_TIMEOUT_MS).toBe(3000);
  });
});
