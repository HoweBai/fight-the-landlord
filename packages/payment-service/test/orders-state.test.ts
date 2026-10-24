/**
 * 支付片 T7：订单链套件（任务卡 Test: `orders-state.test.ts`）。
 *
 * 覆盖面（九块）：
 *  ① `order-state.ts` 四条 SQL 常量**全文钉**（规格 §3.1 逐字：created→paid / closed→paid 重开 /
 *     paid→credited / 过期关闭）；
 *  ② ⚙️4 单号形状（`pay_` + base36(ms) + 6 随机；字符集 `[0-9a-z_]`、长 ≤ 32）；
 *  ③ createOrder：15008/10001 负例 · 复用规则（同档复用/他档并存/过期不复用）· 金额与
 *     `coin_per_yuan` 快照逐字 · 渠道失败 ⇒ 15001 且行保留（重试可复用）· base URL 缺失 ⇒ 15001；
 *  ④ 状态机全转移：created→paid 条件更新 · 并发两回调恰一 · closed 重开（记 `late_reopen_at`）·
 *     幂等 already · 过期关闭（含 trade.close「已支付」⇒ 转 paid 路径负例）；
 *  ⑤ sync：5 分钟/未过期门槛 · TRADE_SUCCESS ⇒ paid · 查询失败 ⇒ `last_error`；
 *  ⑥ 15002 负例（非本人/不存在；getById 与 sync 同）；
 *  ⑦ keyset：游标翻页/终页/非法游标 10001/limit clamp；
 *  ⑧ **路由次序**（真 Nest 管线）：`GET /api/pay/orders/mine` 不得 15002（静态段先于参数段）；
 *  ⑨ `payment_order_pending{state}` 写点（扫描轮末刷新）+ 模块注册面；
 *  ⑩ wap.pay 桥接：createOrder 返回本站桥接 URL（HMAC token 经 INTERNAL_SERVICE_TOKEN 校验）·
 *     cashierContext 三态（missing/gone/form）+ 现场重签 + 渠道失败抛 15001。
 *
 * 夹具：**假 DataSource**（精确形状识别 —— 服务侧 SQL 一漂移就当场红）· 假渠道（`PaymentChannel`
 * 直替 `AlipayClient`）· 假 ConfigCache（四个 getter）· 假渠道图服务（T9：mock
 * `PayChannelConfigService.get()` 的现拉面，站点基址经此供给）；另有一段用**真** `ConfigCacheService`
 * 快照驱动四个新 getter（缺省照种子）。
 * HTTP 客户端一律 `node:http`（**不用 fetch**——避 Windows 封禁端口假红族⑤；照 boot.test.ts 纪律）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequestRaw } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
// ⚠️ **值导入**：`DataSource` 同时是 DI token（探针模块的 provide）——`import type` 会在运行期 undefined。
import { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import type {
  PayChannelKey,
  PayCreateOrderResponse,
  PayOrderInfo,
  PayOrdersPage,
} from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import { AlipayClient } from '../src/channel/alipay/client';
import type { PaymentChannel } from '../src/channel/payment-channel.interface';
import {
  COIN_PER_YUAN_DEFAULT,
  ConfigCacheService,
  ORDER_EXPIRE_MINUTES_DEFAULT,
  RECHARGE_ENABLED_DEFAULT,
  RECHARGE_PACKAGES_DEFAULT,
} from '../src/config/config-cache.service';
import type { ConfigClient } from '../src/config/config.client';
// ⚠️ **值导入**：`PayChannelConfigService` 同时是 DI token（探针模块的 provide）——`import type` 会在运行期 undefined。
import { PayChannelConfigService } from '../src/config/pay-channel.config.service';
import {
  HTTP_STATUS,
} from '../src/http/errors';
import { paymentOrderPending } from '../src/metrics/payment.metrics';
import { OrdersController } from '../src/orders/orders.controller';
import {
  ORDER_CLOSED_TO_PAID_REOPEN_SQL,
  ORDER_CLOSE_EXPIRED_SQL,
  ORDER_CREATED_TO_PAID_SQL,
  ORDER_PAID_TO_CREDITED_SQL,
} from '../src/orders/order-state';
import {
  clampMineLimit,
  generatePayOrderNo,
  OrdersService,
  PAY_ORDERS_MINE_DEFAULT_LIMIT,
  PAY_ORDERS_MINE_MAX_LIMIT,
} from '../src/orders/orders.service';
import type { CurrencyApplyData, CurrencyApplyRequest } from '@fight-the-landlord/protocol';
import type { CurrencyRpcClient } from '../src/rpc/currency.client';
import { PAID_STATS_SQL, SELECT_CREDIT_TARGET_SQL, ScanService } from '../src/scan/scan.service';
import type { RefundService } from '../src/refund/refund.service';
import type { WithdrawService } from '../src/withdraw/withdraw.service';
import { verifyCashierToken } from '../src/cashier/cashier-token';

/* ======================================================================== *
 * ① order-state.ts：四条 SQL 常量全文钉（规格 §3.1 逐字）
 * ======================================================================== */
describe('① 订单状态机 SQL 常量（规格 §3.1 逐字；单测全文钉）', () => {
  it('created→paid：条件更新（trade_no + paid_at，WHERE status=created）', () => {
    expect(ORDER_CREATED_TO_PAID_SQL).toBe(
      "UPDATE `payment_orders` SET `status`='paid', `trade_no`=?, `paid_at`=NOW(3) WHERE `order_no`=? AND `status`='created'",
    );
  });

  it('closed→paid 重开：记 late_reopen_at（逐字不含 trade_no/paid_at —— 规格原文如此）', () => {
    expect(ORDER_CLOSED_TO_PAID_REOPEN_SQL).toBe(
      "UPDATE `payment_orders` SET `status`='paid', `late_reopen_at`=NOW(3) WHERE `order_no`=? AND `status`='closed'",
    );
  });

  it('paid→credited：入账落账（apply 调用在 T9，本卡只钉常量）', () => {
    expect(ORDER_PAID_TO_CREDITED_SQL).toBe(
      "UPDATE `payment_orders` SET `status`='credited', `credited_at`=NOW(3) WHERE `order_no`=? AND `status`='paid'",
    );
  });

  it('过期关闭：批量条件更新（status=created AND expires_at < NOW(3)）', () => {
    expect(ORDER_CLOSE_EXPIRED_SQL).toBe(
      "UPDATE `payment_orders` SET `status`='closed', `closed_at`=NOW(3) WHERE `status`='created' AND `expires_at` < NOW(3)",
    );
  });
});

/* ======================================================================== *
 * ② ⚙️4 单号形状
 * ======================================================================== */
describe('② ⚙️4 单号形状（pay_ + base36(ms) + 6 随机）', () => {
  it('形状：pay_ 前缀、字符集 [0-9a-z_]、长 ≤ 32、含 base36 时间戳段', () => {
    const nowMs = 1_791_000_000_000; // 固定时刻 ⇒ base36 段可预期
    const no = generatePayOrderNo(nowMs);
    expect(no.startsWith('pay_')).toBe(true);
    expect(no).toMatch(/^pay_[0-9a-z]+$/);
    expect(no.length).toBeLessThanOrEqual(32);
    expect(no.startsWith(`pay_${nowMs.toString(36)}`)).toBe(true);
    // 随机段恰 6 位（前缀 4 + base36 时间戳 + 6）
    expect(no.length).toBe(4 + nowMs.toString(36).length + 6);
  });

  it('两次生成不相等（随机段）；头尾结构稳定', () => {
    const a = generatePayOrderNo();
    const b = generatePayOrderNo();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pay_[0-9a-z]+$/);
    expect(b).toMatch(/^pay_[0-9a-z]+$/);
  });
});

/* ======================================================================== *
 * 夹具：假 DB / 假渠道 / 假配置
 * ======================================================================== */

const USER = 'user-t7-0001';
const OTHER_USER = 'user-t7-0002';
const BASE = 'https://ssh.example.test';

interface FakeOrderRow {
  id: number;
  order_no: string;
  user_id: string;
  package_yuan: number;
  amount_fen: number;
  coins: number;
  coin_per_yuan: number;
  status: string;
  channel: string;
  trade_no: string | null;
  expires_at: Date;
  paid_at: Date | null;
  credited_at: Date | null;
  closed_at: Date | null;
  late_reopen_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** 服务侧语句形状（**精确全文**；与 `orders.service.ts`/`order-state.ts` 常量一一对应）。 */
const SQL = {
  selectByOrderNo:
    'SELECT `id`, `order_no`, `status`, `coins`, `amount_fen`, `package_yuan`, `coin_per_yuan`, `expires_at`, `created_at`, `paid_at`, `credited_at`, `closed_at` FROM `payment_orders` WHERE `order_no` = ? AND `user_id` = ?',
  selectReusable:
    'SELECT `id`, `order_no`, `status`, `coins`, `amount_fen`, `package_yuan`, `coin_per_yuan`, `expires_at`, `created_at`, `paid_at`, `credited_at`, `closed_at` FROM `payment_orders` WHERE `user_id` = ? AND `package_yuan` = ? AND `status` = \'created\' AND `expires_at` > NOW(3) ORDER BY `created_at` DESC, `id` DESC LIMIT 1',
  insertOrder:
    'INSERT INTO `payment_orders` (`order_no`, `user_id`, `package_yuan`, `amount_fen`, `coins`, `coin_per_yuan`, `expires_at`) VALUES (?, ?, ?, ?, ?, ?, NOW(3) + INTERVAL ? MINUTE)',
  selectMineBase:
    'SELECT `id`, `order_no`, `status`, `coins`, `amount_fen`, `package_yuan`, `coin_per_yuan`, `expires_at`, `created_at`, `paid_at`, `credited_at`, `closed_at` FROM `payment_orders` WHERE `user_id` = ?',
  mineCursorCond: ' AND (`created_at` < ? OR (`created_at` = ? AND `id` < ?))',
  mineTail: ' ORDER BY `created_at` DESC, `id` DESC LIMIT ?',
  selectExpired: "SELECT `order_no` FROM `payment_orders` WHERE `status` = 'created' AND `expires_at` < NOW(3)",
  selectSyncEligible:
    "SELECT `order_no` FROM `payment_orders` WHERE `order_no` = ? AND `status` = 'created' AND `created_at` < NOW(3) - INTERVAL 5 MINUTE AND `expires_at` > NOW(3)",
  selectSweepCandidates:
    "SELECT `order_no` FROM `payment_orders` WHERE `status` = 'created' AND `created_at` < NOW(3) - INTERVAL 5 MINUTE AND `expires_at` > NOW(3)",
  selectCashierOrder:
    'SELECT `status`, `package_yuan`, `amount_fen` FROM `payment_orders` WHERE `order_no` = ?',
  selectCashierPayable:
    "SELECT 1 AS `ok` FROM `payment_orders` WHERE `order_no` = ? AND `status` = 'created' AND `expires_at` > NOW(3)",
  selectStatus: 'SELECT `status` FROM `payment_orders` WHERE `order_no` = ?',
  updateLastError: 'UPDATE `payment_orders` SET `last_error` = ? WHERE `order_no` = ?',
  countByStatus: 'SELECT COUNT(*) AS `count` FROM `payment_orders` WHERE `status` = ?',
} as const;

/**
 * 假 DataSource：识别上表**精确形状**的语句并在内存数据上执行（一漂移即「未识别的 SQL」当场红）。
 * `now` 是假时钟（NOW(3) 的替身）；`query` 在**调用时刻同步**改数据（微任务序即串行化，
 * 撑起「并发条件更新恰一」用例的确定性）。
 */
class FakeOrdersDb {
  now = new Date('2026-10-06T04:00:00.000Z');
  rows: FakeOrderRow[] = [];
  queries: Array<{ sql: string; params: unknown[] }> = [];
  private nextId = 1;

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  seed(over: Partial<FakeOrderRow> = {}): FakeOrderRow {
    const id = this.nextId++;
    const pkg = over.package_yuan ?? 6;
    const row: FakeOrderRow = {
      id,
      order_no: over.order_no ?? `pay_seed_${String(id).padStart(5, '0')}`,
      user_id: USER,
      package_yuan: pkg,
      amount_fen: pkg * 100,
      coins: over.coins ?? pkg * 100,
      coin_per_yuan: 100,
      status: 'created',
      channel: 'alipay',
      trade_no: null,
      expires_at: new Date(this.now.getTime() + 30 * 60_000),
      paid_at: null,
      credited_at: null,
      closed_at: null,
      late_reopen_at: null,
      last_error: null,
      created_at: new Date(this.now.getTime() - 6 * 60_000), // 默认「已够老」（补单扫描的门槛内）
      updated_at: this.now,
      ...over,
    };
    this.rows.push(row);
    return row;
  }

  private rowBy(no: unknown): FakeOrderRow | undefined {
    return this.rows.find((r) => r.order_no === no);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    this.queries.push({ sql, params });
    const nowMs = this.now.getTime();

    switch (sql) {
      case SQL.selectByOrderNo: {
        const row = this.rows.find((r) => r.order_no === params[0] && r.user_id === params[1]);
        return row ? [row] : [];
      }
      case SQL.selectReusable: {
        const match = this.rows
          .filter(
            (r) =>
              r.user_id === params[0] &&
              r.package_yuan === params[1] &&
              r.status === 'created' &&
              r.expires_at.getTime() > nowMs,
          )
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id - a.id);
        return match.length > 0 ? [match[0]] : [];
      }
      case SQL.insertOrder: {
        const [order_no, user_id, package_yuan, amount_fen, coins, coin_per_yuan, expireMinutes] = params;
        if (this.rows.some((r) => r.order_no === order_no)) {
          const err = Object.assign(new Error(`Duplicate entry '${String(order_no)}' for key 'uk_order_no'`), {
            code: 'ER_DUP_ENTRY',
            errno: 1062,
          });
          throw err;
        }
        const id = this.nextId++;
        this.rows.push({
          id,
          order_no: String(order_no),
          user_id: String(user_id),
          package_yuan: Number(package_yuan),
          amount_fen: Number(amount_fen),
          coins: Number(coins),
          coin_per_yuan: Number(coin_per_yuan),
          status: 'created',
          channel: 'alipay',
          trade_no: null,
          // NOW(3) + INTERVAL ? MINUTE（假时钟是唯一权威——与 SQL 判定同源）
          expires_at: new Date(nowMs + Number(expireMinutes) * 60_000),
          paid_at: null,
          credited_at: null,
          closed_at: null,
          late_reopen_at: null,
          last_error: null,
          created_at: new Date(nowMs),
          updated_at: new Date(nowMs),
        });
        return { affectedRows: 1 };
      }
      case SQL.selectMineBase + SQL.mineTail: {
        return this.mineRows(params, null);
      }
      case SQL.selectMineBase + SQL.mineCursorCond + SQL.mineTail: {
        return this.mineRows(params, {
          createdAt: params[1] as Date,
          rowId: params[3] as number,
        });
      }
      case ORDER_CREATED_TO_PAID_SQL: {
        const row = this.rowBy(params[1]);
        if (!row || row.status !== 'created') return { affectedRows: 0 };
        row.status = 'paid';
        row.trade_no = (params[0] as string | null) ?? null;
        row.paid_at = new Date(nowMs);
        return { affectedRows: 1 };
      }
      case ORDER_CLOSED_TO_PAID_REOPEN_SQL: {
        const row = this.rowBy(params[0]);
        if (!row || row.status !== 'closed') return { affectedRows: 0 };
        row.status = 'paid';
        row.late_reopen_at = new Date(nowMs);
        return { affectedRows: 1 };
      }
      case ORDER_PAID_TO_CREDITED_SQL: {
        const row = this.rowBy(params[0]);
        if (!row || row.status !== 'paid') return { affectedRows: 0 };
        row.status = 'credited';
        row.credited_at = new Date(nowMs);
        return { affectedRows: 1 };
      }
      // T9：即时入账链（ScanService.creditOrder）消费的两条读语句。
      case SELECT_CREDIT_TARGET_SQL: {
        const row = this.rowBy(params[0]);
        return row ? [{ order_no: row.order_no, status: row.status, user_id: row.user_id, coins: row.coins }] : [];
      }
      case PAID_STATS_SQL: {
        const paid = this.rows.filter((r) => r.status === 'paid');
        if (paid.length === 0) return [{ cnt: 0, oldest: 0 }];
        // 与真 SQL 同向：进入 paid 的时刻 = COALESCE(paid_at, late_reopen_at)（重开行恒无 paid_at）。
        const entered = paid.map((r) => r.paid_at ?? r.late_reopen_at).filter((d): d is Date => d !== null);
        if (entered.length === 0) return [{ cnt: paid.length, oldest: 0 }];
        const minEntered = Math.min(...entered.map((d) => d.getTime()));
        return [{ cnt: paid.length, oldest: Math.max(0, Math.floor((nowMs - minEntered) / 1000)) }];
      }
      case ORDER_CLOSE_EXPIRED_SQL: {
        const hit = this.rows.filter((r) => r.status === 'created' && r.expires_at.getTime() < nowMs);
        for (const row of hit) {
          row.status = 'closed';
          row.closed_at = new Date(nowMs);
        }
        return { affectedRows: hit.length };
      }
      case SQL.selectExpired: {
        return this.rows
          .filter((r) => r.status === 'created' && r.expires_at.getTime() < nowMs)
          .map((r) => ({ order_no: r.order_no }));
      }
      case SQL.selectSweepCandidates: {
        return this.rows
          .filter(
            (r) =>
              r.status === 'created' &&
              r.created_at.getTime() < nowMs - 5 * 60_000 &&
              r.expires_at.getTime() > nowMs,
          )
          .map((r) => ({ order_no: r.order_no }));
      }
      case SQL.selectSyncEligible: {
        const row = this.rowBy(params[0]);
        return row &&
          row.status === 'created' &&
          row.created_at.getTime() < nowMs - 5 * 60_000 &&
          row.expires_at.getTime() > nowMs
          ? [{ order_no: row.order_no }]
          : [];
      }
      // 桥接面两条读语句（公开面：只按 order_no，不带 user_id）。
      case SQL.selectCashierOrder: {
        const row = this.rowBy(params[0]);
        return row ? [{ status: row.status, package_yuan: row.package_yuan, amount_fen: row.amount_fen }] : [];
      }
      case SQL.selectCashierPayable: {
        const row = this.rowBy(params[0]);
        return row && row.status === 'created' && row.expires_at.getTime() > nowMs ? [{ ok: 1 }] : [];
      }
      case SQL.selectStatus: {
        const row = this.rowBy(params[0]);
        return row ? [{ status: row.status }] : [];
      }
      case SQL.updateLastError: {
        const row = this.rowBy(params[1]);
        if (!row) return { affectedRows: 0 };
        row.last_error = params[0] === null ? null : String(params[0]);
        return { affectedRows: 1 };
      }
      case SQL.countByStatus: {
        const count = this.rows.filter((r) => r.status === params[0]).length;
        return [{ count }];
      }
      default:
        throw new Error(`未识别的 SQL（服务侧语句形状漂移？）：${sql}`);
    }
  }

  private mineRows(params: unknown[], cursor: { createdAt: Date; rowId: number } | null): FakeOrderRow[] {
    return this.rows
      .filter((r) => r.user_id === params[0])
      .filter(
        (r) =>
          cursor === null ||
          r.created_at.getTime() < cursor.createdAt.getTime() ||
          (r.created_at.getTime() === cursor.createdAt.getTime() && r.id < cursor.rowId),
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id - a.id)
      .slice(0, Number(params[params.length - 1]));
  }
}

function makeConfig(over: Partial<Record<'rechargeEnabled' | 'coinPerYuan' | 'rechargePackages' | 'orderExpireMinutes', unknown>> = {}): ConfigCacheService {
  return {
    rechargeEnabled: () => (over.rechargeEnabled ?? true) as boolean,
    coinPerYuan: () => (over.coinPerYuan ?? COIN_PER_YUAN_DEFAULT) as number,
    rechargePackages: () => (over.rechargePackages ?? [6, 30, 68, 128, 328]) as number[],
    orderExpireMinutes: () => (over.orderExpireMinutes ?? ORDER_EXPIRE_MINUTES_DEFAULT) as number,
    // 本片 T9：ScanService 第六参消费面四件（首排两把手 + 两 interval getter；本套件不触发循环）。
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
    scanIntervalMs: () => 60_000,
    reconcileIntervalMs: () => 86_400_000,
  } as unknown as ConfigCacheService;
}

type QueryData = { found: boolean; tradeStatus: string | null; tradeNo: string | null; amountFen: number | null };

function makeChannel(
  over: {
    createPayUrl?: PaymentChannel['createPayUrl'];
    query?: PaymentChannel['query'];
    close?: PaymentChannel['close'];
  } = {},
) {
  const createPayUrl = vi.fn(
    over.createPayUrl ??
      ((async (req) => ({
        ok: true,
        data: {
          gatewayUrl: 'https://openapi.alipay.test/gateway.do',
          fields: {
            method: 'alipay.trade.wap.pay',
            out_trade_no: req.outTradeNo,
            total_amount: req.totalAmount,
            subject: req.subject,
            sign: 'fake-sign',
          },
        },
      })) as PaymentChannel['createPayUrl']),
  );
  const query = vi.fn(
    over.query ??
      ((async () => ({ ok: true, data: successQuery() })) as PaymentChannel['query']),
  );
  const close = vi.fn(
    over.close ?? ((async () => ({ ok: true, data: { closed: true } })) as PaymentChannel['close']),
  );
  const channel = {
    createPayUrl,
    query,
    close,
    refund: vi.fn(),
  } as unknown as AlipayClient;
  return { channel, createPayUrl, query, close };
}

function makeService(
  db: FakeOrdersDb,
  cfg: ConfigCacheService,
  channel: AlipayClient,
  payChannel: FakePayChannel = new FakePayChannel(),
): OrdersService {
  return new OrdersService(db.dataSource, cfg, channel, asPayChannel(payChannel));
}

const successQuery = (tradeNo = '2026100622001688000000000001'): QueryData => ({
  found: true,
  tradeStatus: 'TRADE_SUCCESS',
  tradeNo,
  amountFen: 600,
});

const failResult = (over: Partial<{ channelCode: string | null; channelSubCode: string | null; lastError: string }> = {}) => ({
  ok: false as const,
  code: ErrCode.PAY_CHANNEL_ERROR,
  lastError: over.lastError ?? '40004/ACQ.SYSTEM_ERROR: 系统异常',
  channelCode: over.channelCode ?? '40004',
  channelSubCode: over.channelSubCode ?? 'ACQ.SYSTEM_ERROR',
});

const gaugeValue = async (state: string): Promise<number | undefined> => {
  const metric = await paymentOrderPending.get();
  return metric.values.find((v) => v.labels.state === state)?.value;
};

/* ------------------------------ HTTP 帮助函数 ------------------------------ */

// ⚠️ HTTP 客户端一律 `node:http`（**不用 fetch**）：Node fetch 有「封禁端口表」，`listen(0)`
// 在 Windows 上分配到的端口若落表内即间歇红——本仓已知假红族⑤；`agent: false` 避免
// keep-alive 把 `close()` 挂住。照 boot.test.ts/notify.test.ts 既有写法（波 3 评审 🟡-1）。
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

/* ------------------------------ 渠道图夹具（T9） ------------------------------ */

/** 渠道凭据图（缺键 = 未配置语义——§3.3 `|| ''` 与旧「env 空串」逐字等价）。 */
type ChannelCreds = Partial<Record<PayChannelKey, string>>;

/** 假渠道图服务（mock `PayChannelConfigService.get()`）：`creds` **可变** ⇒ 改图后同一实例用新图。 */
class FakePayChannel {
  constructor(public creds: ChannelCreds | null = { 'pay.channel.publicBaseUrl': BASE }) {}

  async get(): Promise<ChannelCreds | null> {
    return this.creds;
  }
}

const asPayChannel = (fake: FakePayChannel): PayChannelConfigService => fake as unknown as PayChannelConfigService;

/** 桥接 token secret 走 INTERNAL_SERVICE_TOKEN（套件全程在场；afterAll 复原，不污染他套件）。 */
const CASHIER_SECRET = 'orders-state-cashier-test-secret';
const savedInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = CASHIER_SECRET;
});
afterAll(() => {
  if (savedInternalToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
  else process.env.INTERNAL_SERVICE_TOKEN = savedInternalToken;
});

beforeEach(() => {
  paymentOrderPending.reset();
});

/* ======================================================================== *
 * ③ createOrder
 * ======================================================================== */
describe('③ createOrder：下单（开关/档位/复用/快照/渠道）', () => {
  it('新单成功：行快照逐字（coins/coin_per_yuan/amount_fen/expires_at）+ 渠道参数逐字', async () => {
    const db = new FakeOrdersDb();
    const { channel, createPayUrl } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    const res = await svc.createOrder(USER, 6);

    expect(res.orderNo).toMatch(/^pay_[0-9a-z]+$/);
    // payUrl = 本站桥接 URL（不再下发支付宝网关能力 URL），?t= 是绑定单号+时效的 HMAC token。
    expect(res.payUrl.startsWith(`${BASE}/pay/cashier/${res.orderNo}?t=`)).toBe(true);
    {
      const u = new URL(res.payUrl);
      const payload = verifyCashierToken(u.searchParams.get('t')!, CASHIER_SECRET, Date.now(), res.orderNo);
      expect(payload).not.toBeNull();
      expect(payload!.ttlMin).toBe(30);
      expect(payload!.expMs).toBeGreaterThan(Date.now());
    }
    expect(res.expiresAt).toBe(db.now.getTime() + 30 * 60_000);

    expect(db.rows).toHaveLength(1);
    const row = db.rows[0]!;
    expect(row).toMatchObject({
      order_no: res.orderNo,
      user_id: USER,
      package_yuan: 6,
      amount_fen: 600, // 6 元 = 600 分（int，禁浮点）
      coins: 600, // 6 × 100（⚙️5：1 元 = 100 币）
      coin_per_yuan: 100,
      status: 'created',
      channel: 'alipay',
      trade_no: null,
      paid_at: null,
      last_error: null,
    });
    expect(row.expires_at.getTime()).toBe(db.now.getTime() + 30 * 60_000);

    expect(createPayUrl).toHaveBeenCalledTimes(1);
    expect(createPayUrl).toHaveBeenCalledWith({
      outTradeNo: res.orderNo,
      subject: '金币充值 6 元',
      totalAmount: '6.00',
      timeoutExpress: '30m',
      notifyUrl: `${BASE}/pay/notify/alipay`,
      returnUrl: `${BASE}/?pay=${res.orderNo}`,
    });
  });

  it('复用：同用户+同档位+未过期 created 单 ⇒ 同单号、不新行、重生成 payUrl', async () => {
    const db = new FakeOrdersDb();
    const existing = db.seed({ user_id: USER, package_yuan: 6 });
    const { channel, createPayUrl } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    const res = await svc.createOrder(USER, 6);

    expect(res.orderNo).toBe(existing.order_no);
    expect(res.expiresAt).toBe(existing.expires_at.getTime());
    expect(db.rows).toHaveLength(1); // 未新行
    expect(createPayUrl).toHaveBeenCalledTimes(1); // 链接重生成
    expect(createPayUrl.mock.calls[0]![0].outTradeNo).toBe(existing.order_no);
  });

  it('他档并存：不同档位各自新单（互不复用）', async () => {
    const db = new FakeOrdersDb();
    db.seed({ user_id: USER, package_yuan: 6 });
    const { channel } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    const res = await svc.createOrder(USER, 30);

    expect(db.rows).toHaveLength(2);
    expect(db.rows.map((r) => r.package_yuan).sort((a, b) => a - b)).toEqual([6, 30]);
    expect(res.orderNo.startsWith('pay_')).toBe(true);
  });

  it('过期不复用：已过期 created 单 ⇒ 新单（过期关闭后新单）', async () => {
    const db = new FakeOrdersDb();
    db.seed({
      user_id: USER,
      package_yuan: 6,
      expires_at: new Date(db.now.getTime() - 60_000),
    });
    const { channel } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    const res = await svc.createOrder(USER, 6);

    expect(db.rows).toHaveLength(2);
    expect(res.orderNo).not.toBe(db.rows[0]!.order_no);
  });

  it('15008：开关关 ⇒ 拒（充值暂未开放）；零库写、零渠道调用', async () => {
    const db = new FakeOrdersDb();
    const { channel, createPayUrl } = makeChannel();
    const svc = makeService(db, makeConfig({ rechargeEnabled: false }), channel);

    await expect(svc.createOrder(USER, 6)).rejects.toMatchObject({
      code: ErrCode.PAY_DISABLED,
      message: '充值暂未开放',
    });
    expect(db.rows).toHaveLength(0);
    expect(createPayUrl).not.toHaveBeenCalled();
  });

  it('10001：档位不在 pay.rechargePackages（含非整数/字符串）⇒ 拒', async () => {
    const db = new FakeOrdersDb();
    const { channel } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    for (const bad of [7, 0, -6, 6.5, '6', null, undefined, 'abc']) {
      await expect(svc.createOrder(USER, bad), String(bad)).rejects.toMatchObject({
        code: ErrCode.BAD_PARAM,
      });
    }
    expect(db.rows).toHaveLength(0);
  });

  it('渠道失败 ⇒ 15001「支付渠道暂时不可用，请稍后重试」；**行保留**且重试可复用', async () => {
    const db = new FakeOrdersDb();
    const failing = makeChannel({
      createPayUrl: (async () => ({
        ok: false,
        code: ErrCode.PAY_CHANNEL_ERROR,
        lastError: '支付渠道配置缺失或非法',
        channelCode: null,
        channelSubCode: null,
      })) as PaymentChannel['createPayUrl'],
    });
    const svc = makeService(db, makeConfig(), failing.channel);

    await expect(svc.createOrder(USER, 6)).rejects.toMatchObject({
      code: ErrCode.PAY_CHANNEL_ERROR,
      message: '支付渠道暂时不可用，请稍后重试',
    });
    expect(db.rows).toHaveLength(1); // 行保留
    const row = db.rows[0]!;
    expect(row.status).toBe('created');
    expect(row.expires_at.getTime()).toBe(db.now.getTime() + 30 * 60_000);

    // 重试：走复用（同一行、同单号），不再插新行；这次渠道成功 ⇒ 拿到 payUrl
    const ok = makeChannel();
    const svc2 = makeService(db, makeConfig(), ok.channel);
    const res = await svc2.createOrder(USER, 6);
    expect(res.orderNo).toBe(row.order_no);
    expect(db.rows).toHaveLength(1);
  });

  it('站点基址未配置（图无该键）⇒ 15001；零库写、零渠道调用（不产孤儿行）', async () => {
    const db = new FakeOrdersDb();
    const { channel, createPayUrl } = makeChannel();
    const svc = makeService(db, makeConfig(), channel, new FakePayChannel({}));

    await expect(svc.createOrder(USER, 6)).rejects.toMatchObject({
      code: ErrCode.PAY_CHANNEL_ERROR,
      message: '支付渠道暂时不可用，请稍后重试',
    });
    expect(db.rows).toHaveLength(0);
    expect(createPayUrl).not.toHaveBeenCalled();
  });

  it('站点基址 **每次调用现拉**（改图后同一实例用新图）', async () => {
    const db = new FakeOrdersDb();
    const { channel, createPayUrl } = makeChannel();
    const payChannel = new FakePayChannel();
    const svc = makeService(db, makeConfig(), channel, payChannel);

    payChannel.creds = { 'pay.channel.publicBaseUrl': 'https://site-a.test/' };
    await svc.createOrder(USER, 6);

    const first = createPayUrl.mock.calls[0]![0];
    // 尾斜杠被剥掉（URL 拼接待定）
    expect(first.notifyUrl).toBe('https://site-a.test/pay/notify/alipay');
    expect(first.returnUrl.startsWith('https://site-a.test/?pay=')).toBe(true);
  });
});

/* ======================================================================== *
 * ⑩ cashierContext（wap.pay 桥接页服务侧上下文）
 * ======================================================================== */
describe('⑩ cashierContext：桥接页上下文（missing/gone/form 三态 + 现场重签）', () => {
  it('无单 ⇒ missing；零渠道调用（控制器据此回 404，不区分不存在与 token 非法）', async () => {
    const db = new FakeOrdersDb();
    const { channel, createPayUrl } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    expect(await svc.cashierContext('pay_nope', 30)).toEqual({ kind: 'missing' });
    expect(createPayUrl).not.toHaveBeenCalled();
  });

  it('created 已过期 / closed / paid ⇒ 一律 gone（控制器据此回 410）；零渠道调用', async () => {
    const db = new FakeOrdersDb();
    const expired = db.seed({ expires_at: new Date(db.now.getTime() - 60_000) });
    const closed = db.seed({ status: 'closed' });
    const paid = db.seed({ status: 'paid', paid_at: new Date(db.now.getTime() - 60_000) });
    const { channel, createPayUrl } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    expect(await svc.cashierContext(expired.order_no, 30)).toEqual({ kind: 'gone' });
    expect(await svc.cashierContext(closed.order_no, 30)).toEqual({ kind: 'gone' });
    expect(await svc.cashierContext(paid.order_no, 30)).toEqual({ kind: 'gone' });
    expect(createPayUrl).not.toHaveBeenCalled();
  });

  it('created 未过期 ⇒ form：现拉基址 + 现场重签入参逐字（ttlMin 取自 token 载荷，非现配）', async () => {
    const db = new FakeOrdersDb();
    db.seed({ order_no: 'pay_bridge0001', package_yuan: 30, amount_fen: 3000, coins: 3000 });
    const { channel, createPayUrl } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    const ctx = await svc.cashierContext('pay_bridge0001', 45);

    expect(ctx.kind).toBe('form');
    if (ctx.kind !== 'form') throw new Error('unreachable');
    expect(ctx.gatewayUrl).toBe('https://openapi.alipay.test/gateway.do');
    expect(ctx.fields).toMatchObject({ method: 'alipay.trade.wap.pay', out_trade_no: 'pay_bridge0001' });

    expect(createPayUrl).toHaveBeenCalledTimes(1);
    expect(createPayUrl).toHaveBeenCalledWith({
      outTradeNo: 'pay_bridge0001',
      subject: '金币充值 30 元',
      totalAmount: '30.00',
      timeoutExpress: '45m', // token 载荷里的下单 TTL（即使管理员事后改了 orderExpireMinutes）
      notifyUrl: `${BASE}/pay/notify/alipay`,
      returnUrl: `${BASE}/?pay=pay_bridge0001`,
    });
  });

  it('渠道失败（探针 15001）⇒ 抛 DomainError 15001（控制器据此回 502，不外溢成 200）', async () => {
    const db = new FakeOrdersDb();
    db.seed({ order_no: 'pay_bridge0002' });
    const failing = makeChannel({
      createPayUrl: (async () => ({
        ok: false,
        code: ErrCode.PAY_CHANNEL_ERROR,
        lastError: '40004/ACQ.INVALID_SIGN: 签名无效',
        channelCode: '40004',
        channelSubCode: 'ACQ.INVALID_SIGN',
      })) as PaymentChannel['createPayUrl'],
    });
    const svc = makeService(db, makeConfig(), failing.channel);

    await expect(svc.cashierContext('pay_bridge0002', 30)).rejects.toMatchObject({
      code: ErrCode.PAY_CHANNEL_ERROR,
      message: '支付渠道暂时不可用，请稍后重试',
    });
  });
});

/* ======================================================================== *
 * ④ 状态机全转移（transitionToPaid / 重开 / 过期关闭）
 * ======================================================================== */
describe('④ 状态机：created→paid 条件更新 / 重开 / 过期关闭', () => {
  it('created→paid：置 trade_no + paid_at；非 created 单条件更新不命中', async () => {
    const db = new FakeOrdersDb();
    const paidRow = db.seed({ status: 'created' });
    const closedRow = db.seed({ status: 'closed' });
    const svc = makeService(db, makeConfig(), makeChannel().channel);

    expect(await svc.transitionToPaid(paidRow.order_no, 'T-1')).toBe('paid');
    expect(paidRow.status).toBe('paid');
    expect(paidRow.trade_no).toBe('T-1');
    expect(paidRow.paid_at).not.toBeNull();

    // closed 行不会被 created→paid 命中（并发面）；它会走重开分支
    expect(await svc.transitionToPaid(closedRow.order_no, 'T-2')).toBe('reopened');
  });

  it('并发条件更新：同一 created 单两回调恰一（另一 ⇒ already）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ status: 'created' });
    const svc = makeService(db, makeConfig(), makeChannel().channel);

    const [a, b] = await Promise.all([
      svc.transitionToPaid(row.order_no, 'T-A'),
      svc.transitionToPaid(row.order_no, 'T-B'),
    ]);

    expect([a, b].filter((x) => x === 'paid')).toHaveLength(1);
    expect([a, b].filter((x) => x === 'already')).toHaveLength(1);
    expect(row.status).toBe('paid');
    expect(row.paid_at).not.toBeNull();
  });

  it('迟到重开：closed→paid 记 late_reopen_at；再回调 ⇒ already（幂等）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ status: 'closed', closed_at: new Date(db.now.getTime() - 60_000) });
    const svc = makeService(db, makeConfig(), makeChannel().channel);

    expect(await svc.transitionToPaid(row.order_no, 'T-LATE')).toBe('reopened');
    expect(row.status).toBe('paid');
    expect(row.late_reopen_at).not.toBeNull();
    expect(await svc.transitionToPaid(row.order_no, 'T-LATE')).toBe('already');
  });

  it('paid/credited ⇒ already（幂等 success 面）；不存在 ⇒ none', async () => {
    const db = new FakeOrdersDb();
    const paid = db.seed({ status: 'paid' });
    const credited = db.seed({ status: 'credited' });
    const svc = makeService(db, makeConfig(), makeChannel().channel);

    expect(await svc.transitionToPaid(paid.order_no, 'T')).toBe('already');
    expect(await svc.transitionToPaid(credited.order_no, 'T')).toBe('already');
    expect(await svc.transitionToPaid('pay_missing0000000000000000000000', 'T')).toBe('none');
  });

  it('closeExpired：过期 created ⇒ closed + closed_at；非过期/已 paid 不受扰；重复执行幂等', async () => {
    const db = new FakeOrdersDb();
    const expired = db.seed({ expires_at: new Date(db.now.getTime() - 1000) });
    const fresh = db.seed({ expires_at: new Date(db.now.getTime() + 60_000) });
    const paidExpired = db.seed({ status: 'paid', expires_at: new Date(db.now.getTime() - 1000) });
    const { channel, close } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    expect(await svc.closeExpired()).toBe(1);
    expect(expired.status).toBe('closed');
    expect(expired.closed_at).not.toBeNull();
    expect(fresh.status).toBe('created');
    expect(paidExpired.status).toBe('paid');
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({ outTradeNo: expired.order_no });

    // 第二轮：无过期 created 可关 ⇒ 0，且 close 不再被叫
    expect(await svc.closeExpired()).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('close 报「已支付」（ACQ.TRADE_HAS_SUCCESS）⇒ 转 paid 路径（重开、记 late_reopen_at、不写 last_error）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ expires_at: new Date(db.now.getTime() - 1000) });
    const { channel } = makeChannel({
      close: (async () => failResult({ channelSubCode: 'ACQ.TRADE_HAS_SUCCESS', lastError: '40004/ACQ.TRADE_HAS_SUCCESS: 交易已被支付' })) as PaymentChannel['close'],
    });
    const svc = makeService(db, makeConfig(), channel);

    await svc.closeExpired();

    expect(row.status).toBe('paid'); // 防「已付被关」——钱在手必入账
    expect(row.late_reopen_at).not.toBeNull();
    expect(row.last_error).toBeNull();
  });

  it('close 其它失败 ⇒ 行留 closed + last_error 记摘要（过期关闭失败写点）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ expires_at: new Date(db.now.getTime() - 1000) });
    const { channel } = makeChannel({
      close: (async () => failResult({ lastError: 'ECONNREFUSED 10.0.0.9:443' })) as PaymentChannel['close'],
    });
    const svc = makeService(db, makeConfig(), channel);

    await svc.closeExpired();

    expect(row.status).toBe('closed');
    expect(row.closed_at).not.toBeNull();
    expect(row.last_error).toBe('ECONNREFUSED 10.0.0.9:443');
  });
});

/* ======================================================================== *
 * ⑤ sweepCreated 主动查询补单
 * ======================================================================== */
describe('⑤ sweepCreated：主动查询补单（created 且超 5 分钟未过期）', () => {
  it('TRADE_SUCCESS ⇒ paid（补回调丢失）；返回迁移计数', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ status: 'created' }); // 默认 created_at = now-6min
    const { channel, query } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    expect(await svc.sweepCreated()).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({ outTradeNo: row.order_no });
    expect(row.status).toBe('paid');
    expect(row.trade_no).toBe('2026100622001688000000000001');
  });

  it('门槛：未满 5 分钟 / 已过期 / 非 created 都**不**查渠道', async () => {
    const db = new FakeOrdersDb();
    db.seed({ created_at: new Date(db.now.getTime() - 60_000) }); // 太年轻
    db.seed({ expires_at: new Date(db.now.getTime() - 1000) }); // 已过期（留给 closeExpired）
    db.seed({ status: 'paid' });
    const { channel, query } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    expect(await svc.sweepCreated()).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('found:false（渠道明确回答不存在）/ TRADE_CLOSED ⇒ 留 created（留待过期）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({});
    const notFound = makeChannel({
      query: (async () => ({
        ok: true,
        data: { found: false, tradeStatus: null, tradeNo: null, amountFen: null },
      })) as PaymentChannel['query'],
    });
    const svc = makeService(db, makeConfig(), notFound.channel);
    expect(await svc.sweepCreated()).toBe(0);
    expect(row.status).toBe('created');

    const closedTrade = makeChannel({
      query: (async () => ({
        ok: true,
        data: { found: true, tradeStatus: 'TRADE_CLOSED', tradeNo: null, amountFen: null },
      })) as PaymentChannel['query'],
    });
    const svc2 = makeService(db, makeConfig(), closedTrade.channel);
    expect(await svc2.sweepCreated()).toBe(0);
    expect(row.status).toBe('created');
  });

  it('查询失败 ⇒ last_error 记摘要；行留 created；返回 0', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({});
    const failing = makeChannel({
      query: (async () => failResult({ lastError: '超时' })) as PaymentChannel['query'],
    });
    const svc = makeService(db, makeConfig(), failing.channel);

    expect(await svc.sweepCreated()).toBe(0);
    expect(row.status).toBe('created');
    expect(row.last_error).toBe('超时');
  });

  it('并发：补单与回调竞争同一单 ⇒ 条件更新恰一（另一见面 already）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({});
    const svc = makeService(db, makeConfig(), makeChannel().channel);

    const [fromSweep, fromNotify] = await Promise.all([
      svc.transitionToPaid(row.order_no, 'T-SWEEP'),
      svc.transitionToPaid(row.order_no, 'T-NOTIFY'),
    ]);
    expect([fromSweep, fromNotify].filter((x) => x === 'paid')).toHaveLength(1);
    expect(row.status).toBe('paid');
  });
});

/* ======================================================================== *
 * ⑥ sync
 * ======================================================================== */
describe('⑥ sync：主动查询（created 且超 5 分钟未过期）', () => {
  it('门槛内（刚下单）：不查渠道，原样返回', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ created_at: new Date(db.now.getTime() - 60_000) });
    const { channel, query } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    const info = await svc.sync(USER, row.order_no);
    expect(query).not.toHaveBeenCalled();
    expect(info.status).toBe('created');
  });

  it('超 5 分钟 + TRADE_SUCCESS ⇒ paid（返回新态）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({});
    const { channel } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    const info = await svc.sync(USER, row.order_no);
    expect(info.status).toBe('paid');
    expect(info.paidAt).not.toBeNull();
    expect(row.trade_no).toBe('2026100622001688000000000001');
  });

  it('查询失败 ⇒ last_error 记摘要、返回原态（不把查询故障翻成端点错误）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({});
    const failing = makeChannel({
      query: (async () => failResult({ lastError: '渠道 502' })) as PaymentChannel['query'],
    });
    const svc = makeService(db, makeConfig(), failing.channel);

    const info = await svc.sync(USER, row.order_no);
    expect(info.status).toBe('created');
    expect(row.last_error).toBe('渠道 502');
  });

  it('已过期 created：不查渠道（过期为 closeExpired 的职责）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ expires_at: new Date(db.now.getTime() - 1000) });
    const { channel, query } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    await svc.sync(USER, row.order_no);
    expect(query).not.toHaveBeenCalled();
  });
});

/* ======================================================================== *
 * ⑥b 15002 负例（非本人 / 不存在）
 * ======================================================================== */
describe('⑥b 15002：订单不存在或已失效（非本人等同不存在）', () => {
  it('getById：不存在 / 他人订单 ⇒ 15002', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ user_id: OTHER_USER });
    const svc = makeService(db, makeConfig(), makeChannel().channel);

    await expect(svc.getById(USER, row.order_no)).rejects.toMatchObject({
      code: ErrCode.PAY_ORDER_NOT_FOUND,
      message: '订单不存在或已失效',
    });
    await expect(svc.getById(USER, 'pay_nope')).rejects.toMatchObject({
      code: ErrCode.PAY_ORDER_NOT_FOUND,
    });
  });

  it('sync：同样 15002（且零渠道调用）', async () => {
    const db = new FakeOrdersDb();
    const { channel, query } = makeChannel();
    const svc = makeService(db, makeConfig(), channel);

    await expect(svc.sync(USER, 'pay_nope')).rejects.toMatchObject({
      code: ErrCode.PAY_ORDER_NOT_FOUND,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('getById 正例：行投影逐字（amountYuan 字符串 / epoch ms / null 面）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ package_yuan: 68, coins: 6800, amount_fen: 6800 });
    const svc = makeService(db, makeConfig(), makeChannel().channel);

    const info = await svc.getById(USER, row.order_no);
    expect(info).toEqual({
      orderNo: row.order_no,
      status: 'created',
      coins: 6800,
      amountYuan: '68.00',
      packageYuan: 68,
      createdAt: row.created_at.getTime(),
      paidAt: null,
      creditedAt: null,
      closedAt: null,
    });
  });
});

/* ======================================================================== *
 * ⑪ T9：sync 的即时入账钩子（paid 之后立即尝试入账；失败静默留给扫描）
 * ======================================================================== */
describe('⑪ T9 入账钩子：sync 的 paid → credited 一体与静默失败', () => {
  /** 真 ScanService + 假 currency 客户端接线（`svc.scan` 属性 = forwardRef 注入的替身面）。 */
  function wireScan(
    db: FakeOrdersDb,
    svc: OrdersService,
    applyImpl?: (req: CurrencyApplyRequest) => Promise<CurrencyApplyData>,
  ) {
    const apply = vi.fn(
      applyImpl ??
        (async (req: CurrencyApplyRequest): Promise<CurrencyApplyData> => ({
          opId: 1,
          actionId: req.actionId,
          entries: req.entries.map((e) => ({ ownerId: e.ownerId, balanceAfter: e.delta })),
          replayed: false,
        })),
    );
    const client = { apply } as unknown as CurrencyRpcClient;
    // T10/T11：ScanService 构造新增 `WithdrawService`（循环 ④⑤）与 `RefundService`（循环 ⑥⑦）
    // ——本组只走 ③ 入账，两替身空转。本片 T9：第六参假 ConfigCache（不触发循环 ⇒ 四件齐即可）。
    const withdraw = {
      resolveHolding: async () => 0,
      rollbackTimeout: async () => 0,
    } as unknown as WithdrawService;
    const refunds = {
      resolveHolding: async () => 0,
      rollbackRecovery: async () => 0,
    } as unknown as RefundService;
    svc.scan = new ScanService(db.dataSource, svc, client, withdraw, refunds, makeConfig());
    return { apply };
  }

  it('TRADE_SUCCESS ⇒ paid 之后**立即入账**：sync 返回 credited 一体（锚逐字 pay:<orderNo>）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ status: 'created' }); // 默认 created_at = now-6min（补单门槛内）
    const svc = makeService(db, makeConfig(), makeChannel().channel);
    const { apply } = wireScan(db, svc);

    const info = await svc.sync(USER, row.order_no);

    expect(info.status).toBe('credited');
    expect(info.creditedAt).not.toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `pay:${row.order_no}`,
      source: 'recharge',
      refId: row.order_no,
      entries: [{ ownerId: USER, delta: row.coins }],
    });
  });

  it('即时入账失败 ⇒ **静默留给扫描**（sync 照常返回；行留 paid，不抛）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ status: 'created' });
    const svc = makeService(db, makeConfig(), makeChannel().channel);
    wireScan(db, svc, async () => {
      throw new Error('ECONNREFUSED 172.28.0.11:3104');
    });

    const info = await svc.sync(USER, row.order_no);

    expect(info.status).toBe('paid'); // 停留原位；下轮扫描（≤60s）兜底
    expect(row.status).toBe('paid');
    expect(row.credited_at).toBeNull();
  });

  it('未接线（单测直构的 scan=null）⇒ 钩子空转不崩（生产由 AppModule 注册保证在场）', async () => {
    const db = new FakeOrdersDb();
    const row = db.seed({ status: 'created' });
    const svc = makeService(db, makeConfig(), makeChannel().channel); // scan 保持 null

    const info = await svc.sync(USER, row.order_no);
    expect(info.status).toBe('paid');
    expect(row.status).toBe('paid');
  });
});

/* ======================================================================== *
 * ⑦ keyset（mine）
 * ======================================================================== */
describe('⑦ mine：keyset 列表（只本人；created_at DESC, id DESC）', () => {
  it('翻页：limit=2 ⇒ 2 行 + nextCursor；第二页 ⇒ 1 行 + 终页 null；他人行不可见', async () => {
    const db = new FakeOrdersDb();
    const t0 = db.now.getTime();
    db.seed({ order_no: 'pay_a', created_at: new Date(t0 - 3000) });
    db.seed({ order_no: 'pay_b', created_at: new Date(t0 - 2000) });
    db.seed({ order_no: 'pay_c', created_at: new Date(t0 - 1000) });
    db.seed({ order_no: 'pay_other', user_id: OTHER_USER, created_at: new Date(t0) });
    const svc = makeService(db, makeConfig(), makeChannel().channel);

    const page1 = await svc.mine(USER, { limit: '2' });
    expect(page1.items.map((i) => i.orderNo)).toEqual(['pay_c', 'pay_b']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await svc.mine(USER, { cursor: page1.nextCursor, limit: '2' });
    expect(page2.items.map((i) => i.orderNo)).toEqual(['pay_a']);
    expect(page2.nextCursor).toBeNull();
  });

  it('空页 ⇒ {items:[], nextCursor:null}（不抛）', async () => {
    const db = new FakeOrdersDb();
    const svc = makeService(db, makeConfig(), makeChannel().channel);
    const page = await svc.mine(USER, {});
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('非法游标 ⇒ 10001（不静默回第一页）', async () => {
    const db = new FakeOrdersDb();
    const svc = makeService(db, makeConfig(), makeChannel().channel);
    for (const bad of ['not-a-cursor', 'MTIzNDU2Nzg5MDo=' /* base64url 非规范 */, '123', '1:0']) {
      await expect(svc.mine(USER, { cursor: bad }), bad).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    }
  });

  it('limit clamp：默认 20、上限 50、<1/非数回落默认', () => {
    expect(clampMineLimit(undefined)).toBe(PAY_ORDERS_MINE_DEFAULT_LIMIT);
    expect(clampMineLimit('')).toBe(PAY_ORDERS_MINE_DEFAULT_LIMIT);
    expect(clampMineLimit('abc')).toBe(PAY_ORDERS_MINE_DEFAULT_LIMIT);
    expect(clampMineLimit('0')).toBe(PAY_ORDERS_MINE_DEFAULT_LIMIT);
    expect(clampMineLimit('2')).toBe(2);
    expect(clampMineLimit('999')).toBe(PAY_ORDERS_MINE_MAX_LIMIT);
    expect(PAY_ORDERS_MINE_MAX_LIMIT).toBe(50);
  });
});

/* ======================================================================== *
 * ⑨ 指标写点 + 模块注册面
 * ======================================================================== */
describe('⑨ payment_order_pending{state} 写点 + 模块注册面', () => {
  it('扫描轮末刷新：pending_pay=created 数 / paid_uncredited=paid 数（sweepCreated 与 closeExpired 两路）', async () => {
    const db = new FakeOrdersDb();
    db.seed({ status: 'created' }); // 门槛内可补单 → 转 paid
    db.seed({ status: 'created', created_at: new Date(db.now.getTime() - 60_000) }); // 年轻，留 created
    db.seed({ status: 'paid' });
    const svc = makeService(db, makeConfig(), makeChannel().channel);

    await svc.sweepCreated();
    expect(await gaugeValue('pending_pay')).toBe(1);
    expect(await gaugeValue('paid_uncredited')).toBe(2);

    // 过期关闭路：再放一张过期单 ⇒ closeExpired 后 pending_pay 不含它（已 closed）
    db.seed({ expires_at: new Date(db.now.getTime() - 1000) });
    await svc.closeExpired();
    expect(await gaugeValue('pending_pay')).toBe(1);
    expect(await gaugeValue('paid_uncredited')).toBe(2);
  });

  it('AppModule 注册面：OrdersController ∈ controllers、OrdersService ∈ providers（未注册 = 真容器 404）', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(OrdersController);
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(OrdersService);
  });

  it('10002→401 在 HTTP_STATUS 表（x-user-id 守卫；不补则 401 静默变 500）', () => {
    expect(HTTP_STATUS[ErrCode.UNAUTHENTICATED]).toBe(401);
  });
});

/* ======================================================================== *
 * ⑧ 路由次序（真 Nest 管线 + 真控制器）
 * ======================================================================== */
describe('⑧ 路由次序：静态段 /mine 注册在参数段 /:orderNo 之前（真 HTTP）', () => {
  it('GET /api/pay/orders/mine ⇒ 200 列表（不得 15002）；/orders/:orderNo 404+15002；缺身份头 401', async () => {
    const db = new FakeOrdersDb();
    // 种子行用**他档**（30）：让后面的 create(6) 走新单而不是复用（复用面另有专测）
    db.seed({ order_no: 'pay_mine_0001', user_id: USER, package_yuan: 30 });
    const channel = makeChannel().channel;

    @Module({
      controllers: [OrdersController],
      providers: [
        OrdersService,
        { provide: DataSource, useValue: db.dataSource },
        { provide: ConfigCacheService, useValue: makeConfig() },
        { provide: AlipayClient, useValue: channel },
        // T9：OrdersService 构造注入 PayChannelConfigService（站点基址现拉面）。
        { provide: PayChannelConfigService, useValue: asPayChannel(new FakePayChannel()) },
        // T9：OrdersService 的 `scan` 属性（forwardRef 注入）——探针给最小哑替身
        // （纯值对象：不进真定时器；即时入账在本组无关）。
        { provide: ScanService, useValue: { creditOrder: async () => 'skipped' } },
      ],
    })
    class OrdersProbeModule {}

    const app = await NestFactory.create(OrdersProbeModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    // `listen(0)` 端口 + **node:http 客户端**（不用 fetch）⇒ 假红族⑤（fetch 封禁端口表）免疫。
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const H = { 'x-user-id': USER };

    try {
      const mine = await httpCall(port, '/api/pay/orders/mine', { headers: H });
      expect(mine.status).toBe(200);
      const mineBody = JSON.parse(mine.body) as { code: number; data: PayOrdersPage };
      expect(mineBody.code).toBe(ErrCode.OK);
      expect(mineBody.data.items.map((i) => i.orderNo)).toEqual(['pay_mine_0001']); // 不落到 :orderNo（否则 15002）

      const missing = await httpCall(port, '/api/pay/orders/pay_nope', { headers: H });
      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.body) as { code: number }).toMatchObject({ code: ErrCode.PAY_ORDER_NOT_FOUND });

      const noAuth = await httpCall(port, '/api/pay/orders/mine');
      expect(noAuth.status).toBe(401);
      expect(JSON.parse(noAuth.body) as { code: number }).toMatchObject({ code: ErrCode.UNAUTHENTICATED });

      const created = await httpCall(port, '/api/pay/orders', {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ packageYuan: 6 }),
      });
      expect(created.status).toBe(200);
      const createdBody = JSON.parse(created.body) as { code: number; data: PayCreateOrderResponse };
      expect(createdBody.code).toBe(ErrCode.OK);
      expect(createdBody.data.orderNo).toMatch(/^pay_[0-9a-z]+$/);

      // 开关关（同一真管线）⇒ POST /sync 面 409/15008 等价面在 create 已覆盖；此处校 sync 正路 200
      const syncRes = await httpCall(port, `/api/pay/orders/${createdBody.data.orderNo}/sync`, {
        method: 'POST',
        headers: H,
      });
      expect(syncRes.status).toBe(200);
      const syncBody = JSON.parse(syncRes.body) as { code: number; data: PayOrderInfo };
      expect(syncBody.code).toBe(ErrCode.OK);
      expect(syncBody.data.orderNo).toBe(createdBody.data.orderNo);
    } finally {
      await app.close();
    }
  });
});

/* ======================================================================== *
 * ⑩ ConfigCache 四个新 getter（真快照驱动；缺省照种子）
 * ======================================================================== */
describe('⑩ pay.* 四 getter（T7 消费面：26/28/29/33；缺省照种子）', () => {
  async function snapshotCache(values: Record<string, unknown>): Promise<ConfigCacheService> {
    process.env.CONFIG_SYNC_DISABLE_PUSH = '1';
    try {
      const client = {
        snapshot: async () => ({ config: values as never, version: 1 }),
      } as unknown as ConfigClient;
      const cache = new ConfigCacheService(client);
      cache.onModuleInit();
      await cache.waitForFirstSnapshot();
      return cache;
    } finally {
      delete process.env.CONFIG_SYNC_DISABLE_PUSH;
    }
  }

  it('快照值生效（四键逐字）', async () => {
    const cache = await snapshotCache({
      'pay.rechargeEnabled': { value: true, version: 1 },
      'pay.coinPerYuan': { value: 200, version: 1 },
      'pay.rechargePackages': { value: [1, 2, 3], version: 1 },
      'pay.orderExpireMinutes': { value: 15, version: 1 },
    });
    try {
      expect(cache.rechargeEnabled()).toBe(true);
      expect(cache.coinPerYuan()).toBe(200);
      expect(cache.rechargePackages()).toEqual([1, 2, 3]);
      expect(cache.orderExpireMinutes()).toBe(15);
    } finally {
      cache.onApplicationShutdown();
    }
  });

  it('键缺失/坏值 ⇒ 各回种子（false / 100 / [6,30,68,128,328] / 30）', async () => {
    const cache = await snapshotCache({
      'pay.coinPerYuan': { value: -1, version: 1 }, // 越界
      'pay.rechargePackages': { value: [], version: 1 }, // 空表
      'pay.orderExpireMinutes': { value: 'soon', version: 1 }, // 类型漂移
    });
    try {
      expect(cache.rechargeEnabled()).toBe(RECHARGE_ENABLED_DEFAULT);
      expect(cache.coinPerYuan()).toBe(COIN_PER_YUAN_DEFAULT);
      expect(cache.rechargePackages()).toEqual([...RECHARGE_PACKAGES_DEFAULT]);
      expect(cache.orderExpireMinutes()).toBe(ORDER_EXPIRE_MINUTES_DEFAULT);
    } finally {
      cache.onApplicationShutdown();
    }
  });
});
