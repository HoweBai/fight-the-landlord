/**
 * 支付片 T13：**玩家钱包读面套件**（任务卡 Test: `wallet.test.ts`；
 * 规格 §2.4.1 #4/#5/#7/#9 · §3.2 日限口径 · §2.7.2；设计 §2.3 玩家 REST 行）。
 *
 * 覆盖面（八块）：
 *  ① 新增 SQL 常量**全文钉**（withdraw/refund 两侧 mine 的 基/游标/排序 三件；日限 SQL 迁址后
 *     文本**逐字不变**——`withdraw.service` 的 re-export 与 day-limit 单点同串）；
 *  ② 日限共享 helper（`remainingDailyWithdrawCoins` 数学含下钳 0 · `queryWithdrawDayTotal`
 *     严格读取（坏形状⇒抛）——**禁第二实现**的机械面）；
 *  ③ 钱包 summary 三字段：`balance`（经 `currency.get`）· `withdrawable`（= cap）·
 *     `dailyWithdrawRemainingCoins`（按 §3.2 日限口径实算：+08:00 自然日 / 五态计入）；
 *  ④ **口径一致钉（复用途）**：summary 的剩余读数与 apply 的日限闸**同源**——申请 X 后
 *     剩余恰减 X；剩余边界（+1 ⇒ 15004 超单日；恰剩余 ⇒ 放行 ⇒ 剩余归 0）；
 *  ⑤ summary 依赖失败 fail-closed（`currency.get`/`withdrawable` 失败 ⇒ 10007/503，
 *     **不伪造读数**）；坏回执（balances 缺条目）⇒ 响亮拒；
 *  ⑥ `refunds/mine` 与 `withdrawals/mine`：keyset（默认 20/上限 50/多取一行判 hasMore/
 *     `nextCursor` 末页 null/非法游标 10001）、只本人、行投影恰十键、状态非状态机值 ⇒ 响亮抛；
 *  ⑦ 控制器真 HTTP（node:http）：summary 200 三字段 / 401 缺身份 / RPC 失败 503；
 *     mine 两端点 200 + 401；
 *  ⑧ 注册面：`WalletController` ∈ AppModule.controllers（未注册 = 单测全绿而真容器 404）。
 *
 * 夹具：**假 DataSource**（精确形状识别——SQL 一漂移即「未识别的 SQL」当场红；锁 SQL 走
 * `transaction()` 面）· 假 currency 客户端（`get`/`withdrawable` 可编程）· 假 ConfigCache。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequestRaw } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { HttpException, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
// ⚠️ **值导入**：`DataSource` 同时是 DI token（探针模块的 provide）。
import { DataSource, type EntityManager } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import type {
  CurrencyApplyData,
  CurrencyApplyRequest,
  PayRefundsPage,
  PayWalletSummary,
  PayWithdrawalsPage,
} from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import { AlipayClient } from '../src/channel/alipay/client';
import {
  COIN_PER_YUAN_DEFAULT,
  ConfigCacheService,
  WITHDRAW_DAILY_MAX_COINS_DEFAULT,
  WITHDRAW_MAX_COINS_PER_ORDER_DEFAULT,
  WITHDRAW_MIN_COINS_DEFAULT,
  WITHDRAW_TIMEOUT_MINUTES_DEFAULT,
} from '../src/config/config-cache.service';
import { HTTP_STATUS } from '../src/http/errors';
import { LOCK_INSERT_IGNORE_SQL, LOCK_SELECT_FOR_UPDATE_SQL, UserLockService } from '../src/locks/user-lock.service';
import { REDIS } from '../src/redis/redis.module';
import { CurrencyRpcClient, CurrencyServiceError, TRANSPORT_FAILURE_MESSAGE } from '../src/rpc/currency.client';
import {
  REFUND_MINE_CURSOR_COND,
  REFUND_MINE_ORDER_LIMIT,
  REFUND_MINE_SELECT_BASE,
  RefundService,
} from '../src/refund/refund.service';
import { RefundController } from '../src/refund/refund.controller';
import {
  INSERT_WITHDRAWAL_SQL,
  UNRESOLVED_HOLDING_SQL,
  WITHDRAW_DAY_TOTAL_SQL,
  WITHDRAW_FUNDOP_STATS_SQL,
  WITHDRAW_HOLD_TO_PENDING_SQL,
  WITHDRAW_MINE_CURSOR_COND,
  WITHDRAW_MINE_ORDER_LIMIT,
  WITHDRAW_MINE_SELECT_BASE,
  WITHDRAW_STATS_SQL,
  WithdrawService,
} from '../src/withdraw/withdraw.service';
import {
  WITHDRAW_DAY_TOTAL_SQL as DAY_LIMIT_SQL,
  queryWithdrawDayTotal,
  remainingDailyWithdrawCoins,
} from '../src/withdraw/withdraw-day-limit';
import { WithdrawController } from '../src/withdraw/withdraw.controller';
import { WalletController } from '../src/wallet/wallet.controller';

const USER = 'user-t13-0001';
const OTHER_USER = 'user-t13-0002';

/* ======================================================================== *
 * ① SQL 常量全文钉（规格 §2.4.1 列表读 / §3.2 日限口径逐字）
 * ======================================================================== */
describe('① SQL 常量全文钉（§2.4.1 #4/#7/#9 + §3.2 日限）', () => {
  it('日限 SQL 迁址后**文本逐字不变**（withdraw.service 的 re-export 与 day-limit 单点同串）', () => {
    const TEXT =
      "SELECT COALESCE(SUM(`coins`), 0) AS `total` FROM `payment_withdrawals` WHERE `user_id` = ? AND `status` IN ('holding','pending','approved','paid','rolling_back') AND CONVERT_TZ(`created_at`, '+00:00', '+08:00') >= DATE(CONVERT_TZ(NOW(3), '+00:00', '+08:00')) AND CONVERT_TZ(`created_at`, '+00:00', '+08:00') < DATE(CONVERT_TZ(NOW(3), '+00:00', '+08:00')) + INTERVAL 1 DAY";
    expect(WITHDRAW_DAY_TOTAL_SQL).toBe(TEXT);
    expect(DAY_LIMIT_SQL).toBe(TEXT);
  });

  it('withdrawals mine：读列全投影（id 前置=keyset 内部列）+ 游标条件（created_at,id 严格降序）+ 排序限行', () => {
    expect(WITHDRAW_MINE_SELECT_BASE).toBe(
      'SELECT `id`, `withdraw_no`, `coins`, `amount_fen`, `status`, `timeout_at`, `review_note`, `reviewed_at`, `confirmed_at`, `rolled_back_at`, `created_at` FROM `payment_withdrawals` WHERE `user_id` = ?',
    );
    expect(WITHDRAW_MINE_CURSOR_COND).toBe(' AND (`created_at` < ? OR (`created_at` = ? AND `id` < ?))');
    expect(WITHDRAW_MINE_ORDER_LIMIT).toBe(' ORDER BY `created_at` DESC, `id` DESC LIMIT ?');
  });

  it('refunds mine：读列全投影（id 前置）+ 游标条件 + 排序限行', () => {
    expect(REFUND_MINE_SELECT_BASE).toBe(
      'SELECT `id`, `refund_no`, `order_no`, `coins`, `amount_fen`, `status`, `reason`, `review_note`, `reviewed_at`, `refunded_at`, `created_at` FROM `payment_refunds` WHERE `user_id` = ?',
    );
    expect(REFUND_MINE_CURSOR_COND).toBe(' AND (`created_at` < ? OR (`created_at` = ? AND `id` < ?))');
    expect(REFUND_MINE_ORDER_LIMIT).toBe(' ORDER BY `created_at` DESC, `id` DESC LIMIT ?');
  });
});

/* ======================================================================== *
 * ② 日限共享 helper（禁第二实现的机械面）
 * ======================================================================== */
describe('② 日限共享 helper（§3.2；apply 与 summary 双消费面共用）', () => {
  it('remainingDailyWithdrawCoins = dailyMax − dayTotal，**下钳 0**（显示面语义不允许负值）', () => {
    expect(remainingDailyWithdrawCoins(100_000, 7000)).toBe(93_000);
    expect(remainingDailyWithdrawCoins(100_000, 100_000)).toBe(0);
    expect(remainingDailyWithdrawCoins(50_000, 60_000)).toBe(0); // 运途中调低日限 ⇒ 钳 0（实现选择，登记）
  });

  it('queryWithdrawDayTotal：SQL 形状精确识别；数值列**严格**读取（坏形状 ⇒ 响亮抛，不静默 NaN）', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const executor = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [{ total: 7000 }];
      },
    };
    expect(await queryWithdrawDayTotal(executor, USER)).toBe(7000);
    expect(calls).toEqual([{ sql: WITHDRAW_DAY_TOTAL_SQL, params: [USER] }]);

    const bad = { query: async () => [{ total: 'NaN-ish' }] };
    await expect(queryWithdrawDayTotal(bad, USER)).rejects.toThrow(/safe|安全整数|不是安全整数/);
  });
});

/* ======================================================================== *
 * 夹具（假 DataSource / 假 currency 客户端 / 假 ConfigCache）
 * ======================================================================== */

const DAY_MS = 86_400_000;

/** +08:00 自然日的起点（UTC 毫秒）——假库与真 SQL（CONVERT_TZ 偏移写法）**同向**。 */
function beijingDayStartMs(now: Date): number {
  const shifted = now.getTime() + 8 * 3_600_000;
  return Math.floor(shifted / DAY_MS) * DAY_MS - 8 * 3_600_000;
}

const THE_FIVE_IN_FLIGHT = ['holding', 'pending', 'approved', 'paid', 'rolling_back'];

interface FakeWithdrawRow {
  id: number;
  withdraw_no: string;
  user_id: string;
  coins: number;
  amount_fen: number;
  status: string;
  timeout_at: Date;
  review_note: string | null;
  reviewed_at: Date | null;
  confirmed_at: Date | null;
  rolled_back_at: Date | null;
  created_at: Date;
}

interface FakeRefundRow {
  id: number;
  refund_no: string;
  order_no: string;
  user_id: string;
  coins: number;
  amount_fen: number;
  status: string;
  reason: string;
  review_note: string | null;
  reviewed_at: Date | null;
  refunded_at: Date | null;
  created_at: Date;
}

/** 假 DataSource：识别本套件用到的**全部** SQL 精确形状；锁 SQL 只走事务面。 */
class FakeWalletDb {
  now = new Date('2026-10-06T04:00:00.000Z'); // = +08:00 2026-10-06 12:00
  withdrawals: FakeWithdrawRow[] = [];
  refunds: FakeRefundRow[] = [];
  readonly lockRows = new Set<string>();
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  private nextWithdrawId = 1;
  private nextRefundId = 1;

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  seedWithdraw(over: Partial<FakeWithdrawRow> = {}): FakeWithdrawRow {
    const id = this.nextWithdrawId++;
    const row: FakeWithdrawRow = {
      id,
      withdraw_no: over.withdraw_no ?? `wd_seed${String(id).padStart(4, '0')}`,
      user_id: USER,
      coins: 1000,
      amount_fen: 1000,
      status: 'pending',
      timeout_at: new Date(this.now.getTime() + 4320 * 60_000),
      review_note: null,
      reviewed_at: null,
      confirmed_at: null,
      rolled_back_at: null,
      created_at: new Date(this.now.getTime() - 60_000),
      ...over,
    };
    this.withdrawals.push(row);
    return row;
  }

  seedRefund(over: Partial<FakeRefundRow> = {}): FakeRefundRow {
    const id = this.nextRefundId++;
    const row: FakeRefundRow = {
      id,
      refund_no: over.refund_no ?? `rf_seed${String(id).padStart(4, '0')}`,
      order_no: over.order_no ?? `pay_seed${String(id).padStart(4, '0')}`,
      user_id: USER,
      coins: 600,
      amount_fen: 600,
      status: 'pending',
      reason: '误购',
      review_note: null,
      reviewed_at: null,
      refunded_at: null,
      created_at: new Date(this.now.getTime() - 60_000),
      ...over,
    };
    this.refunds.push(row);
    return row;
  }

  /** keyset 过滤（两表共用；`at`/`rowId` 为游标、`limit` 为取行数）。 */
  private keysetPage<T extends { id: number; created_at: Date }>(
    rows: T[],
    userId: string,
    getUserId: (row: T) => string,
    cursor: { atMs: number; rowId: number } | null,
    limit: number,
  ): T[] {
    return rows
      .filter((r) => getUserId(r) === userId)
      .filter((r) => !cursor || r.created_at.getTime() < cursor.atMs || (r.created_at.getTime() === cursor.atMs && r.id < cursor.rowId))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id - a.id)
      .slice(0, limit);
  }

  private core(sql: string, params: unknown[]): unknown {
    this.queries.push({ sql, params });
    const nowMs = this.now.getTime();

    if (sql === WITHDRAW_DAY_TOTAL_SQL) {
      const dayStart = beijingDayStartMs(this.now);
      const total = this.withdrawals
        .filter(
          (r) =>
            r.user_id === params[0] &&
            THE_FIVE_IN_FLIGHT.includes(r.status) &&
            r.created_at.getTime() >= dayStart &&
            r.created_at.getTime() < dayStart + DAY_MS,
        )
        .reduce((sum, r) => sum + r.coins, 0);
      return [{ total }];
    }
    if (sql === UNRESOLVED_HOLDING_SQL) {
      const hit =
        this.withdrawals.some((r) => r.user_id === params[0] && r.status === 'holding') ||
        this.refunds.some((r) => r.user_id === params[1] && r.status === 'holding');
      return hit ? [{ no: 'hold' }] : [];
    }
    if (sql === INSERT_WITHDRAWAL_SQL) {
      const [withdraw_no, user_id, coins, amount_fen, timeoutMinutes] = params;
      const id = this.nextWithdrawId++;
      this.withdrawals.push({
        id,
        withdraw_no: String(withdraw_no),
        user_id: String(user_id),
        coins: Number(coins),
        amount_fen: Number(amount_fen),
        status: 'holding',
        timeout_at: new Date(nowMs + Number(timeoutMinutes) * 60_000),
        review_note: null,
        reviewed_at: null,
        confirmed_at: null,
        rolled_back_at: null,
        created_at: new Date(nowMs),
      });
      return { affectedRows: 1 };
    }
    if (sql === WITHDRAW_HOLD_TO_PENDING_SQL) {
      const row = this.withdrawals.find((r) => r.withdraw_no === params[0]);
      if (!row || row.status !== 'holding') return { affectedRows: 0 };
      row.status = 'pending';
      return { affectedRows: 1 };
    }
    if (sql === WITHDRAW_STATS_SQL || sql === WITHDRAW_FUNDOP_STATS_SQL) return [];

    // withdrawals mine（两变体：无游标 / 带游标）
    if (sql === WITHDRAW_MINE_SELECT_BASE + WITHDRAW_MINE_ORDER_LIMIT) {
      return this.keysetPage(this.withdrawals, String(params[0]), (r) => r.user_id, null, Number(params[1]));
    }
    if (sql === WITHDRAW_MINE_SELECT_BASE + WITHDRAW_MINE_CURSOR_COND + WITHDRAW_MINE_ORDER_LIMIT) {
      return this.keysetPage(
        this.withdrawals,
        String(params[0]),
        (r) => r.user_id,
        { atMs: (params[1] as Date).getTime(), rowId: Number(params[3]) },
        Number(params[4]),
      );
    }

    // refunds mine（两变体）
    if (sql === REFUND_MINE_SELECT_BASE + REFUND_MINE_ORDER_LIMIT) {
      return this.keysetPage(this.refunds, String(params[0]), (r) => r.user_id, null, Number(params[1]));
    }
    if (sql === REFUND_MINE_SELECT_BASE + REFUND_MINE_CURSOR_COND + REFUND_MINE_ORDER_LIMIT) {
      return this.keysetPage(
        this.refunds,
        String(params[0]),
        (r) => r.user_id,
        { atMs: (params[1] as Date).getTime(), rowId: Number(params[3]) },
        Number(params[4]),
      );
    }

    throw new Error(`未识别的 SQL（服务侧语句形状漂移？）：${sql}`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql === LOCK_INSERT_IGNORE_SQL || sql === LOCK_SELECT_FOR_UPDATE_SQL) {
      throw new Error(`锁语句不得走顶层 query：${sql}`);
    }
    return this.core(sql, params);
  }

  /** `withUserLock` 的事务面（非竞争形态：锁立即可得）。 */
  async transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    const manager = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql === LOCK_INSERT_IGNORE_SQL) {
          this.queries.push({ sql, params });
          const existed = this.lockRows.has(String(params[0]));
          this.lockRows.add(String(params[0]));
          return { affectedRows: existed ? 0 : 1 };
        }
        if (sql === LOCK_SELECT_FOR_UPDATE_SQL) {
          this.queries.push({ sql, params });
          return [{ user_id: String(params[0]) }];
        }
        return this.core(sql, params);
      },
    } as unknown as EntityManager;
    return fn(manager);
  }
}

type WalletCfgOver = Partial<{
  withdrawEnabled: boolean;
  coinPerYuan: number;
  withdrawMinCoins: number;
  withdrawMaxCoinsPerOrder: number;
  withdrawDailyMaxCoins: number;
  withdrawTimeoutMinutes: number;
}>;

function makeConfig(over: WalletCfgOver = {}): ConfigCacheService {
  return {
    withdrawEnabled: () => over.withdrawEnabled ?? true,
    coinPerYuan: () => over.coinPerYuan ?? COIN_PER_YUAN_DEFAULT,
    withdrawMinCoins: () => over.withdrawMinCoins ?? WITHDRAW_MIN_COINS_DEFAULT,
    withdrawMaxCoinsPerOrder: () => over.withdrawMaxCoinsPerOrder ?? WITHDRAW_MAX_COINS_PER_ORDER_DEFAULT,
    withdrawDailyMaxCoins: () => over.withdrawDailyMaxCoins ?? WITHDRAW_DAILY_MAX_COINS_DEFAULT,
    withdrawTimeoutMinutes: () => over.withdrawTimeoutMinutes ?? WITHDRAW_TIMEOUT_MINUTES_DEFAULT,
  } as unknown as ConfigCacheService;
}

function makeClient(
  over: {
    apply?: (req: CurrencyApplyRequest) => Promise<CurrencyApplyData>;
    get?: (req: { ownerIds: string[] }) => Promise<unknown>;
    withdrawable?: (req: { ownerId: string }) => Promise<unknown>;
  } = {},
) {
  const apply = vi.fn(
    over.apply ??
      (async (req: CurrencyApplyRequest) => ({
        opId: 1,
        actionId: req.actionId,
        entries: req.entries.map((e) => ({ ownerId: e.ownerId, balanceAfter: e.delta })),
        replayed: false,
      })),
  );
  const get = vi.fn(over.get ?? (async () => ({ balances: [{ ownerId: USER, balance: 4200, exists: true }] })));
  const withdrawable = vi.fn(over.withdrawable ?? (async () => ({ cap: 4200, balance: 4200 })));
  return { client: { apply, get, withdrawable } as unknown as CurrencyRpcClient, apply, get, withdrawable };
}

function makeWallet(db: FakeWalletDb, cfg: ConfigCacheService, client: CurrencyRpcClient): WalletController {
  return new WalletController(db.dataSource, cfg, client);
}

/* ======================================================================== *
 * ③ 钱包 summary 三字段
 * ======================================================================== */
describe('③ GET /api/pay/wallet/summary：三字段（balance 经 get · withdrawable=cap · 日限实算）', () => {
  it('正例：balance=4200 · withdrawable=4200 · 日限=100000−当日五态合计（+08:00 自然日）', async () => {
    const db = new FakeWalletDb();
    // 当日计入：pending 6000 + paid 1000；不计：rejected 5000 / 昨日 pending 99999
    db.seedWithdraw({ coins: 6000, status: 'pending' });
    db.seedWithdraw({ coins: 1000, status: 'paid' });
    db.seedWithdraw({ coins: 5000, status: 'rejected' });
    db.seedWithdraw({ coins: 99_999, status: 'pending', created_at: new Date(beijingDayStartMs(db.now) - 60_000) });
    const { client } = makeClient();

    const res = await makeWallet(db, makeConfig(), client).summary(USER);
    expect(res).toEqual({ code: ErrCode.OK, data: { balance: 4200, withdrawable: 4200, dailyWithdrawRemainingCoins: 93_000 } });
  });

  it('余额行不存在（exists=false）⇒ balance=0（读路径不建行的既有语义）', async () => {
    const db = new FakeWalletDb();
    const { client } = makeClient({
      get: async () => ({ balances: [{ ownerId: USER, balance: 0, exists: false }] }),
    });
    const res = await makeWallet(db, makeConfig(), client).summary(USER);
    expect((res.data as PayWalletSummary).balance).toBe(0);
  });

  it('balances 缺本人条目 ⇒ 响亮拒（坏回执不静默成 0——「最像正确答案的错」）', async () => {
    const db = new FakeWalletDb();
    const { client } = makeClient({ get: async () => ({ balances: [] }) });
    await expect(makeWallet(db, makeConfig(), client).summary(USER)).rejects.toThrow(/balances/);
  });
});

/* ======================================================================== *
 * ④ 口径一致钉（summary 剩余 vs apply 日限闸，同源）
 * ======================================================================== */
describe('④ 口径一致（复用途）：summary 剩余与 apply 日限闸同源——申请 X 后剩余恰减 X', () => {
  it('剩余 +1 ⇒ 15004 超单日；恰剩余 ⇒ 放行 ⇒ 剩余归 0；再申请 ⇒ 15004', async () => {
    const db = new FakeWalletDb();
    db.seedWithdraw({ coins: 1500, status: 'pending' }); // 当日已占 1500
    const cfg = makeConfig({ withdrawDailyMaxCoins: 3000 });
    const { client, withdrawable } = makeClient({ withdrawable: async () => ({ cap: 100_000, balance: 100_000 }) });

    const wallet = makeWallet(db, cfg, client);
    const s1 = await wallet.summary(USER);
    expect(s1.data).toEqual({ balance: 4200, withdrawable: 100_000, dailyWithdrawRemainingCoins: 1500 });

    const withdraw = new WithdrawService(db.dataSource, cfg, client, new UserLockService(db.dataSource));
    const capFetchesBeforeApply = withdrawable.mock.calls.length;

    // 剩余 +1 ⇒ 日限闸先于其他闸命中：1500 + 1501 = 3001 > 3000
    await expect(withdraw.apply(USER, 1501)).rejects.toMatchObject({
      code: ErrCode.PAY_WITHDRAW_LIMIT,
      message: '超出限额（单日）',
    });

    // 恰剩余 ⇒ 放行（cap 充足；单笔上限不拦）——「同口径」的活证；且 cap 在**动作时刻**重取
    // （不复用 summary 的读数——§2.2.1 禁缓存纪律的机械面）
    const ok = await withdraw.apply(USER, 1500);
    expect(ok.status).toBe('pending');
    expect(withdrawable.mock.calls.length).toBe(capFetchesBeforeApply + 1);

    // 申请落账后（五态计入）summary 剩余恰减 X
    const s2 = await wallet.summary(USER);
    expect((s2.data as PayWalletSummary).dailyWithdrawRemainingCoins).toBe(0);

    // 剩余 0 后再申请（≥门槛）⇒ 15004
    await expect(withdraw.apply(USER, 1000)).rejects.toMatchObject({ code: ErrCode.PAY_WITHDRAW_LIMIT });
  });
});

/* ======================================================================== *
 * ⑤ 依赖失败 fail-closed（不伪造读数）
 * ======================================================================== */
describe('⑤ summary 依赖失败 fail-closed（§2.2.1 同族纪律：读数拿不到不放松）', () => {
  /** 捕获错误（HttpException 有 getStatus/getResponse）。 */
  const catchErr = async (p: Promise<unknown>): Promise<HttpException | null> => {
    try {
      await p;
      return null;
    } catch (err) {
      return err as HttpException;
    }
  };

  it('withdrawable 失败 ⇒ **10007/503**（CurrencyServiceError 明确翻装；零伪造值）', async () => {
    const db = new FakeWalletDb();
    const { client } = makeClient({
      withdrawable: async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
      },
    });
    const err = await catchErr(makeWallet(db, makeConfig(), client).summary(USER));
    expect(err).toBeInstanceOf(HttpException);
    expect(err!.getStatus()).toBe(503);
    expect(err!.getResponse()).toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE, data: null });
  });

  it('currency.get 失败 ⇒ 同上（balance 拿不到不回落 0）', async () => {
    const db = new FakeWalletDb();
    const { client } = makeClient({
      get: async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
      },
    });
    const err = await catchErr(makeWallet(db, makeConfig(), client).summary(USER));
    expect(err).toBeInstanceOf(HttpException);
    expect(err!.getStatus()).toBe(503);
    expect(err!.getResponse()).toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });
  });

  it('HTTP_STATUS：UPSTREAM_UNAVAILABLE ⇒ 503（不补则 10007 经 `?? 500` 静默变 500）', () => {
    expect(HTTP_STATUS[ErrCode.UPSTREAM_UNAVAILABLE]).toBe(503);
  });
});

/* ======================================================================== *
 * ⑥ mine 列表（keyset / 只本人 / 投影）
 * ======================================================================== */
describe('⑥ refunds/withdrawals mine：keyset（默认 20/≤50）· 只本人 · 投影恰十键', () => {
  function seedPaged(db: FakeWalletDb): void {
    // 5 行提现（时间递减排布，id 与时间同向）+ 他用户两行
    for (let i = 0; i < 5; i += 1) {
      db.seedWithdraw({ created_at: new Date(db.now.getTime() - i * 60_000), withdraw_no: `wd_p${i}` });
    }
    db.seedWithdraw({ user_id: OTHER_USER, withdraw_no: 'wd_other' });
    for (let i = 0; i < 3; i += 1) {
      db.seedRefund({ created_at: new Date(db.now.getTime() - i * 60_000), refund_no: `rf_p${i}` });
    }
    db.seedRefund({ user_id: OTHER_USER, refund_no: 'rf_other' });
  }

  it('withdrawals mine：翻页三跳（limit=2 ⇒ 2+nextCursor；末页 nextCursor=null）· 只本人 · 降序', async () => {
    const db = new FakeWalletDb();
    seedPaged(db);
    const svc = new WithdrawService(db.dataSource, makeConfig(), makeClient().client, new UserLockService(db.dataSource));

    const p1 = await svc.mine(USER, { limit: 2 });
    expect(p1.items.map((r) => r.withdrawNo)).toEqual(['wd_p0', 'wd_p1']);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await svc.mine(USER, { cursor: p1.nextCursor, limit: 2 });
    expect(p2.items.map((r) => r.withdrawNo)).toEqual(['wd_p2', 'wd_p3']);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = await svc.mine(USER, { cursor: p2.nextCursor, limit: 2 });
    expect(p3.items.map((r) => r.withdrawNo)).toEqual(['wd_p4']);
    expect(p3.nextCursor).toBeNull();

    // 只本人：任何一页都不得出现 `wd_other`
    for (const page of [p1, p2, p3]) {
      expect(page.items.some((r) => r.withdrawNo === 'wd_other')).toBe(false);
    }
    // 行投影恰十键（protocol `PayWithdrawInfo`；amountYuan 为字符串）
    expect(Object.keys(p1.items[0]!).sort()).toEqual(
      ['amountYuan', 'coins', 'confirmedAt', 'createdAt', 'reviewNote', 'reviewedAt', 'rolledBackAt', 'status', 'timeoutAt', 'withdrawNo'].sort(),
    );
  });

  it('refunds mine：翻页两跳 · 只本人 · 投影恰十键（含 orderNo/reason/refundedAt）', async () => {
    const db = new FakeWalletDb();
    seedPaged(db);
    const svc = new RefundService(db.dataSource, makeClient().client, new UserLockService(db.dataSource), {} as AlipayClient);

    const p1 = await svc.mine(USER, { limit: 2 });
    expect(p1.items.map((r) => r.refundNo)).toEqual(['rf_p0', 'rf_p1']);
    const p2 = await svc.mine(USER, { cursor: p1.nextCursor, limit: 2 });
    expect(p2.items.map((r) => r.refundNo)).toEqual(['rf_p2']);
    expect(p2.nextCursor).toBeNull();
    expect(p1.items.some((r) => r.refundNo === 'rf_other')).toBe(false);
    expect(Object.keys(p1.items[0]!).sort()).toEqual(
      ['amountYuan', 'coins', 'createdAt', 'orderNo', 'reason', 'refundedAt', 'refundNo', 'reviewNote', 'reviewedAt', 'status'].sort(),
    );
  });

  it('limit 缺省 20 / 上限 50（服务端 clamp）；非法游标 ⇒ 10001（先于任何查询）', async () => {
    const db = new FakeWalletDb();
    for (let i = 0; i < 25; i += 1) db.seedWithdraw({ created_at: new Date(db.now.getTime() - i * 60_000) });
    const svc = new WithdrawService(db.dataSource, makeConfig(), makeClient().client, new UserLockService(db.dataSource));

    const def = await svc.mine(USER, {});
    expect(def.items).toHaveLength(20);
    expect(def.nextCursor).not.toBeNull();

    const capped = await svc.mine(USER, { limit: 999 });
    expect(capped.items).toHaveLength(25); // 上限 50 > 现有 25 行——clamp 到 50 不是 20

    const before = db.queries.length;
    await expect(svc.mine(USER, { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    expect(db.queries.length, '非法游标不得落库（先于任何查询）').toBe(before);
  });

  it('状态非状态机值 ⇒ 响亮抛（不把坏数据投影成契约类型）', async () => {
    const db = new FakeWalletDb();
    db.seedWithdraw({ status: 'weird' });
    const svc = new WithdrawService(db.dataSource, makeConfig(), makeClient().client, new UserLockService(db.dataSource));
    await expect(svc.mine(USER, {})).rejects.toThrow(/状态机/);
  });
});

/* ======================================================================== *
 * ⑦ 控制器真 HTTP（node:http）
 * ======================================================================== */
describe('⑦ 控制器真 HTTP（GET summary / mine 两族；401 / 503 映射）', () => {
  it('注册面：WalletController ∈ AppModule.controllers（未注册 = 单测全绿而真容器 404）', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(WalletController);
  });

  it('GET /api/pay/wallet/summary：200 三字段 / 401 缺身份 / withdrawable 失败 ⇒ 503+10007', async () => {
    const db = new FakeWalletDb();
    db.seedWithdraw({ coins: 6000, status: 'pending' });
    const good = makeClient();

    @Module({
      controllers: [WalletController],
      providers: [
        { provide: DataSource, useValue: db.dataSource },
        { provide: ConfigCacheService, useValue: makeConfig() },
        { provide: CurrencyRpcClient, useValue: good.client },
      ],
    })
    class WalletProbeModule {}

    const app = await NestFactory.create(WalletProbeModule, { logger: false, abortOnError: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;

    try {
      const ok = await httpCall(port, '/api/pay/wallet/summary', { headers: { 'x-user-id': USER } });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.body) as { code: number; data: PayWalletSummary };
      expect(body.code).toBe(ErrCode.OK);
      expect(body.data).toEqual({ balance: 4200, withdrawable: 4200, dailyWithdrawRemainingCoins: 94_000 });

      const noAuth = await httpCall(port, '/api/pay/wallet/summary', {});
      expect(noAuth.status).toBe(401);
      expect(JSON.parse(noAuth.body) as { code: number }).toMatchObject({ code: ErrCode.UNAUTHENTICATED });
    } finally {
      await app.close();
    }

    // 失败面：独立 app（坏客户端）—— withdrawable 失败 ⇒ 503 + 10007（不伪造读数）
    const broken = makeClient({
      withdrawable: async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
      },
    });
    @Module({
      controllers: [WalletController],
      providers: [
        { provide: DataSource, useValue: db.dataSource },
        { provide: ConfigCacheService, useValue: makeConfig() },
        { provide: CurrencyRpcClient, useValue: broken.client },
      ],
    })
    class WalletBrokenModule {}

    const app2 = await NestFactory.create(WalletBrokenModule, { logger: false, abortOnError: false });
    app2.setGlobalPrefix('api');
    await app2.listen(0, '127.0.0.1');
    const port2 = (app2.getHttpServer().address() as AddressInfo).port;
    try {
      const res = await httpCall(port2, '/api/pay/wallet/summary', { headers: { 'x-user-id': USER } });
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body) as { code: number }).toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });
    } finally {
      await app2.close();
    }
  });

  it('GET /api/pay/refunds/mine 与 /api/pay/withdrawals/mine：200（只本人）/ 401 缺身份', async () => {
    const db = new FakeWalletDb();
    db.seedWithdraw({ withdraw_no: 'wd_http1' });
    db.seedRefund({ refund_no: 'rf_http1' });
    const { client } = makeClient();

    @Module({
      controllers: [RefundController, WithdrawController],
      providers: [
        RefundService,
        WithdrawService,
        { provide: DataSource, useValue: db.dataSource },
        { provide: ConfigCacheService, useValue: makeConfig() },
        { provide: CurrencyRpcClient, useValue: client },
        { provide: UserLockService, useValue: new UserLockService(db.dataSource) },
        { provide: AlipayClient, useValue: {} },
        // 提现再认证片：WithdrawController 新增第 3 个注入（REDIS，票据 `DEL` 用；不可用 fail-closed）。
        // `/mine` 是只读面、不碰票据 ⇒ 照 `withdraw-state.test.ts:1542` 的既有形态给桩。
        { provide: REDIS, useValue: { del: vi.fn().mockResolvedValue(0) } },
      ],
    })
    class MineProbeModule {}

    const app = await NestFactory.create(MineProbeModule, { logger: false, abortOnError: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;

    try {
      const w = await httpCall(port, '/api/pay/withdrawals/mine?limit=5', { headers: { 'x-user-id': USER } });
      expect(w.status).toBe(200);
      const wBody = JSON.parse(w.body) as { code: number; data: PayWithdrawalsPage };
      expect(wBody.code).toBe(ErrCode.OK);
      expect(wBody.data.items.map((r) => r.withdrawNo)).toEqual(['wd_http1']);

      const r = await httpCall(port, '/api/pay/refunds/mine', { headers: { 'x-user-id': USER } });
      expect(r.status).toBe(200);
      const rBody = JSON.parse(r.body) as { code: number; data: PayRefundsPage };
      expect(rBody.data.items.map((x) => x.refundNo)).toEqual(['rf_http1']);

      const noAuth = await httpCall(port, '/api/pay/refunds/mine', {});
      expect(noAuth.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

/* ────────────────────────────── 工具 ────────────────────────────── */

beforeEach(() => {
  vi.restoreAllMocks();
});

function httpCall(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = httpRequestRaw(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
