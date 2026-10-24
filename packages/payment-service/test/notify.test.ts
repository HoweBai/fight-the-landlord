/**
 * 支付片 T8：**回调链 + 公网防护**套件（任务卡 Test: `notify.test.ts`）。
 *
 * 覆盖面（九块）：
 *  ① 常量/SQL 形状与源码接线（防护面量值钉死；`@All('pay/notify/alipay')` 与
 *     `ALIPAY_NOTIFY_PATH` 对钉；main.ts 的 rawBody/前缀豁免/token 豁免三处接线）；
 *  ② 正例：金标测试密钥对签名的通知 ⇒ created→paid + notify_log 落行 + `ok` 计数 +
 *     应答 `success`；
 *  ③ 幂等：重复通知 ⇒ `already` 面 `ok`、不重复推进（trade_no/paid_at 不被改写）；
 *  ④ 四项校验负例：金额不符（含非法格式）⇒ `amount_mismatch` · unknown_order ·
 *     `app_id`/`seller_id`（含未配置）⇒ `bad_sign` · `trade_status` 非成功集 ⇒ `bad_sign`；
 *  ⑤ 验签负例：篡改/缺 sign/错公钥/密钥缺失或坏/非字符串参数 ⇒ `bad_sign` 且
 *     **notify_log 零行**（仅验签通过件落行）；
 *  ⑥ `closed` 重开：记 `late_reopen_at` + `reopen` 计数 + 应答 `success`；
 *  ⑦ 并发双通知：恰一次推进（另一发走幂等面），两发都 `success`；
 *  ⑧ 防护链（**真 Nest 管线 + 真 HTTP**）：405/415/413/429 顺序与豁免面
 *     （无 token 可达 = edge 直连形态；近邻路径仍 401；`client_ip` = socket peer，XFF 不采信）；
 *  ⑨ `NotifyRateLimiter`：INCR+EXPIRE 形状、超桶 429 面、Redis 故障 ⇒ fail-open + 响亮 WARN；
 *     模块注册面。
 *
 * 夹具：**假 DataSource**（精确形状识别——服务侧 SQL 一漂移就当场红）· 假渠道/假配置（OrdersService
 * 构造参，notify 路径不消费）· 假渠道图服务（T9：mock `PayChannelConfigService.get()`，金标图逐用例可换）
 * · 假限流器（路由面）。HTTP 客户端一律 `node:http`（避 `fetch` 的
 * Windows 封禁端口假红族⑤；照 boot.test.ts 纪律）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpGetRaw, request as httpRequestRaw } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import 'reflect-metadata';
import { Logger, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
// ⚠️ **值导入**：`DataSource` 同时是 DI token（探针模块的 provide）——`import type` 会在运行期 undefined。
import { DataSource } from 'typeorm';
import { buildNotifySignSource } from '../src/channel/alipay/params';
import { AlipayClient } from '../src/channel/alipay/client';
import { AppModule } from '../src/app.module';
import { ConfigCacheService } from '../src/config/config-cache.service';
// ⚠️ **值导入**：`PayChannelConfigService` 同时是 DI token（探针模块的 provide）——`import type` 会在运行期 undefined。
import { PayChannelConfigService } from '../src/config/pay-channel.config.service';
import { createInternalTokenMiddleware, DEFAULT_EXEMPT_PATHS } from '../src/http/internal-token.middleware';
import { paymentNotifyTotal } from '../src/metrics/payment.metrics';
import {
  ALIPAY_NOTIFY_PATH,
  NOTIFY_MAX_BODY_BYTES,
  NOTIFY_RATE_KEY,
  NOTIFY_RATE_LIMIT,
  NotifyController,
  NotifyRateLimiter,
} from '../src/notify/notify.controller';
import {
  INSERT_NOTIFY_LOG_SQL,
  NotifyService,
  SELECT_NOTIFY_ORDER_SQL,
} from '../src/notify/notify.service';
import { ORDER_CLOSED_TO_PAID_REOPEN_SQL, ORDER_CREATED_TO_PAID_SQL, ORDER_PAID_TO_CREDITED_SQL } from '../src/orders/order-state';
import { OrdersService } from '../src/orders/orders.service';
import type { CurrencyApplyData, CurrencyApplyRequest, PayChannelKey } from '@fight-the-landlord/protocol';
import { CurrencyRpcClient, CurrencyServiceError } from '../src/rpc/currency.client';
import { PAID_STATS_SQL, SELECT_CREDIT_TARGET_SQL, ScanService } from '../src/scan/scan.service';
import type { RefundService } from '../src/refund/refund.service';
import type { WithdrawService } from '../src/withdraw/withdraw.service';
import { ErrCode } from '@fight-the-landlord/protocol';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const MAIN_SRC = readFileSync(join(PACKAGE_DIR, 'src/main.ts'), 'utf-8');
const CONTROLLER_SRC = readFileSync(join(PACKAGE_DIR, 'src/notify/notify.controller.ts'), 'utf-8');

/* ------------------------------- fixture 装载 ------------------------------- */

const FIXTURES = fileURLToPath(new URL('./fixtures/alipay', import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
interface KeyFixture {
  alipayPrivatePem: string;
  alipayPublicPem: string;
}
const keys = load<KeyFixture>('keys.json');

/** 通知参数来源 = T6 金标 `notify-success.json` 的骨架（T8 侧重建同构参数并重签）。 */
const fixtureNotify = load<{ params: Record<string, string> }>('notify-success.json').params;

const TEST_APP_ID = '9021000000000000';
const TEST_SELLER_ID = '2088721087500000';
const ORDER_NO = 'pay_t8notify0001';
const TRADE_NO = '2026100622001448060000000001';

/** ⚙️6① 通知口径签名（渠道私钥；与 `verifyNotify` 同一规范化源）。 */
const signParams = (params: Record<string, string>): string =>
  createSign('RSA-SHA256').update(buildNotifySignSource(params), 'utf8').sign(keys.alipayPrivatePem, 'base64');

/** 以金标骨架构造一条**已签名**通知（over 只改业务字段，签名同笔重出）。 */
function signedNotify(over: Record<string, string> = {}): Record<string, string> {
  const params: Record<string, string> = {
    notify_type: 'trade_status_sync',
    charset: 'utf-8',
    version: '1.0',
    sign_type: 'RSA2',
    app_id: TEST_APP_ID,
    seller_id: TEST_SELLER_ID,
    out_trade_no: ORDER_NO,
    total_amount: '6.00',
    receipt_amount: '6.00',
    trade_status: 'TRADE_SUCCESS',
    trade_no: TRADE_NO,
    ...over,
  };
  return { ...params, sign: signParams(params) };
}

/* ------------------------------ 渠道图夹具（T9） ------------------------------ */

/** 渠道凭据图（缺键 = 未配置语义——§3.3 `|| ''` 与旧「env 空串」逐字等价）。 */
type ChannelCreds = Partial<Record<PayChannelKey, string>>;

/** 假渠道图服务（mock `PayChannelConfigService.get()`）：`get()` 逐调用读**构造时给定**的图。 */
function makePayChannel(creds: ChannelCreds | null): PayChannelConfigService {
  return { get: async () => creds } as unknown as PayChannelConfigService;
}

/** 金标图：渠道公钥 + APP_ID + 商户 PID（值 = 金标 fixture / stub 常量同源）。 */
const GOOD_CREDS: ChannelCreds = {
  'pay.channel.publicKey': Buffer.from(keys.alipayPublicPem, 'utf8').toString('base64'),
  'pay.channel.appId': TEST_APP_ID,
  'pay.channel.sellerId': TEST_SELLER_ID,
};

beforeEach(() => {
  paymentNotifyTotal.reset();
});

/** `payment_notify_total{result}` 当前读数。 */
const notifyCount = async (result: string): Promise<number> => {
  const metric = await paymentNotifyTotal.get();
  return metric.values.find((v) => v.labels.result === result)?.value ?? 0;
};

/* ======================================================================== *
 * 夹具：假 DB / 假 OrdersService 依赖 / 假限流器
 * ======================================================================== */

interface FakeOrderRow {
  id: number;
  order_no: string;
  user_id: string;
  status: string;
  amount_fen: number;
  coins: number;
  trade_no: string | null;
  paid_at: Date | null;
  credited_at: Date | null;
  late_reopen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface FakeLogRow {
  order_no: string;
  result: string;
  trade_status: string | null;
  amount_fen: number | null;
  raw_payload: string | null;
  client_ip: string | null;
}

/** OrdersService 内部语句的**精确形状**（T7 已冻结；漂移即「未识别的 SQL」红）。 */
const SELECT_STATUS_SQL = 'SELECT `status` FROM `payment_orders` WHERE `order_no` = ?';

class FakeNotifyDb {
  now = new Date('2026-10-06T04:00:00.000Z');
  rows: FakeOrderRow[] = [];
  logRows: FakeLogRow[] = [];
  /** `created→paid` 条件更新**真的命中**的次数（并发恰一判据）。 */
  createdToPaidHits = 0;
  /** 置 true ⇒ `created→paid` 恒 affected=0 且行留 created（模拟「并发 churn / 行消失」的 'none' 护栏面）。 */
  suppressCreatedToPaid = false;
  queries: Array<{ sql: string; params: unknown[] }> = [];
  private nextId = 1;

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  seed(over: Partial<FakeOrderRow> = {}): FakeOrderRow {
    const row: FakeOrderRow = {
      id: this.nextId++,
      order_no: ORDER_NO,
      user_id: 'user-t8-0001',
      status: 'created',
      amount_fen: 600,
      coins: 600,
      trade_no: null,
      paid_at: null,
      credited_at: null,
      late_reopen_at: null,
      created_at: new Date(this.now.getTime()),
      updated_at: new Date(this.now.getTime()),
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

    if (sql === SELECT_NOTIFY_ORDER_SQL) {
      const row = this.rowBy(params[0]);
      return row ? [{ order_no: row.order_no, status: row.status, amount_fen: row.amount_fen }] : [];
    }
    if (sql === ORDER_CREATED_TO_PAID_SQL) {
      const row = this.rowBy(params[1]);
      if (!row || row.status !== 'created' || this.suppressCreatedToPaid) return { affectedRows: 0 };
      row.status = 'paid';
      row.trade_no = (params[0] as string | null) ?? null;
      row.paid_at = new Date(nowMs);
      this.createdToPaidHits += 1;
      return { affectedRows: 1 };
    }
    if (sql === SELECT_STATUS_SQL) {
      const row = this.rowBy(params[0]);
      return row ? [{ status: row.status }] : [];
    }
    if (sql === ORDER_CLOSED_TO_PAID_REOPEN_SQL) {
      const row = this.rowBy(params[0]);
      if (!row || row.status !== 'closed') return { affectedRows: 0 };
      row.status = 'paid';
      row.late_reopen_at = new Date(nowMs);
      return { affectedRows: 1 };
    }
    // T9：即时入账链（ScanService.creditOrder）消费的三条语句（形状同 scan.test.ts 夹具）。
    if (sql === SELECT_CREDIT_TARGET_SQL) {
      const row = this.rowBy(params[0]);
      return row ? [{ order_no: row.order_no, status: row.status, user_id: row.user_id, coins: row.coins }] : [];
    }
    if (sql === ORDER_PAID_TO_CREDITED_SQL) {
      const row = this.rowBy(params[0]);
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
    if (sql === INSERT_NOTIFY_LOG_SQL) {
      const [order_no, result, trade_status, amount_fen, raw_payload, client_ip] = params;
      this.logRows.push({
        order_no: String(order_no),
        result: String(result),
        trade_status: trade_status === null ? null : String(trade_status),
        amount_fen: amount_fen === null ? null : Number(amount_fen),
        raw_payload: raw_payload === null ? null : String(raw_payload),
        client_ip: client_ip === null ? null : String(client_ip),
      });
      return { affectedRows: 1 };
    }
    throw new Error(`未识别的 SQL（服务侧语句形状漂移？）：${sql}`);
  }
}

/**
 * notify 路径不消费这个依赖（transitionToPaid 只用 DataSource）——但构造参要在场。
 * 本片 T9：补 ScanService 第六参消费面四件（首排两把手 + 两 interval getter）；链路不触发
 * 循环（`onModuleInit` 不被调用）。
 */
const fakeConfig = {
  hasSnapshot: () => true,
  waitForFirstSnapshot: () => Promise.resolve(),
  scanIntervalMs: () => 60_000,
  reconcileIntervalMs: () => 86_400_000,
} as unknown as ConfigCacheService;
const fakeChannel = {} as unknown as AlipayClient;

type ApplyImpl = (req: CurrencyApplyRequest) => Promise<CurrencyApplyData>;

/**
 * T9：完整链路装配（**真** OrdersService + **真** ScanService + 假 currency 客户端）——
 * 「paid 之后立即尝试入账」的断言面（入账注入后正例延伸：paid→credited 一体）。
 * 假客户端默认成功回执；`applyImpl` 可注入失败（验证「失败静默留给扫描」）。
 * `creds` = 渠道图（T9：三读点改由 `PayChannelConfigService.get()` 现拉；缺键 = 未配置面）。
 */
function buildNotifyStack(db: FakeNotifyDb, applyImpl?: ApplyImpl, creds: ChannelCreds | null = GOOD_CREDS) {
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
  const orders = new OrdersService(db.dataSource, fakeConfig, fakeChannel, makePayChannel(creds));
  // T10/T11：ScanService 构造新增 `WithdrawService`（循环 ④⑤）与 `RefundService`（循环 ⑥⑦）
  // ——本链路只走 ③ 入账，两替身空转。本片 T9：第六参假 ConfigCache（`fakeConfig` 已补四件）。
  const withdraw = {
    resolveHolding: async () => 0,
    rollbackTimeout: async () => 0,
  } as unknown as WithdrawService;
  const refunds = {
    resolveHolding: async () => 0,
    rollbackRecovery: async () => 0,
  } as unknown as RefundService;
  const scan = new ScanService(db.dataSource, orders, client, withdraw, refunds, fakeConfig);
  return { svc: new NotifyService(db.dataSource, orders, scan, makePayChannel(creds)), apply };
}

function makeService(db: FakeNotifyDb, creds: ChannelCreds | null = GOOD_CREDS): NotifyService {
  return buildNotifyStack(db, undefined, creds).svc;
}

/** 路由面假限流器（真实现在 ⑨ 单独测）。 */
class FakeRateLimiter {
  exceededNow = false;
  calls = 0;
  async exceeded(): Promise<boolean> {
    this.calls += 1;
    return this.exceededNow;
  }
}

/* ------------------------------ HTTP 帮助函数 ------------------------------ */

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

const httpGet = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = httpGetRaw({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });

const formBody = (params: Record<string, string>): string => new URLSearchParams(params).toString();

/* ======================================================================== *
 * ① 常量 / SQL 形状 / 源码接线
 * ======================================================================== */
describe('① 防护面常量、SQL 形状与 main.ts 接线（§2.7.1/§2.7.4）', () => {
  it('路径与防护量值逐字：/pay/notify/alipay · 16KB · 边缘单桶 pay:notify:rate 600/分', () => {
    expect(ALIPAY_NOTIFY_PATH).toBe('/pay/notify/alipay');
    expect(NOTIFY_MAX_BODY_BYTES).toBe(16 * 1024);
    expect(NOTIFY_RATE_KEY).toBe('pay:notify:rate');
    expect(NOTIFY_RATE_LIMIT).toEqual({ max: 600, windowSeconds: 60 });
  });

  it('控制器源码逐字含 `@All(\'pay/notify/alipay\')`（与 ALIPAY_NOTIFY_PATH 对钉——防两处漂移）', () => {
    expect(CONTROLLER_SRC).toContain("@All('pay/notify/alipay')");
  });

  it('notify 数据面两条 SQL 全文钉（§2.3 DDL 列序）', () => {
    expect(SELECT_NOTIFY_ORDER_SQL).toBe(
      'SELECT `order_no`, `status`, `amount_fen` FROM `payment_orders` WHERE `order_no` = ?',
    );
    expect(INSERT_NOTIFY_LOG_SQL).toBe(
      'INSERT INTO `payment_notify_log` (`order_no`, `result`, `trade_status`, `amount_fen`, `raw_payload`, `client_ip`) VALUES (?, ?, ?, ?, ?, ?)',
    );
  });

  it('main.ts 接线在场：rawBody:true · notify 精确豁免 + cashier 前缀豁免 · 两路同入全局前缀 exclude', () => {
    expect(MAIN_SRC).toMatch(/rawBody:\s*true/);
    expect(MAIN_SRC).toMatch(
      /createInternalTokenMiddleware\(\s*\[\s*\.\.\.DEFAULT_EXEMPT_PATHS\s*,\s*ALIPAY_NOTIFY_PATH\s*,?\s*\]\s*,\s*\[\s*CASHIER_EXEMPT_PREFIX\s*,?\s*\]\s*,?\s*\)/,
    );
    expect(MAIN_SRC).toMatch(
      /setGlobalPrefix\(\s*'api'\s*,\s*\{\s*exclude:\s*\[\s*ALIPAY_NOTIFY_PATH\s*,\s*CASHIER_ROUTE\s*,?\s*\]\s*,?\s*\}\s*\)/,
    );
  });
});

/* ======================================================================== *
 * ② 正例：验签通过 ⇒ paid + notify_log 落行
 * ======================================================================== */
describe('② 正例：签名有效的通知 ⇒ created→paid（→立即入账 credited）+ ok 计数 + notify_log 落行 + success', () => {
  it('金标密钥对签名的通知 ⇒ success；**paid→credited 一体**（T9 即时入账）；日志行六列逐字', async () => {
    const db = new FakeNotifyDb();
    const row = db.seed({});
    const { svc, apply } = buildNotifyStack(db);

    const answer = await svc.handleNotify(signedNotify(), '10.9.0.1', 'raw=payload');

    expect(answer).toBe('success');
    expect(row.status).toBe('credited'); // T9：paid 之后立即尝试入账（一体收敛）
    expect(row.credited_at).not.toBeNull();
    expect(row.trade_no).toBe(TRADE_NO);
    expect(row.paid_at).not.toBeNull();
    // 入账锚逐字（pay:<orderNo>；锚先于入账——随 apply 请求过线）
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `pay:${ORDER_NO}`,
      source: 'recharge',
      refId: ORDER_NO,
      entries: [{ ownerId: 'user-t8-0001', delta: 600 }],
    });
    expect(await notifyCount('ok')).toBe(1);
    expect(db.logRows).toEqual([
      {
        order_no: ORDER_NO,
        result: 'ok',
        trade_status: 'TRADE_SUCCESS',
        amount_fen: 600,
        raw_payload: 'raw=payload',
        client_ip: '10.9.0.1',
      },
    ]);
  });

  it('T9：入账失败 ⇒ **静默留给扫描**（应答仍 success、行留 paid、日志照落 ok——success 语义不变）', async () => {
    const db = new FakeNotifyDb();
    const row = db.seed({});
    const { svc, apply } = buildNotifyStack(db, async () => {
      throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
    });

    const answer = await svc.handleNotify(signedNotify(), null, null);

    expect(answer).toBe('success'); // ≥paid 即 success（应答两词语义不因入账面改变）
    expect(row.status).toBe('paid'); // 停留原位（恢复模型①）——扫描重试兜底
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await notifyCount('ok')).toBe(1);
    expect(db.logRows[0]!.result).toBe('ok');
  });

  it('TRADE_FINISHED 同属成功集 ⇒ 同一 paid 路径（success + ok + 一体入账）', async () => {
    const db = new FakeNotifyDb();
    const row = db.seed({});
    const svc = makeService(db);

    expect(await svc.handleNotify(signedNotify({ trade_status: 'TRADE_FINISHED' }), null, null)).toBe('success');
    expect(row.status).toBe('credited');
    expect(await notifyCount('ok')).toBe(1);
    expect(db.logRows[0]!.trade_status).toBe('TRADE_FINISHED');
  });

  it('通知参数与金标骨架同构时验签通过（自证夹具真的走在 T6 口径上）', () => {
    const params = { ...signedNotify() };
    expect(params.sign).toBe(signParams(Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'sign'))));
    // 与金标 fixture 的业务差异真的存在（否则本组退化为 fixture 回放）
    expect(fixtureNotify['out_trade_no']).not.toBe(params['out_trade_no']);
  });
});

/* ======================================================================== *
 * ③ 幂等：重复通知
 * ======================================================================== */
describe('③ 幂等：重复通知 ⇒ already 面 ok、不重复推进', () => {
  it('同一条通知重发 ⇒ 两发都 success；paid_at/trade_no 不被第二发改写；日志两行都 ok', async () => {
    const db = new FakeNotifyDb();
    const row = db.seed({});
    const svc = makeService(db);

    expect(await svc.handleNotify(signedNotify(), '10.9.0.1', null)).toBe('success');
    const paidAt = row.paid_at;
    const tradeNo = row.trade_no;

    expect(await svc.handleNotify(signedNotify(), '10.9.0.1', null)).toBe('success');

    expect(row.paid_at).toBe(paidAt); // 未被第二发改写（条件更新 affected=0 ⇒ already）
    expect(row.trade_no).toBe(tradeNo);
    expect(await notifyCount('ok')).toBe(2);
    expect(db.logRows.map((r) => r.result)).toEqual(['ok', 'ok']);
    expect(db.createdToPaidHits).toBe(1); // created→paid 只命中过一次
  });

  it('credited 单再收通知 ⇒ 幂等 success（already 面）', async () => {
    const db = new FakeNotifyDb();
    db.seed({ status: 'credited' });
    const svc = makeService(db);

    expect(await svc.handleNotify(signedNotify(), null, null)).toBe('success');
    expect(await notifyCount('ok')).toBe(1);
  });
});

/* ======================================================================== *
 * ④ 四项校验负例
 * ======================================================================== */
describe('④ 四项校验：金额/订单/身份/状态', () => {
  it('金额不符（7.00 ≠ 600 分）⇒ amount_mismatch + failure；订单不动；日志行记已解析分', async () => {
    const db = new FakeNotifyDb();
    const row = db.seed({});
    const svc = makeService(db);

    const answer = await svc.handleNotify(signedNotify({ total_amount: '7.00' }), '10.9.0.1', null);

    expect(answer).toBe('failure');
    expect(row.status).toBe('created');
    expect(await notifyCount('amount_mismatch')).toBe(1);
    expect(db.logRows).toEqual([
      {
        order_no: ORDER_NO,
        result: 'amount_mismatch',
        trade_status: 'TRADE_SUCCESS',
        amount_fen: 700,
        raw_payload: null,
        client_ip: '10.9.0.1',
      },
    ]);
  });

  it('金额非法格式（含缺省）⇒ amount_mismatch（解析失败不猜）；amount_fen 列 NULL', async () => {
    for (const bad of ['6.0.0', '6,00', 'abc', '', '6.000']) {
      const db = new FakeNotifyDb();
      db.seed({});
      const svc = makeService(db);
      const answer = await svc.handleNotify(signedNotify({ total_amount: bad }), null, null);
      expect(answer, bad).toBe('failure');
      expect(await notifyCount('amount_mismatch'), bad).toBe(1);
      expect(db.logRows[0]!.amount_fen, bad).toBeNull();
      expect(db.rows[0]!.status, bad).toBe('created');
      paymentNotifyTotal.reset();
    }
  });

  it('unknown_order：out_trade_no 不存在 ⇒ failure + unknown_order 计数 + 日志行（取证）', async () => {
    const db = new FakeNotifyDb();
    const svc = makeService(db);

    const answer = await svc.handleNotify(signedNotify({ out_trade_no: 'pay_missing0000' }), null, null);

    expect(answer).toBe('failure');
    expect(await notifyCount('unknown_order')).toBe(1);
    expect(db.rows).toHaveLength(0);
    expect(db.logRows[0]).toMatchObject({ order_no: 'pay_missing0000', result: 'unknown_order', amount_fen: 600 });
  });

  it('app_id ≠ 本方 ⇒ bad_sign（密钥错配/攻击的第一道铃）+ failure；**零日志行**', async () => {
    const db = new FakeNotifyDb();
    db.seed({});
    const svc = makeService(db);

    const answer = await svc.handleNotify(signedNotify({ app_id: '9999999999999999' }), null, null);

    expect(answer).toBe('failure');
    expect(await notifyCount('bad_sign')).toBe(1);
    expect(db.logRows).toHaveLength(0);
    expect(db.rows[0]!.status).toBe('created');
  });

  it('渠道 APP_ID 未配置（图缺键）⇒ 校验不过 ⇒ bad_sign + failure（不崩）', async () => {
    const db = new FakeNotifyDb();
    db.seed({});
    const creds = { ...GOOD_CREDS };
    delete creds['pay.channel.appId'];
    const svc = makeService(db, creds);

    expect(await svc.handleNotify(signedNotify(), null, null)).toBe('failure');
    expect(await notifyCount('bad_sign')).toBe(1);
  });

  it('seller_id ≠ 本方 ⇒ bad_sign + failure；零日志行', async () => {
    const db = new FakeNotifyDb();
    db.seed({});
    const svc = makeService(db);

    expect(await svc.handleNotify(signedNotify({ seller_id: '2088999999999999' }), null, null)).toBe('failure');
    expect(await notifyCount('bad_sign')).toBe(1);
    expect(db.logRows).toHaveLength(0);
  });

  it('商户 PID 未配置（图缺键）⇒ 响亮 WARN + failure（不崩；bad_sign 计数）', async () => {
    const db = new FakeNotifyDb();
    db.seed({});
    const creds = { ...GOOD_CREDS };
    delete creds['pay.channel.sellerId'];
    const svc = makeService(db, creds);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let observed = false;
    try {
      expect(await svc.handleNotify(signedNotify(), null, null)).toBe('failure');
      // ⚠️ `mock.calls` 必须在 `mockRestore()` **之前**读（vitest 的 restore 会连记录一起清）。
      observed = warn.mock.calls.some((args) => String(args[0]).includes('商户 PID（管理页 → 支付渠道）'));
    } finally {
      warn.mockRestore();
    }
    expect(await notifyCount('bad_sign')).toBe(1);
    expect(observed).toBe(true);
  });

  it('trade_status 非成功集（WAIT_BUYER_PAY / TRADE_CLOSED）⇒ bad_sign + failure；零日志行', async () => {
    for (const status of ['WAIT_BUYER_PAY', 'TRADE_CLOSED']) {
      const db = new FakeNotifyDb();
      db.seed({});
      const svc = makeService(db);
      expect(await svc.handleNotify(signedNotify({ trade_status: status }), null, null), status).toBe('failure');
      expect(await notifyCount('bad_sign'), status).toBe(1);
      expect(db.logRows, status).toHaveLength(0);
      expect(db.rows[0]!.status, status).toBe('created');
      paymentNotifyTotal.reset();
    }
  });

  it('校验顺序：金额先于 trade_status（金额不符 + 非成功状态 ⇒ amount_mismatch）', async () => {
    const db = new FakeNotifyDb();
    db.seed({});
    const svc = makeService(db);

    expect(await svc.handleNotify(signedNotify({ total_amount: '7.00', trade_status: 'TRADE_CLOSED' }), null, null)).toBe(
      'failure',
    );
    expect(await notifyCount('amount_mismatch')).toBe(1);
    expect(await notifyCount('bad_sign')).toBe(0);
  });

  it('护栏（实践不可达）：transition=none（并发 churn）⇒ unknown_order + failure + 日志行', async () => {
    const db = new FakeNotifyDb();
    db.seed({ status: 'created' });
    db.suppressCreatedToPaid = true; // 条件更新恒 0 且现状非 closed/paid ⇒ T7 transitionToPaid 返回 'none'
    const svc = makeService(db);

    expect(await svc.handleNotify(signedNotify(), null, null)).toBe('failure');
    expect(await notifyCount('unknown_order')).toBe(1);
    expect(await notifyCount('ok')).toBe(0);
    expect(db.logRows[0]!.result).toBe('unknown_order');
  });
});

/* ======================================================================== *
 * ⑤ 验签负例（bad_sign 且 notify_log 零行 —— 仅验签通过件落行）
 * ======================================================================== */
describe('⑤ 验签负例：bad_sign 计数 + **notify_log 零行**', () => {
  it('篡改 total_amount（不改签名）⇒ bad_sign + failure；订单与日志均零动', async () => {
    const db = new FakeNotifyDb();
    db.seed({});
    const svc = makeService(db);
    const tampered = { ...signedNotify(), total_amount: '7.00' };

    expect(await svc.handleNotify(tampered, null, null)).toBe('failure');
    expect(await notifyCount('bad_sign')).toBe(1);
    expect(db.logRows).toHaveLength(0);
    expect(db.rows[0]!.status).toBe('created');
    expect(db.createdToPaidHits).toBe(0);
  });

  it('缺 sign ⇒ bad_sign（不可验 = 不可信）', async () => {
    const db = new FakeNotifyDb();
    const svc = makeService(db);
    const { sign: _drop, ...unsigned } = signedNotify();
    expect(await svc.handleNotify(unsigned, null, null)).toBe('failure');
    expect(await notifyCount('bad_sign')).toBe(1);
    expect(db.logRows).toHaveLength(0);
  });

  it('用别的私钥签（公钥错配）⇒ bad_sign', async () => {
    const db = new FakeNotifyDb();
    const svc = makeService(db);
    const params = { ...signedNotify() };
    params.sign = Buffer.alloc(256, 9).toString('base64');
    expect(await svc.handleNotify(params, null, null)).toBe('failure');
    expect(await notifyCount('bad_sign')).toBe(1);
  });

  it('渠道公钥缺失 / 非 PEM（图缺键/坏值）⇒ bad_sign + failure（不崩）', async () => {
    for (const bad of [undefined, 'bm90LWEtcGVt']) {
      const db = new FakeNotifyDb();
      const creds = { ...GOOD_CREDS };
      if (bad === undefined) delete creds['pay.channel.publicKey'];
      else creds['pay.channel.publicKey'] = bad;
      const svc = makeService(db, creds);
      expect(await svc.handleNotify(signedNotify(), null, null), String(bad)).toBe('failure');
      expect(await notifyCount('bad_sign'), String(bad)).toBe(1);
      paymentNotifyTotal.reset();
    }
  });

  it('form 含非字符串值（嵌套/数组形态）⇒ bad_sign + failure（不可验 = 不可信）', async () => {
    const db = new FakeNotifyDb();
    const svc = makeService(db);
    const form: Record<string, unknown> = { ...signedNotify() };
    form['out_trade_no'] = ['a', 'b'];
    expect(await svc.handleNotify(form, null, null)).toBe('failure');
    expect(await notifyCount('bad_sign')).toBe(1);
    expect(db.logRows).toHaveLength(0);
  });
});

/* ======================================================================== *
 * ⑥ closed 重开（钱在手必入账）
 * ======================================================================== */describe('⑥ closed 重开：迟到回调 ⇒ 重开 + reopen 计数', () => {
  it('closed 单收到支付成功通知 ⇒ 重开（late_reopen_at）+ 立即入账 ⇒ credited；reopen 计数；日志 result=reopen; success', async () => {
    const db = new FakeNotifyDb();
    const row = db.seed({ status: 'closed' });
    const svc = makeService(db);

    const answer = await svc.handleNotify(signedNotify(), '10.9.0.1', null);

    expect(answer).toBe('success');
    expect(row.status).toBe('credited'); // T9：重开（钱在手）之后立即尝试入账，一体收敛
    expect(row.late_reopen_at).not.toBeNull();
    expect(await notifyCount('reopen')).toBe(1);
    expect(await notifyCount('ok')).toBe(0);
    expect(db.logRows[0]!.result).toBe('reopen');
  });
});

/* ======================================================================== *
 * ⑦ 并发双通知：恰一次推进
 * ======================================================================== */
describe('⑦ 并发双通知（不同 trade_no）：恰一次 created→paid，另一发走幂等面', () => {
  it('两发并发都 success；条件更新恰一命中；订单只被推进一次', async () => {
    const db = new FakeNotifyDb();
    const row = db.seed({});
    const svc = makeService(db);

    const [a, b] = await Promise.all([
      svc.handleNotify(signedNotify({ trade_no: 'T-A' }), null, null),
      svc.handleNotify(signedNotify({ trade_no: 'T-B' }), null, null),
    ]);

    expect(a).toBe('success');
    expect(b).toBe('success');
    expect(db.createdToPaidHits).toBe(1);
    expect(['T-A', 'T-B']).toContain(row.trade_no);
    expect(row.paid_at).not.toBeNull();
    expect(await notifyCount('ok')).toBe(2); // 一发 paid、一发 already —— 都进 ok
    expect(db.logRows).toHaveLength(2);
  });
});

/* ======================================================================== *
 * ⑧ 防护链（真 Nest 管线 + 真 HTTP）：405/415/413/429 + 豁免面 + client_ip
 * ======================================================================== */
describe('⑧ 防护链（真 HTTP，与 main.ts 同形装配）', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let port = 0;
  let db: FakeNotifyDb;
  let rateLimiter: FakeRateLimiter;
  const savedToken = process.env.INTERNAL_SERVICE_TOKEN;

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'notify-test-token';
    db = new FakeNotifyDb();
    db.seed({});
    rateLimiter = new FakeRateLimiter();
    const dataSource = db.dataSource;
    const orders = new OrdersService(dataSource, fakeConfig, fakeChannel, makePayChannel(GOOD_CREDS));

    @Module({
      controllers: [NotifyController],
      providers: [
        NotifyService,
        { provide: DataSource, useValue: dataSource },
        { provide: OrdersService, useValue: orders },
        // T9：NotifyService 构造注入 ScanService（即时入账）——探针给最小哑替身（不建
        // 定时器：**纯值对象**，避免 useValue 实例被 Nest 触发生命周期钩子把扫描循环带进测试）。
        { provide: ScanService, useValue: { creditOrder: async () => 'skipped' } },
        // T9：NotifyService 构造注入 PayChannelConfigService（验签公钥/appId/sellerId 现拉面）。
        { provide: PayChannelConfigService, useValue: makePayChannel(GOOD_CREDS) },
        { provide: NotifyRateLimiter, useValue: rateLimiter },
      ],
    })
    class NotifyProbeModule {}

    app = await NestFactory.create(NotifyProbeModule, { logger: false, rawBody: true });
    // 与 src/main.ts 逐字同形（差异面 = 无 trace/metrics 中间件——与防护无关）。
    app.use(createInternalTokenMiddleware([...DEFAULT_EXEMPT_PATHS, ALIPAY_NOTIFY_PATH]));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api', { exclude: [ALIPAY_NOTIFY_PATH] });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    if (savedToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = savedToken;
  });

  const FORM = { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' };

  it('豁免面①：无 token 的签名 POST **可达**（edge 直连形态）⇒ 真 200 + `success` + text/plain；client_ip=socket peer（XFF 不采信）', async () => {
    db.logRows.length = 0;
    db.rows.length = 0;
    db.seed({});
    const res = await httpCall(port, ALIPAY_NOTIFY_PATH, {
      method: 'POST',
      headers: { ...FORM, 'x-forwarded-for': '1.2.3.4' },
      body: formBody(signedNotify()),
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('success');
    expect(String(res.headers['content-type'])).toMatch(/^text\/plain/);
    expect(db.logRows).toHaveLength(1);
    expect(db.logRows[0]!.client_ip).toBe('127.0.0.1'); // socket peer 如实记 —— 不复制 XFF 口径
  });

  it('豁免面②（精确负对照）：`/pay/notify/alipayx` 无 token ⇒ 401；带 token ⇒ 404', async () => {
    const noToken = await httpGet(port, '/pay/notify/alipayx');
    expect(noToken.status).toBe(401);
    const withToken = await httpGet(port, '/pay/notify/alipayx', { 'x-internal-token': 'notify-test-token' });
    expect(withToken.status).toBe(404);
  });

  it('方法闸：非 POST（GET）⇒ 405 + 纯文本 failure（豁免对所有方法生效——先于 401 面）', async () => {
    const res = await httpGet(port, ALIPAY_NOTIFY_PATH);
    expect(res.status).toBe(405);
    expect(res.body).toBe('failure');
  });

  it('内容类型闸：application/json ⇒ 415；缺 content-type ⇒ 415', async () => {
    const json = await httpCall(port, ALIPAY_NOTIFY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(json.status).toBe(415);
    expect(json.body).toBe('failure');

    const missing = await httpCall(port, ALIPAY_NOTIFY_PATH, { method: 'POST', body: 'a=1' });
    expect(missing.status).toBe(415);
  });

  it('体积闸：17KB form ⇒ 413（先于限流/验签）；恰好 16KB 的 form 不被体积闸拒（走验签 → failure）', async () => {
    const big = `p=${'a'.repeat(17 * 1024)}`;
    const over = await httpCall(port, ALIPAY_NOTIFY_PATH, { method: 'POST', headers: FORM, body: big });
    expect(over.status).toBe(413);
    expect(over.body).toBe('failure');

    const atLimit = `p=${'b'.repeat(NOTIFY_MAX_BODY_BYTES - 2)}`; // 'p=' + N —— 总长恰 16384
    expect(Buffer.byteLength(atLimit)).toBe(NOTIFY_MAX_BODY_BYTES);
    const edge = await httpCall(port, ALIPAY_NOTIFY_PATH, { method: 'POST', headers: FORM, body: atLimit });
    expect(edge.status).toBe(200);
    expect(edge.body).toBe('failure'); // 无 sign ⇒ 验签不过（未被体积闸拒）
  });

  it('顺序判据：超桶 + 17KB 同时 ⇒ 413（体积先于限流）；超桶 + 正常体积 ⇒ 429 且**零验签副作用**', async () => {
    rateLimiter.exceededNow = true;
    try {
      const big = await httpCall(port, ALIPAY_NOTIFY_PATH, {
        method: 'POST',
        headers: FORM,
        body: `p=${'c'.repeat(17 * 1024)}`,
      });
      expect(big.status).toBe(413);

      const before = await notifyCount('bad_sign');
      const limited = await httpCall(port, ALIPAY_NOTIFY_PATH, {
        method: 'POST',
        headers: FORM,
        body: formBody(signedNotify()),
      });
      expect(limited.status).toBe(429);
      expect(limited.body).toBe('failure');
      expect(await notifyCount('bad_sign')).toBe(before); // 429 发生在验签之前 —— 无计数副作用
    } finally {
      rateLimiter.exceededNow = false;
    }
  });

  it('验签负例经真管线：未签名 POST ⇒ 200 failure + bad_sign 上行（应答两词逐字）', async () => {
    const before = await notifyCount('bad_sign');
    const { sign: _drop, ...unsigned } = signedNotify();
    const res = await httpCall(port, ALIPAY_NOTIFY_PATH, {
      method: 'POST',
      headers: FORM,
      body: formBody(unsigned),
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('failure');
    expect(await notifyCount('bad_sign')).toBe(before + 1);
  });

  it('路由挂载点：/api/pay/notify/alipay **不是**本控制器的路由（前缀豁免只给不带 /api 的公开面）', async () => {
    const withToken = await httpCall(port, '/api/pay/notify/alipay', {
      method: 'POST',
      headers: { ...FORM, 'x-internal-token': 'notify-test-token' },
      body: formBody(signedNotify()),
    });
    const noToken = await httpCall(port, '/api/pay/notify/alipay', {
      method: 'POST',
      headers: FORM,
      body: formBody(signedNotify()),
    });
    expect(withToken.status).toBe(404); // 穿过 token 面后：无此路由
    expect(noToken.status).toBe(401); // token 面在场（该路径不在豁免集）
  });
});

/* ======================================================================== *
 * ⑨ NotifyRateLimiter（真实现）+ 模块注册面
 * ======================================================================== */
describe('⑨ NotifyRateLimiter：INCR+EXPIRE 单桶与 fail-open', () => {
  function makeLimiter(incrSequence: number[], failWith?: Error) {
    const calls = { incr: 0, expire: 0 };
    const fakeRedis = {
      incr: async (): Promise<number> => {
        calls.incr += 1;
        if (failWith) throw failWith;
        return incrSequence[Math.min(calls.incr - 1, incrSequence.length - 1)]!;
      },
      expire: async (): Promise<number> => {
        calls.expire += 1;
        if (failWith) throw failWith;
        return 1;
      },
      on: () => undefined,
    };
    const limiter = new NotifyRateLimiter((() => fakeRedis) as never);
    return { limiter, calls, fakeRedis };
  }

  it('600 ⇒ 放行；601 ⇒ 超桶；EXPIRE 只在首次 INCR 后设置（固定窗口，不被顺延）', async () => {
    const { limiter, calls } = makeLimiter([1, 2, 600, 601]);
    expect(await limiter.exceeded()).toBe(false); // 1 ⇒ 同时 EXPIRE
    expect(calls.expire).toBe(1);
    expect(await limiter.exceeded()).toBe(false); // 2 ⇒ 不 EXPIRE
    expect(await limiter.exceeded()).toBe(false); // 600 = 达界内（>600 才拒）
    expect(calls.expire).toBe(1);
    expect(await limiter.exceeded()).toBe(true); // 601 ⇒ 429 面
    expect(calls.expire).toBe(1);
  });

  it('Redis 故障（INCR 抛）⇒ **fail-open 放行** + 响亮 WARN（不崩、不拒真回调）', async () => {
    const { limiter } = makeLimiter([1], new Error('ECONNREFUSED 10.0.0.9:6379'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let observed = false;
    try {
      expect(await limiter.exceeded()).toBe(false);
      // ⚠️ `mock.calls` 必须在 `mockRestore()` **之前**读（vitest 的 restore 会连记录一起清）。
      observed = warn.mock.calls.some((args) => String(args[0]).includes('fail-open'));
    } finally {
      warn.mockRestore();
    }
    expect(observed).toBe(true);
  });

  it('模块注册面：NotifyController ∈ controllers；NotifyService / NotifyRateLimiter ∈ providers', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(NotifyController);
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(NotifyService);
    expect(providers).toContain(NotifyRateLimiter);
  });
});
