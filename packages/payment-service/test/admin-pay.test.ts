/**
 * 支付片 T12：**管理面套件**（任务卡 Test: `admin-pay.test.ts`；规格 §2.4.2 八端点逐行 ·
 * ⚙️10 policy 条目说明 · §5 管理页 CSV 列逐字 · ⚙️9 非法源态 ⇒ 409+15009 · §2.4.2 末行
 * 〔actor 取 `x-admin-actor`；CSV = BOM + 公式注入消毒〕；设计 §7）。
 *
 * 覆盖面（九块）：
 *  ① 全部 SQL/CSV 表头/分页常量**全文钉**（一个字符漂移即红）；状态值域数组逐字；
 *  ② query 校验负例：未知键（逐字「未知查询参数：<key>」）· status 非状态机值 · userId 超长 ·
 *     from 非十进制 · cursor 非法（借 orders 的既有 10001 文案）· actor 超长；
 *  ③ orders：列表 JSON（过滤参数序 + keyset 条件 + nextCursor + 行投影恰 12 键）· 详情
 *     （notify_log 尾 20 条新→旧 + 404 借 10001「订单不存在」）· CSV（BOM + 列逐字 + CRLF +
 *     公式注入消毒 + 文件名）· **阻断-1 回归（v1.1.4）：游标回环/缺 `id` 响亮抛/编解码边界**；
 *  ④ refunds：列表 / 详情（与行同形）/ CSV 列逐字；
 *  ⑤ withdrawals：列表 / 详情（余额/cap 快照读；RPC 失败 ⇒ fail-closed 15003 变体）/
 *     CSV 列逐字；
 *  ⑥ review/confirm（真 HTTP）：200 透传 data（refund review / withdraw review / confirm）·
 *     401（缺 x-admin / 缺 x-admin-actor）· ③ 文案的 409+15009（服务层 DomainError 经映射，
 *     `{code,message}` 断言）· 10001；
 *  ⑦ actions（审计第六源）：JSON 行恰 5 键（at/actor/kind/refNo/detail）· kind 值集恰五
 *     （applied/approved/rejected/confirmed/rolled_back）· from/to/actor 参数逐字 · CSV 表头
 *     `at,actor,kind,ref_no,detail`；
 *  ⑧ 注册面（AppModule）+ HTTP_STATUS（15009→409）；
 *  ⑨ 阻断-1 回归（v1.1.4，真 HTTP）：≥51 行 ⇒ 第一页 nextCursor ⇒ 第二页 200 且不重叠/不重放。
 *
 * 夹具：**假 DataSource**（识别 SQL 形状 + 语句记录；SQL 一漂移即「未识别的 SQL」当场红）·
 * 假 Refund/Withdraw 服务（review/confirm 的 actor/参数断言与 15009 抛掷）· 假 currency 客户端
 * （`withdrawable` 可编程回执/失败）。
 * ⚠️ 真 HTTP 不用 fetch（假红族⑤纪律，照 withdraw-state/refund-state 先例）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequestRaw } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
// ⚠️ **值导入**：`DataSource` 同时是 DI token（探针模块的 provide）——`import type` 会在运行期 undefined。
import { DataSource } from 'typeorm';
import { CSV_BOM, ErrCode } from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import {
  ADMIN_ACTIONS_CSV_HEADER,
  ADMIN_ACTIONS_SELECT_BASE,
  ADMIN_ACTIONS_SUFFIX,
  ADMIN_NOTIFY_LOG_SQL,
  ADMIN_ORDER_DETAIL_SQL,
  ADMIN_ORDER_STATUSES,
  ADMIN_ORDERS_CSV_HEADER,
  ADMIN_ORDERS_LIST_CURSOR_COND,
  ADMIN_ORDERS_LIST_SUFFIX,
  ADMIN_ORDERS_SELECT_BASE,
  ADMIN_PAY_ORDERS_PAGE_SIZE,
  ADMIN_REFUNDS_CSV_HEADER,
  ADMIN_REFUNDS_LIST_SUFFIX,
  ADMIN_REFUNDS_SELECT_BASE,
  ADMIN_REFUND_DETAIL_SQL,
  ADMIN_REFUND_STATUSES,
  ADMIN_WITHDRAWALS_CSV_HEADER,
  ADMIN_WITHDRAWALS_LIST_SUFFIX,
  ADMIN_WITHDRAWALS_SELECT_BASE,
  ADMIN_WITHDRAW_DETAIL_SQL,
  ADMIN_WITHDRAW_STATUSES,
  AdminPayController,
} from '../src/admin/admin-pay.controller';
import { AlipayClient } from '../src/channel/alipay/client';
import { DomainError, HTTP_STATUS } from '../src/http/errors';
import { XAdminGuard } from '../src/http/x-admin.guard';
import { decodePayOrdersCursor, encodePayOrdersCursor } from '../src/orders/orders.service';
import { RefundService } from '../src/refund/refund.service';
import { CurrencyRpcClient } from '../src/rpc/currency.client';
import { WithdrawService } from '../src/withdraw/withdraw.service';

const ADMIN = 'admin';
const USER = 'a1b2c3d4-e5f6-0000-1111-222233334444'; // 36 字符 UUID 形态（user_id 列宽）
const NOW = new Date('2026-10-06T04:00:00.000Z'); // +08:00 2026-10-06 12:00

/* ======================================================================== *
 * ① SQL / CSV 表头 / 常量全文钉（规格 §5 逐字；单测钉全字符）
 * ======================================================================== */
describe('① 常量全文钉（规格 §5 管理页 CSV 列逐字；SQL 形状钉全字符）', () => {
  it('orders 读（列序 = §5 CSV 列序逐字 + `id` 前置——keyset 分页内部列；阻断-1 修复）与排序/keyset/详情', () => {
    expect(ADMIN_ORDERS_SELECT_BASE).toBe(
      'SELECT `id`, `order_no`, `user_id`, `package_yuan`, `amount_fen`, `coins`, `status`, `channel`, `trade_no`, `paid_at`, `credited_at`, `closed_at`, `created_at` FROM `payment_orders`',
    );
    expect(ADMIN_ORDERS_LIST_SUFFIX).toBe(' ORDER BY `created_at` DESC, `id` DESC LIMIT ?');
    // ⚠️ **无前导 AND**（真栈实证：旧形态在「无过滤 + cursor」时拼出 `FROM payment_orders AND …` = 500）。
    expect(ADMIN_ORDERS_LIST_CURSOR_COND).toBe('(`created_at` < ? OR (`created_at` = ? AND `id` < ?))');
    expect(ADMIN_ORDER_DETAIL_SQL).toBe(`${ADMIN_ORDERS_SELECT_BASE} WHERE \`order_no\` = ?`);
  });

  it('notify_log 尾 20（新→旧；raw_payload 不入投影——§2.3 仅记验签通过件）', () => {
    expect(ADMIN_NOTIFY_LOG_SQL).toBe(
      'SELECT `result`, `trade_status`, `amount_fen`, `client_ip`, `received_at` FROM `payment_notify_log` WHERE `order_no` = ? ORDER BY `id` DESC LIMIT 20',
    );
  });

  it('refunds / withdrawals 读（列序逐字）+ 详情（admin 面不按 user 收窄）', () => {
    expect(ADMIN_REFUNDS_SELECT_BASE).toBe(
      'SELECT `refund_no`, `order_no`, `user_id`, `coins`, `status`, `reason`, `reviewed_by`, `reviewed_at`, `refunded_at`, `created_at` FROM `payment_refunds`',
    );
    expect(ADMIN_REFUNDS_LIST_SUFFIX).toBe(' ORDER BY `created_at` DESC, `id` DESC');
    expect(ADMIN_REFUND_DETAIL_SQL).toBe(`${ADMIN_REFUNDS_SELECT_BASE} WHERE \`refund_no\` = ?`);

    expect(ADMIN_WITHDRAWALS_SELECT_BASE).toBe(
      'SELECT `withdraw_no`, `user_id`, `coins`, `status`, `timeout_at`, `reviewed_by`, `confirmed_by`, `voucher`, `rolled_back_at`, `created_at` FROM `payment_withdrawals`',
    );
    expect(ADMIN_WITHDRAWALS_LIST_SUFFIX).toBe(' ORDER BY `created_at` DESC, `id` DESC');
    expect(ADMIN_WITHDRAW_DETAIL_SQL).toBe(`${ADMIN_WITHDRAWALS_SELECT_BASE} WHERE \`withdraw_no\` = ?`);
  });

  it('actions 第六源：三表事件流 UNION ALL（五类语义：申请/审/驳回/确认/回滚）+ 排序', () => {
    expect(ADMIN_ACTIONS_SELECT_BASE).toBe(
      'SELECT t.`at` AS `at`, t.`actor` AS `actor`, t.`kind` AS `kind`, t.`ref_no` AS `refNo`, t.`detail` AS `detail` FROM (' +
        "SELECT `created_at` AS `at`, `user_id` AS `actor`, 'applied' AS `kind`, `order_no` AS `ref_no`, CONCAT('order packageYuan=', `package_yuan`, ' amountFen=', `amount_fen`, ' coins=', `coins`, ' status=', `status`) AS `detail` FROM `payment_orders`" +
        ' UNION ALL ' +
        "SELECT `created_at`, `user_id`, 'applied', `refund_no`, CONCAT('refund order=', `order_no`, ' coins=', `coins`, ' reason=', `reason`) FROM `payment_refunds`" +
        ' UNION ALL ' +
        "SELECT `reviewed_at`, `reviewed_by`, 'approved', `refund_no`, CONCAT('refund approve status=', `status`) FROM `payment_refunds` WHERE `reviewed_at` IS NOT NULL AND `status` IN ('approved','refunded')" +
        ' UNION ALL ' +
        "SELECT `reviewed_at`, `reviewed_by`, 'rejected', `refund_no`, CONCAT('refund reject status=', `status`) FROM `payment_refunds` WHERE `reviewed_at` IS NOT NULL AND `status` IN ('rejecting','rejected')" +
        ' UNION ALL ' +
        "SELECT `created_at`, `user_id`, 'applied', `withdraw_no`, CONCAT('withdraw coins=', `coins`, ' amountFen=', `amount_fen`) FROM `payment_withdrawals`" +
        ' UNION ALL ' +
        "SELECT `reviewed_at`, `reviewed_by`, 'approved', `withdraw_no`, CONCAT('withdraw approve status=', `status`) FROM `payment_withdrawals` WHERE `reviewed_at` IS NOT NULL AND (`rollback_reason` IS NULL OR `rollback_reason` = 'timeout')" +
        ' UNION ALL ' +
        "SELECT `reviewed_at`, `reviewed_by`, 'rejected', `withdraw_no`, CONCAT('withdraw reject status=', `status`) FROM `payment_withdrawals` WHERE `reviewed_at` IS NOT NULL AND `rollback_reason` = 'rejected'" +
        ' UNION ALL ' +
        "SELECT `confirmed_at`, `confirmed_by`, 'confirmed', `withdraw_no`, CONCAT('voucher=', `voucher`) FROM `payment_withdrawals` WHERE `confirmed_at` IS NOT NULL" +
        ' UNION ALL ' +
        "SELECT `rolled_back_at`, 'system', 'rolled_back', `withdraw_no`, 'reason=timeout' FROM `payment_withdrawals` WHERE `rolled_back_at` IS NOT NULL AND `rollback_reason` = 'timeout'" +
        ') AS t',
    );
    expect(ADMIN_ACTIONS_SUFFIX).toBe(' ORDER BY t.`at` DESC, t.`ref_no` ASC');
  });

  it('CSV 四组列**逐字**（§5：orders 12 / refunds 10 / withdrawals 10 / actions 5）', () => {
    expect(ADMIN_ORDERS_CSV_HEADER).toEqual([
      'order_no',
      'user_id',
      'package_yuan',
      'amount_fen',
      'coins',
      'status',
      'channel',
      'trade_no',
      'paid_at',
      'credited_at',
      'closed_at',
      'created_at',
    ]);
    expect(ADMIN_REFUNDS_CSV_HEADER).toEqual([
      'refund_no',
      'order_no',
      'user_id',
      'coins',
      'status',
      'reason',
      'reviewed_by',
      'reviewed_at',
      'refunded_at',
      'created_at',
    ]);
    expect(ADMIN_WITHDRAWALS_CSV_HEADER).toEqual([
      'withdraw_no',
      'user_id',
      'coins',
      'status',
      'timeout_at',
      'reviewed_by',
      'confirmed_by',
      'voucher',
      'rolled_back_at',
      'created_at',
    ]);
    expect(ADMIN_ACTIONS_CSV_HEADER).toEqual(['at', 'actor', 'kind', 'ref_no', 'detail']);
  });

  it('状态值域数组 = 协议状态机全值集（protocol/payment.ts 联合类型逐字）；分页常量', () => {
    expect(ADMIN_ORDER_STATUSES).toEqual(['created', 'paid', 'credited', 'closed']);
    expect(ADMIN_REFUND_STATUSES).toEqual([
      'holding',
      'pending',
      'approved',
      'rejecting',
      'rejected',
      'refunded',
      'failed',
    ]);
    expect(ADMIN_WITHDRAW_STATUSES).toEqual([
      'holding',
      'pending',
      'approved',
      'paid',
      'rolling_back',
      'rejected',
      'timeout_rolled_back',
      'failed',
    ]);
    expect(ADMIN_PAY_ORDERS_PAGE_SIZE).toBe(50);
  });
});

/* ======================================================================== *
 * 夹具
 * ======================================================================== */

interface OrderDbRow {
  order_no: string;
  user_id: string;
  package_yuan: number;
  amount_fen: number;
  coins: number;
  status: string;
  channel: string;
  trade_no: string | null;
  paid_at: Date | null;
  credited_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  id: number;
}

interface RefundDbRow {
  refund_no: string;
  order_no: string;
  user_id: string;
  coins: number;
  status: string;
  reason: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  refunded_at: Date | null;
  created_at: Date;
  id: number;
}

interface WithdrawDbRow {
  withdraw_no: string;
  user_id: string;
  coins: number;
  amount_fen: number;
  status: string;
  timeout_at: Date;
  reviewed_by: string | null;
  confirmed_by: string | null;
  voucher: string | null;
  rolled_back_at: Date | null;
  created_at: Date;
  id: number;
  rollback_reason: string | null;
}

interface NotifyDbRow {
  id: number;
  result: string;
  trade_status: string | null;
  amount_fen: number | null;
  client_ip: string | null;
  received_at: Date;
}

function orderRow(over: Partial<OrderDbRow> = {}): OrderDbRow {
  return {
    order_no: 'pay_' + Math.random().toString(36).slice(2, 12),
    user_id: USER,
    package_yuan: 6,
    amount_fen: 600,
    coins: 600,
    status: 'credited',
    channel: 'alipay',
    trade_no: '2026100622001',
    paid_at: NOW,
    credited_at: NOW,
    closed_at: null,
    created_at: NOW,
    id: 1,
    ...over,
  };
}

function refundRow(over: Partial<RefundDbRow> = {}): RefundDbRow {
  return {
    refund_no: 'rf_' + Math.random().toString(36).slice(2, 12),
    order_no: 'pay_x',
    user_id: USER,
    coins: 600,
    status: 'pending',
    reason: '不想要了',
    reviewed_by: null,
    reviewed_at: null,
    refunded_at: null,
    created_at: NOW,
    id: 1,
    ...over,
  };
}

function withdrawRow(over: Partial<WithdrawDbRow> = {}): WithdrawDbRow {
  const base: WithdrawDbRow = {
    withdraw_no: 'wd_' + Math.random().toString(36).slice(2, 12),
    user_id: USER,
    coins: 1000,
    amount_fen: 1000,
    status: 'pending',
    timeout_at: NOW,
    reviewed_by: null,
    confirmed_by: null,
    voucher: null,
    rolled_back_at: null,
    created_at: NOW,
    id: 1,
    rollback_reason: null,
  };
  return Object.assign(base, over);
}

/**
 * 假 DataSource：按 SQL **形状**识别（常量前缀/全等），语句全量记录供参数断言；
 * 未识别的 SQL **当场红**（SQL 常量一漂移就暴露）。
 */
class FakeAdminDb {
  orders: OrderDbRow[] = [];
  refunds: RefundDbRow[] = [];
  withdrawals: WithdrawDbRow[] = [];
  notifyLog: NotifyDbRow[] = [];
  /** actions UNION 的“结果行”（**原始驱动行形状** = SELECT 别名 at/actor/kind/refNo/detail；
   *  Record 形态让负例测试能注入「未对齐形状」的行——⚠️ 真栈实证：按列底名 `ref_no` 预置会与
   *  真驱动回值（别名 `refNo`）错位）。 */
  actions: Array<Record<string, unknown>> = [];
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  /** 控制器只调 query(sql, params)。 */
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    this.queries.push({ sql, params });
    if (sql === ADMIN_NOTIFY_LOG_SQL) {
      return [...this.notifyLog].sort((a, b) => b.id - a.id).slice(0, 20);
    }
    if (sql === ADMIN_ORDER_DETAIL_SQL) {
      return this.orders.filter((r) => r.order_no === params[0]);
    }
    if (sql.startsWith(ADMIN_ORDERS_SELECT_BASE)) {
      const isList = sql.endsWith(ADMIN_ORDERS_LIST_SUFFIX);
      if (!isList) return [...this.orders];
      // **焊点形状守卫**（真栈实证 2026-10-06）：列表 SQL 的尾巴必须是 `( WHERE …)? ORDER BY …`
      // ——旧实现「无过滤 + cursor」拼出 `FROM payment_orders AND (…)`（无 WHERE）= 真 SQL
      // 语法错 500，而「按前缀识别」的假库照单全收 ⇒ 形状守卫把这个盲点钉在假库层。
      if (!/^( WHERE .*)? ORDER BY .*$/.test(sql.slice(ADMIN_ORDERS_SELECT_BASE.length))) {
        throw new Error(`orders 列表 SQL 尾巴形状非法（缺 WHERE 焊点）：${sql}`);
      }
      // keyset 仿真（与真 SQL 同向：ORDER BY created_at DESC, id DESC + 游标条件 + LIMIT）——
      // 阻断-1 的「真 HTTP 翻页」用例要在此假库上翻出第二页（按插入序切片会遮蔽游标 bug）。
      let rows = [...this.orders].sort(
        (a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id - a.id,
      );
      if (sql.includes(ADMIN_ORDERS_LIST_CURSOR_COND)) {
        const at = (params[params.length - 4] as Date).getTime();
        const rowId = Number(params[params.length - 2]);
        rows = rows.filter(
          (r) => r.created_at.getTime() < at || (r.created_at.getTime() === at && r.id < rowId),
        );
      }
      const limit = Number(params[params.length - 1]);
      return rows.slice(0, limit);
    }
    if (sql === ADMIN_REFUND_DETAIL_SQL) {
      return this.refunds.filter((r) => r.refund_no === params[0]);
    }
    if (sql.startsWith(ADMIN_REFUNDS_SELECT_BASE)) {
      return sql.endsWith(ADMIN_REFUNDS_LIST_SUFFIX) ? [...this.refunds] : [...this.refunds];
    }
    if (sql === ADMIN_WITHDRAW_DETAIL_SQL) {
      return this.withdrawals.filter((r) => r.withdraw_no === params[0]);
    }
    if (sql.startsWith(ADMIN_WITHDRAWALS_SELECT_BASE)) {
      return [...this.withdrawals];
    }
    if (sql.startsWith(ADMIN_ACTIONS_SELECT_BASE)) {
      return [...this.actions];
    }
    throw new Error(`未识别的 SQL（假库按形状识别）：${sql}`);
  }
}

/** 假 currency 客户端（`withdrawable` 可编程回执/失败）。 */
function makeCurrency() {
  return {
    withdrawable: vi.fn(async () => ({ cap: 4321, balance: 8765 })),
  };
}

/** 假 Refund/Withdraw 服务（review/confirm 的 actor/参数断言与 15009 抛掷面）。 */
function makeServices() {
  return {
    refunds: {
      review: vi.fn(async (admin: string, refundNo: string, req: unknown) => ({
        refundNo,
        status: 'rejected',
        __admin: admin,
        __req: req,
      })),
    },
    withdrawals: {
      review: vi.fn(async (admin: string, withdrawNo: string, req: unknown) => ({
        withdrawNo,
        status: 'approved',
        __admin: admin,
        __req: req,
      })),
      confirmPaid: vi.fn(async (admin: string, withdrawNo: string, req: unknown) => ({
        withdrawNo,
        status: 'paid',
        __admin: admin,
        __req: req,
      })),
    },
  };
}

type AdminModuleOverrides = {
  ds: FakeAdminDb;
  currency: ReturnType<typeof makeCurrency>;
  svcs: ReturnType<typeof makeServices>;
};

function makeController({ ds, currency, svcs }: AdminModuleOverrides): AdminPayController {
  return new AdminPayController(
    ds.dataSource,
    currency as unknown as CurrencyRpcClient,
    svcs.refunds as unknown as RefundService,
    svcs.withdrawals as unknown as WithdrawService,
  );
}

/** 假 res（`@Res({passthrough:true})` 的最小面：setHeader 记录）。 */
function makeRes() {
  const headers: Record<string, string> = {};
  return {
    res: { setHeader: (name: string, value: string) => void (headers[name] = value) },
    headers,
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/* ======================================================================== *
 * ② query 校验负例
 * ======================================================================== */
describe('② query 校验负例（400 借 10001；「未知查询参数：<key>」与网关同句文案）', () => {
  let c: AdminPayController;

  beforeEach(() => {
    c = makeController({ ds: new FakeAdminDb(), currency: makeCurrency(), svcs: makeServices() });
  });

  const expect400 = async (p: Promise<unknown>, message: string | RegExp) => {
    const err = await p.then(
      () => null,
      (e: { getStatus(): number; getResponse(): unknown }) => e,
    );
    expect(err).not.toBeNull();
    expect(err!.getStatus()).toBe(400);
    const body = err!.getResponse() as { code: number; message: string; data: unknown };
    expect(body.code).toBe(ErrCode.BAD_PARAM);
    expect(body.data).toBeNull();
    if (message instanceof RegExp) expect(body.message).toMatch(message);
    else expect(body.message).toBe(message);
  };

  it('未知 query 键（第一个未知键即拒）', async () => {
    await expect400(c.ordersList({ smuggled: '1' }), '未知查询参数：smuggled');
    await expect400(c.refundsList({ x: '1' }), '未知查询参数：x');
    await expect400(c.withdrawalsList({ cursor: '1' }), '未知查询参数：cursor'); // 无分页面：cursor 也是未知键
    await expect400(c.actionsList({ cursor: '1' }), '未知查询参数：cursor');
  });

  it('status 非状态机值 / userId 超长 / from 非十进制 / actor 超长 / cursor 非法', async () => {
    await expect400(c.ordersList({ status: 'done' }), 'status 非法：须为订单状态机值之一');
    await expect400(c.refundsList({ status: 'paid' }), 'status 非法：须为退款状态机值之一');
    await expect400(c.withdrawalsList({ status: 'credited' }), 'status 非法：须为提现状态机值之一');
    await expect400(c.ordersList({ userId: 'x'.repeat(37) }), 'userId 非法：长度须为 1–36');
    await expect400(c.ordersList({ from: '1.5' }), 'from 非法：须为非负整数（epoch 毫秒）');
    await expect400(c.ordersList({ to: 'abc' }), 'to 非法：须为非负整数（epoch 毫秒）');
    await expect400(c.actionsList({ actor: 'x'.repeat(65) }), 'actor 非法：长度须为 1–64');
    await expect400(
      c.ordersList({ cursor: '!!!' }),
      /cursor 不合法：须为本服务签发的 nextCursor 原样回传/,
    );
  });

  it('合法值全部放行（不抛）；空 query 不落任何库（列表空结果也发一次查询）', async () => {
    const ds = new FakeAdminDb();
    const cc = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    await cc.ordersList({ status: 'credited', userId: USER, from: '1', to: '2' });
    expect(ds.queries).toHaveLength(1);
    await cc.ordersList({});
    expect(ds.queries).toHaveLength(2);
  });
});

/* ======================================================================== *
 * ③ orders
 * ======================================================================== */
describe('③ orders：列表（keyset）/ 详情（notify 尾 20）/ CSV 字节', () => {
  it('列表：过滤参数按列序（status→userId→from→to）+ cursor 条件 + LIMIT=51（50+1 判 hasMore）', async () => {
    const ds = new FakeAdminDb();
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    await c.ordersList({ status: 'paid', userId: USER, from: '1000', to: '2000' });
    const q = ds.queries[0]!;
    expect(q.sql).toBe(
      `${ADMIN_ORDERS_SELECT_BASE} WHERE \`status\` = ? AND \`user_id\` = ? AND \`created_at\` >= ? AND \`created_at\` < ?${ADMIN_ORDERS_LIST_SUFFIX}`,
    );
    expect(q.params).toEqual([
      'paid',
      USER,
      new Date(1000),
      new Date(2000),
      ADMIN_PAY_ORDERS_PAGE_SIZE + 1,
    ]);

    ds.queries.length = 0;
    await c.ordersList({ cursor: Buffer.from('1500:9', 'utf8').toString('base64url') });
    const q2 = ds.queries[0]!;
    // 🔴 「无过滤 + cursor」（管理页未选筛选项点「加载更多」）⇒ WHERE 必须仍在场——
    // 旧形态（` AND (` 前导）在此拼出 `FROM payment_orders AND …` = 真栈 500（波 4 修复批实证）。
    expect(q2.sql).toBe(
      `${ADMIN_ORDERS_SELECT_BASE} WHERE ${ADMIN_ORDERS_LIST_CURSOR_COND}${ADMIN_ORDERS_LIST_SUFFIX}`,
    );
    expect(q2.sql).not.toContain('payment_orders` AND');
    expect(q2.params).toEqual([new Date(1500), new Date(1500), 9, ADMIN_PAY_ORDERS_PAGE_SIZE + 1]);
  });

  it('列表响应：行投影恰 12 键（camelCase；时间 epoch ms）+ nextCursor 判定', async () => {
    const ds = new FakeAdminDb();
    const rows = Array.from({ length: ADMIN_PAY_ORDERS_PAGE_SIZE + 1 }, (_, i) =>
      orderRow({ id: i + 1, order_no: `pay_${String(i).padStart(4, '0')}` }),
    );
    ds.orders = rows;
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const page = (await c.ordersList({})).data;
    expect(page.items).toHaveLength(ADMIN_PAY_ORDERS_PAGE_SIZE); // 多取的一行不入响应
    expect(page.nextCursor).not.toBeNull();
    // 🔴 阻断-1 回归（v1.1.4）：游标必须过**自家解码器**且指向页尾行（created_at,id）——
    // 旧实现（投影漏 `id` + `?? 0`）签出 `rowId=0` ⇒ 此处必抛「cursor 不合法」。
    expect(decodePayOrdersCursor(page.nextCursor)).toEqual({
      createdAtMs: NOW.getTime(),
      rowId: 2, // 同 created_at 时按 id DESC：51 行 ⇒ 首页 = id 51..2，页尾 id=2
    });
    expect(Object.keys(page.items[0]!).sort()).toEqual(
      [
        'amountFen',
        'channel',
        'closedAt',
        'coins',
        'createdAt',
        'creditedAt',
        'orderNo',
        'paidAt',
        'packageYuan',
        'status',
        'tradeNo',
        'userId',
      ].sort(),
    );
    expect(page.items[0]!.paidAt).toBe(NOW.getTime());
    expect(page.items[0]!.closedAt).toBeNull();

    // 行数 ≤ 页大小 ⇒ 终页
    ds.orders = ds.orders.slice(0, 3);
    const last = (await c.ordersList({})).data;
    expect(last.nextCursor).toBeNull();
  });

  it('🔴 游标行缺 `id`（旧真 SQL 投影形状）⇒ 响亮抛（假库遮蔽族第 6 例钉固化；绝不 `?? 0` 静默兜底）', async () => {
    const ds = new FakeAdminDb();
    const rows = Array.from({ length: ADMIN_PAY_ORDERS_PAGE_SIZE + 1 }, (_, i) =>
      orderRow({ id: i + 1, order_no: `pay_noId_${String(i).padStart(4, '0')}` }),
    );
    for (const r of rows) delete (r as Partial<OrderDbRow>).id; // 模拟「真 SQL 未投影 id」的行形状
    ds.orders = rows;
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    await expect(c.ordersList({})).rejects.toThrow(/payment_orders\.id/);
  });

  it('游标编解码回环 + `rowId<1` 拒（阻断-1 曾静默签出自家拒收的 `rowId=0`）', () => {
    const ok = encodePayOrdersCursor(1_750_000_000_000, 1);
    expect(decodePayOrdersCursor(ok)).toEqual({ createdAtMs: 1_750_000_000_000, rowId: 1 });
    const zero = encodePayOrdersCursor(1_750_000_000_000, 0); // 旧 `?? 0` 兜底的产物
    expect(() => decodePayOrdersCursor(zero)).toThrow(/cursor 不合法/);
    expect(() => decodePayOrdersCursor(encodePayOrdersCursor(1_750_000_000_000, -1))).toThrow(
      /cursor 不合法/,
    );
  });

  it('详情：行 + notifyLog 尾 20（新→旧，六键投影）；不存在 ⇒ 404 借 10001「订单不存在」', async () => {
    const ds = new FakeAdminDb();
    ds.orders = [orderRow({ order_no: 'pay_d1' })];
    ds.notifyLog = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      result: 'ok',
      trade_status: 'TRADE_SUCCESS',
      amount_fen: 600,
      client_ip: '172.28.0.250',
      received_at: NOW,
    }));
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const detail = await c.orderDetail('pay_d1');
    expect(detail.data.orderNo).toBe('pay_d1');
    expect(detail.data.notifyLog).toHaveLength(20); // SQL LIMIT 20（假库同截）
    expect(Object.keys(detail.data.notifyLog[0]!).sort()).toEqual(
      ['amountFen', 'clientIp', 'receivedAt', 'result', 'tradeStatus'].sort(),
    );
    expect(ds.queries.some((x) => x.sql === ADMIN_NOTIFY_LOG_SQL)).toBe(true);

    const err = await c.orderDetail('pay_none').then(
      () => null,
      (e: { getStatus(): number; getResponse(): unknown }) => e,
    );
    expect(err!.getStatus()).toBe(404);
    expect(err!.getResponse()).toMatchObject({
      code: ErrCode.BAD_PARAM,
      message: '订单不存在',
      data: null,
    });
  });

  it('CSV：BOM + 列序逐字 + CRLF + 公式注入消毒（危险串前置 `\'`）', async () => {
    const ds = new FakeAdminDb();
    ds.orders = [
      orderRow({ order_no: 'pay_csv1', trade_no: '=cmd()', status: 'credited' }),
      orderRow({ order_no: 'pay_csv2', trade_no: 'normal', amount_fen: 100, coins: 100, paid_at: null, credited_at: null }),
    ];
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const { res, headers } = makeRes();
    const body = (await c.ordersCsv({}, res)) as string;

    expect(body.startsWith(CSV_BOM)).toBe(true);
    const lines = body.slice(1).replace(/\r\n$/, '').split('\r\n');
    expect(lines[0]).toBe(
      'order_no,user_id,package_yuan,amount_fen,coins,status,channel,trade_no,paid_at,credited_at,closed_at,created_at',
    );
    expect(body.endsWith('\r\n')).toBe(true);
    // 公式注入消毒：`=cmd()` ⇒ 前置 `'`
    expect(lines[1]).toContain("'=cmd()");
    // 空单元格：null ⇒ 空
    expect(lines[2]!.split(',')[8]).toBe('');
    expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(headers['Content-Disposition']).toMatch(/^attachment; filename="pay-orders-\d{8}-\d{6}\.csv"$/);

    // CSV 路径：无 cursor 键（未知即 400）且不带 LIMIT
    ds.queries.length = 0;
    const { res: res2 } = makeRes();
    await c.ordersCsv({ from: '1000' }, res2);
    expect(ds.queries[0]!.sql).toBe(
      `${ADMIN_ORDERS_SELECT_BASE} WHERE \`created_at\` >= ? ORDER BY \`created_at\` DESC, \`id\` DESC`,
    );
  });
});

/* ======================================================================== *
 * ④ refunds
 * ======================================================================== */
describe('④ refunds：列表 / 详情（同行形）/ CSV 列逐字', () => {
  it('列表：status/userId 过滤 + 无分页（SQL 无 LIMIT）；行投影恰 10 键', async () => {
    const ds = new FakeAdminDb();
    ds.refunds = [refundRow({ reviewed_by: 'finance1', reviewed_at: NOW, status: 'rejected' })];
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const out = await c.refundsList({ status: 'rejected', userId: USER });
    const q = ds.queries[0]!;
    expect(q.sql).toBe(
      `${ADMIN_REFUNDS_SELECT_BASE} WHERE \`status\` = ? AND \`user_id\` = ?${ADMIN_REFUNDS_LIST_SUFFIX}`,
    );
    expect(q.params).toEqual(['rejected', USER]);
    expect(Object.keys(out.data.items[0]!).sort()).toEqual(
      [
        'coins',
        'createdAt',
        'orderNo',
        'reason',
        'refundNo',
        'refundedAt',
        'reviewedAt',
        'reviewedBy',
        'status',
        'userId',
      ].sort(),
    );
    expect(out.data.items[0]!.reviewedAt).toBe(NOW.getTime());
  });

  it('详情：与行同形；不存在 ⇒ 404「退款单不存在」', async () => {
    const ds = new FakeAdminDb();
    ds.refunds = [refundRow({ refund_no: 'rf_d1', status: 'holding' })];
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const d = await c.refundDetail('rf_d1');
    expect(d.data.refundNo).toBe('rf_d1');
    expect(Object.keys(d.data).sort()).toEqual(
      ['coins', 'createdAt', 'orderNo', 'reason', 'refundNo', 'refundedAt', 'reviewedAt', 'reviewedBy', 'status', 'userId'].sort(),
    );
    const err = await c.refundDetail('rf_none').then(
      () => null,
      (e: { getStatus(): number; getResponse(): unknown }) => e,
    );
    expect(err!.getStatus()).toBe(404);
    expect(err!.getResponse()).toMatchObject({ code: ErrCode.BAD_PARAM, message: '退款单不存在' });
  });

  it('CSV：表头逐字（refunds 列）+ BOM；reason 含逗号/引号 ⇒ RFC4180 包裹', async () => {
    const ds = new FakeAdminDb();
    ds.refunds = [refundRow({ reason: '含,逗号"与引号' })];
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const { res, headers } = makeRes();
    const body = (await c.refundsCsv({}, res)) as string;
    const lines = body.slice(1).replace(/\r\n$/, '').split('\r\n');
    expect(lines[0]).toBe('refund_no,order_no,user_id,coins,status,reason,reviewed_by,reviewed_at,refunded_at,created_at');
    expect(lines[1]).toContain('"含,逗号""与引号"');
    expect(headers['Content-Disposition']).toMatch(/pay-refunds-/);
  });
});

/* ======================================================================== *
 * ⑤ withdrawals
 * ======================================================================== */
describe('⑤ withdrawals：列表 / 详情（余额/cap 快照读）/ CSV 列逐字', () => {
  it('列表：无分页；行投影恰 10 键（含 rolledBackAt）', async () => {
    const ds = new FakeAdminDb();
    ds.withdrawals = [withdrawRow({ status: 'paid', confirmed_by: 'finance1', voucher: '20261006-01' })];
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const out = await c.withdrawalsList({ status: 'paid' });
    expect(ds.queries[0]!.sql).toBe(
      `${ADMIN_WITHDRAWALS_SELECT_BASE} WHERE \`status\` = ?${ADMIN_WITHDRAWALS_LIST_SUFFIX}`,
    );
    expect(Object.keys(out.data.items[0]!).sort()).toEqual(
      [
        'coins',
        'confirmedBy',
        'createdAt',
        'reviewedBy',
        'rolledBackAt',
        'status',
        'timeoutAt',
        'userId',
        'voucher',
        'withdrawNo',
      ].sort(),
    );
  });

  it('详情：行 + 余额/cap 快照读（currency.withdrawable，同 ownerId）；RPC 失败 ⇒ fail-closed 409/15003', async () => {
    const ds = new FakeAdminDb();
    ds.withdrawals = [withdrawRow({ withdraw_no: 'wd_d1' })];
    const currency = makeCurrency();
    const c = makeController({ ds, currency, svcs: makeServices() });
    const d = await c.withdrawDetail('wd_d1');
    expect(d.data.balance).toBe(8765);
    expect(d.data.withdrawable).toBe(4321);
    expect(currency.withdrawable).toHaveBeenCalledWith({ ownerId: USER });

    currency.withdrawable.mockRejectedValueOnce(new Error('TCP 超时'));
    const err = await c.withdrawDetail('wd_d1').then(
      () => null,
      (e: { getStatus(): number; getResponse(): unknown }) => e,
    );
    expect(err!.getStatus()).toBe(409);
    expect(err!.getResponse()).toMatchObject({
      code: ErrCode.PAY_WITHDRAW_UNAVAILABLE,
      message: '提现详情读取失败（服务暂时不可用，请稍后重试）',
    });

    const err404 = await c.withdrawDetail('wd_none').then(
      () => null,
      (e: { getStatus(): number; getResponse(): unknown }) => e,
    );
    expect(err404!.getStatus()).toBe(404);
    expect(err404!.getResponse()).toMatchObject({ message: '提现单不存在' });
  });

  it('CSV：表头逐字（withdrawals 列）+ BOM', async () => {
    const ds = new FakeAdminDb();
    ds.withdrawals = [withdrawRow({ status: 'timeout_rolled_back', rolled_back_at: NOW })];
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const { res, headers } = makeRes();
    const body = (await c.withdrawalsCsv({}, res)) as string;
    const lines = body.slice(1).replace(/\r\n$/, '').split('\r\n');
    expect(lines[0]).toBe(
      'withdraw_no,user_id,coins,status,timeout_at,reviewed_by,confirmed_by,voucher,rolled_back_at,created_at',
    );
    expect(lines[1]!.split(',')[8]).toBe(String(NOW.getTime())); // rolled_back_at ⇒ epoch ms
    expect(headers['Content-Disposition']).toMatch(/pay-withdrawals-/);
  });
});

/* ======================================================================== *
 * ⑦ actions（审计第六源）
 * ======================================================================== */
describe('⑦ actions：JSON 五键 / kind 值集 / 过滤参数逐字 / CSV 表头', () => {
  it('JSON：行恰 5 键（at/actor/kind/refNo/detail）；at 为 epoch ms', async () => {
    const ds = new FakeAdminDb();
    ds.actions = [
      { at: NOW, actor: 'admin', kind: 'confirmed', refNo: 'wd_1', detail: 'voucher=V-1' },
      { at: NOW, actor: USER, kind: 'applied', refNo: 'rf_1', detail: 'refund order=pay_1 coins=600' },
    ];
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const out = await c.actionsList({});
    expect(out.data.items).toHaveLength(2);
    expect(Object.keys(out.data.items[0]!).sort()).toEqual(['at', 'actor', 'detail', 'kind', 'refNo'].sort());
    expect(out.data.items[0]!.at).toBe(NOW.getTime());
    expect(['applied', 'approved', 'rejected', 'confirmed', 'rolled_back']).toContain(
      out.data.items[0]!.kind,
    );
  });

  it('过滤：from/to（半开 [from,to)）+ actor —— 参数逐字；SQL = UNION 基句 + WHERE + 排序', async () => {
    const ds = new FakeAdminDb();
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    await c.actionsList({ from: '1000', to: '2000', actor: 'admin' });
    const q = ds.queries[0]!;
    expect(q.sql).toBe(
      `${ADMIN_ACTIONS_SELECT_BASE} WHERE t.\`at\` >= ? AND t.\`at\` < ? AND t.\`actor\` = ?${ADMIN_ACTIONS_SUFFIX}`,
    );
    expect(q.params).toEqual([new Date(1000), new Date(2000), 'admin']);
  });

  it('CSV：表头 `at,actor,kind,ref_no,detail` 逐字 + BOM + detail 含逗号安全转义', async () => {
    const ds = new FakeAdminDb();
    ds.actions = [
      { at: NOW, actor: 'admin', kind: 'rejected', refNo: 'rf_9', detail: 'a,b"c' },
    ];
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    const { res, headers } = makeRes();
    const body = (await c.actionsCsv({}, res)) as string;
    const lines = body.slice(1).replace(/\r\n$/, '').split('\r\n');
    expect(lines[0]).toBe('at,actor,kind,ref_no,detail');
    expect(lines[1]).toBe(`${NOW.getTime()},admin,rejected,rf_9,"a,b""c"`);
    expect(headers['Content-Disposition']).toMatch(/pay-actions-/);
  });

  it('🔴 行形状破损 ⇒ 响亮抛（真栈实证钉：按列底名 ref_no 取会 String(undefined) 成字面量 "undefined"）', async () => {
    const ds = new FakeAdminDb();
    // 模拟「按列底名而非 SELECT 别名」的形状（真 MySQL 回值是别名 refNo ⇒ 底名必 undefined）。
    ds.actions = [{ at: NOW, actor: 'admin', kind: 'rejected', ref_no: 'rf_9', detail: 'x' }];
    const c = makeController({ ds, currency: makeCurrency(), svcs: makeServices() });
    await expect(c.actionsList({})).rejects.toThrow(/行形状破损/);
  });
});

/* ======================================================================== *
 * ⑧ 注册面 + HTTP_STATUS
 * ======================================================================== */
describe('⑧ 注册面与错误码表（未注册 = 真容器 404/启动崩；不补表 = 409 静默变 500）', () => {
  it('AppModule：AdminPayController ∈ controllers（T6 纪律）', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(AdminPayController);
  });

  it('HTTP_STATUS：15009 → 409（⚙️8 表）', () => {
    expect(HTTP_STATUS[ErrCode.PAY_STATE_CONFLICT]).toBe(409);
  });
});

/* ======================================================================== *
 * ⑨ 阻断-1 回归（v1.1.4）：keyset 翻页经真 Nest 管线——第二页 200、不重叠不重放
 * ======================================================================== */
describe('⑨ 阻断-1 回归（v1.1.4）：管理订单翻页（真 HTTP；≥51 行）', () => {
  it('第一页 50 行 + nextCursor ⇒ 第二页 200 且与第一页零重叠/零重放（旧实现必 400/10001）', async () => {
    const ds = new FakeAdminDb();
    const t0 = NOW.getTime();
    // 51 行、插入序 ≠ 时间序（顺带钉「新→旧」排序方向）；id 与时间同向。
    ds.orders = Array.from({ length: 51 }, (_, i) =>
      orderRow({
        id: i + 1,
        order_no: `pay_w4_${String(i).padStart(4, '0')}`,
        created_at: new Date(t0 - (50 - i) * 1000),
      }),
    );

    @Module({
      controllers: [AdminPayController],
      providers: [
        { provide: DataSource, useValue: ds.dataSource },
        { provide: CurrencyRpcClient, useValue: makeCurrency() },
        { provide: RefundService, useValue: makeServices().refunds },
        { provide: WithdrawService, useValue: makeServices().withdrawals },
        { provide: XAdminGuard, useValue: new XAdminGuard() },
      ],
    })
    class AdminPageProbeModule {}

    const app = await NestFactory.create(AdminPageProbeModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    try {
      const p1 = await httpCall(port, '/api/admin/pay/orders', { headers: { 'x-admin': '1' } });
      expect(p1.status).toBe(200);
      const b1 = JSON.parse(p1.body) as {
        data: { items: Array<{ orderNo: string }>; nextCursor: string | null };
      };
      expect(b1.data.items).toHaveLength(50);
      expect(b1.data.items[0]!.orderNo).toBe('pay_w4_0050'); // 新→旧（created_at DESC）
      expect(b1.data.items[49]!.orderNo).toBe('pay_w4_0001');
      expect(b1.data.nextCursor).not.toBeNull();

      const p2 = await httpCall(
        port,
        `/api/admin/pay/orders?cursor=${encodeURIComponent(b1.data.nextCursor!)}`,
        { headers: { 'x-admin': '1' } },
      );
      expect(p2.status).toBe(200); // 🔴 旧实现（投影缺 id ⇒ rowId=0）此处必 400/10001
      const b2 = JSON.parse(p2.body) as {
        code: number;
        data: { items: Array<{ orderNo: string }>; nextCursor: string | null };
      };
      expect(b2.code).toBe(ErrCode.OK);
      expect(b2.data.items).toHaveLength(1);
      expect(b2.data.nextCursor).toBeNull();
      // 不重叠/不重放：第二页唯一一行不在第一页里，且恰为最老一行。
      const firstPage = new Set(b1.data.items.map((r) => r.orderNo));
      expect(b2.data.items.every((r) => !firstPage.has(r.orderNo))).toBe(true);
      expect(b2.data.items[0]!.orderNo).toBe('pay_w4_0000');
    } finally {
      await app.close();
    }
  });
});

/* ======================================================================== *
 * ⑥ review/confirm 真 HTTP（node:http；假服务注入口）
 * ======================================================================== */
describe('⑥ review/confirm（真 Nest 管线 + node:http）：200 / 401 / 409+15009 / 10001', () => {
  async function startApp() {
    const ds = new FakeAdminDb();
    const currency = makeCurrency();
    const svcs = makeServices();

    @Module({
      controllers: [AdminPayController],
      providers: [
        { provide: DataSource, useValue: ds.dataSource },
        { provide: CurrencyRpcClient, useValue: currency },
        { provide: RefundService, useValue: svcs.refunds },
        { provide: WithdrawService, useValue: svcs.withdrawals },
        { provide: XAdminGuard, useValue: new XAdminGuard() },
      ],
    })
    class AdminPayProbeModule {}

    const app = await NestFactory.create(AdminPayProbeModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    return { app, port, ds, svcs };
  }

  const AUTH = { 'x-admin': '1', 'x-admin-actor': ADMIN, 'content-type': 'application/json' };

  it('退款审：200 ⇒ data = 服务回执；actor/refundNo/body 逐字传给服务', async () => {
    const { app, port, svcs } = await startApp();
    try {
      const res = await httpCall(port, '/api/admin/pay/refunds/rf_1/review', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ action: 'reject', note: '证据不足' }),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { code: number; data: Record<string, unknown> };
      expect(body.code).toBe(ErrCode.OK);
      expect(body.data.refundNo).toBe('rf_1');
      expect(body.data.status).toBe('rejected');
      expect(svcs.refunds.review).toHaveBeenCalledWith(ADMIN, 'rf_1', { action: 'reject', note: '证据不足' });
    } finally {
      await app.close();
    }
  });

  it('提现审 / 登记打款：200 ⇒ 服务回执透传（confirm 走 confirmPaid）', async () => {
    const { app, port, svcs } = await startApp();
    try {
      const rev = await httpCall(port, '/api/admin/pay/withdrawals/wd_1/review', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(rev.status).toBe(200);
      expect((JSON.parse(rev.body) as { data: { status: string } }).data.status).toBe('approved');
      expect(svcs.withdrawals.review).toHaveBeenCalledWith(ADMIN, 'wd_1', { action: 'approve' });

      const conf = await httpCall(port, '/api/admin/pay/withdrawals/wd_1/confirm', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ voucher: 'V-2026-10-06-1', note: '已线下打款' }),
      });
      expect(conf.status).toBe(200);
      expect((JSON.parse(conf.body) as { data: { status: string } }).data.status).toBe('paid');
      expect(svcs.withdrawals.confirmPaid).toHaveBeenCalledWith(ADMIN, 'wd_1', {
        voucher: 'V-2026-10-06-1',
        note: '已线下打款',
      });
    } finally {
      await app.close();
    }
  });

  it('🔴 409 + 15009：服务层 DomainError 原样翻成契约码（message 含当前态与合法动作）', async () => {
    const { app, port, svcs } = await startApp();
    svcs.refunds.review.mockRejectedValueOnce(
      new DomainError(ErrCode.PAY_STATE_CONFLICT, '状态已变更：当前状态 refunded，仅 pending 可 approve'),
    );
    try {
      const res = await httpCall(port, '/api/admin/pay/refunds/rf_9/review', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(res.status).toBe(409);
      const body = JSON.parse(res.body) as { code: number; message: string; data: unknown };
      expect(body.code).toBe(ErrCode.PAY_STATE_CONFLICT);
      expect(body.message).toContain('当前状态 refunded');
      expect(body.message).toContain('仅 pending 可 approve');
      expect(body.data).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('401：缺 x-admin / 缺 x-admin-actor（写面 fail-closed；读面不强求 actor）', async () => {
    const { app, port, ds } = await startApp();
    try {
      const noAdmin = await httpCall(port, '/api/admin/pay/refunds/rf_1/review', {
        method: 'POST',
        headers: { 'x-admin-actor': ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(noAdmin.status).toBe(401);
      expect(JSON.parse(noAdmin.body) as { code: number }).toMatchObject({ code: ErrCode.UNAUTHENTICATED });

      const noActor = await httpCall(port, '/api/admin/pay/withdrawals/wd_1/confirm', {
        method: 'POST',
        headers: { 'x-admin': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ voucher: 'V1' }),
      });
      expect(noActor.status).toBe(401);
      expect((JSON.parse(noActor.body) as { message: string }).message).toBe('管理身份缺失');

      // 读面：x-admin 够用（不要求 actor），真 Query 环下拉列表
      ds.orders = [orderRow({ order_no: 'pay_ro' })];
      const read = await httpCall(port, '/api/admin/pay/orders?status=credited', { headers: { 'x-admin': '1' } });
      expect(read.status).toBe(200);
      const readBody = JSON.parse(read.body) as { data: { items: Array<{ orderNo: string }> } };
      expect(readBody.data.items[0]!.orderNo).toBe('pay_ro');
    } finally {
      await app.close();
    }
  });

  it('10001：action 非法由服务层拒（此处假服务不打桩——换真 RefundService 的真校验走 review 会落库，故以守卫+路由面为准）' , async () => {
    // review 的 action/note 形状校验 = RefundService/WithdrawService 的既有职责
    //（refund-state ⑪ / withdraw-state 已钉 10001 全表）；本套件只钉**管理面递达**：
    // 到 409+15009/200 两条真实路径 + 401 守卫。这里补一条未知查询键在读列表上的 400。
    const { app, port } = await startApp();
    try {
      const res = await httpCall(port, '/api/admin/pay/actions?cursor=1', { headers: { 'x-admin': '1' } });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body) as { message: string }).toMatchObject({ message: '未知查询参数：cursor' });
    } finally {
      await app.close();
    }
  });

  it('CSV 经真 HTTP：响应头 + BOM 首三字节（EF BB BF）逐字节', async () => {
    const { app, port, ds } = await startApp();
    ds.actions = [{ at: NOW, actor: 'admin', kind: 'applied', refNo: 'pay_1', detail: 'order' }];
    try {
      const res = await httpCallRaw(port, '/api/admin/pay/actions.csv', { headers: { 'x-admin': '1' } });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/pay-actions-\d{8}-\d{6}\.csv/);
      expect([res.bytes[0], res.bytes[1], res.bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
      expect(res.bytes.toString('utf8')).toContain('at,actor,kind,ref_no,detail');
    } finally {
      await app.close();
    }
  });
});

function httpCall(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
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

/** 字节保真版（CSV 首三字节 BOM 判据用；utf8 解码会吞 BOM）。 */
function httpCallRaw(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = httpRequestRaw(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// 未使用的导入守卫（AlipayClient 供 DI 图完整性断言保留；flush 供异步边界预留）。
void flush;
void AlipayClient;
