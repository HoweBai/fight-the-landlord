/**
 * 支付片 T7：**订单链**（下单 / 查询 / 补单 / 过期；规格 §2.4.1 #1–#4 · §3.1 · §3.4 ①② · ⚙️4/⚙️5/⚙️16）。
 *
 * ─── 职责边界（本卡）────────────────────────────────────────────────────
 *  - **只做迁移与时序**：状态迁移（条件 UPDATE，`order-state.ts` 常量）+ 渠道调用（经
 *    `PaymentChannel` 抽象，T6 注入）。**入账**（apply + `paid→credited`）**不在本卡** —— T9
 *    在扫描/回调链上接 `currency.apply` 与本文件的迁移路径；回调唯一信任入口在 T8。
 *  - 扫描方法（`closeExpired`/`sweepCreated`）**可测地裸跑**（返回计数）；`pay.scanIntervalMs`
 *    （配置键，第 35 键）周期循环的挂载归 T9 的 `scan.service.ts`（⚙️16），本卡不建定时器。
 *
 * ─── 关键口径（逐条）───────────────────────────────────────────────────
 *  - **⚙️4 单号**：`pay_` + base36(ms) + 6 位随机 base36（字符集 `[0-9a-z_]`、长 ≤ 32，
 *    满足支付宝 out_trade_no）；**唯一性由 `uk_order_no` UK 兜底**（撞 UK ⇒ 重生成重试，
 *    不做「SELECT 查重再 INSERT」的竞态面）。
 *  - **⚙️5 金额**：`amount_fen = packageYuan × 100` · `coins = packageYuan × coinPerYuan`
 *    （下单时刻快照，行内 `coin_per_yuan` 同锁）——禁浮点；渠道 `total_amount` 用
 *    `fen2yuan(amount_fen)` 字符串元。
 *  - **开关纪律**：`pay.rechargeEnabled` 关 ⇒ 15008（**只挡新建**——在途单照常由回调/扫描收敛）；
 *    「配置从未拉到」时 getter 回落 false ⇒ 同一出口（fail-closed，不单设分支）。
 *  - **复用规则**（§2.1 短时幂等）：同用户 + 同档位 + **未过期 `created`** 单存在 ⇒ 复用
 *    （重生成 payUrl、**不新行**）；不同档位并存；过期不复用。
 *  - **站点基址 `pay.channel.publicBaseUrl`**（管理化后由「管理页 → 支付渠道」供给；T9）：
 *    `notify_url=<base>/pay/notify/alipay` · `return_url=<base>/?pay=<orderNo>`；**每次调用现拉**
 *    （`PayChannelConfigService.get()`，§3.3 映射表）、**缺失 ⇒ 15001**（不阻塞启动）。
 *    在**插行之前**解析 —— 缺失时不产孤儿行。
 *  - **`last_error` 写点**（§2.3：orders = 过期关闭/补单查询失败摘要）：渠道失败摘要直写
 *    （T6 `ChannelFailure.lastError` 已 ≤255）。⚠️ **创建失败不写**（写点清单不含它——行保留、
 *    重试可复用）。
 *  - **close 报「已支付」**（`ACQ.TRADE_HAS_SUCCESS`）⇒ 转 paid 路径（重开 + `late_reopen_at`）
 *    ——防「已付被关」（§4.5）；其余 close 失败只记 `last_error`（本地已 closed，渠道侧
 *    未关的 trade 会由 `timeout_express` 自然关闭/由迟到回调重开兜底）。
 *  - **补单门槛**（§3.1/§4.5）：`created` 且 `created_at` 超 **5 分钟** 且 **未过期** ⇒
 *    `trade.query`；仅 `TRADE_SUCCESS` 走 paid 路径（`TRADE_CLOSED`/不存在 ⇒ 留待过期）。
 *  - **`payment_order_pending{state}`**（§2.6·2）：两扫描轮末刷新（`pending_pay` = `created`
 *    行数；`paid_uncredited` = `paid` 行数）；`sync` 造成迁移时也刷新（保持读数新鲜）。
 */

import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import type { PayCreateOrderResponse, PayOrderInfo, PayOrderStatus, PayOrdersPage } from '@fight-the-landlord/protocol';
import { PAY_ORDER_PREFIX } from '@fight-the-landlord/protocol';
import { AlipayClient } from '../channel/alipay/client';
import { fen2yuan } from '../channel/alipay/params';
import type {
  ChannelResult,
  MobileCashierData,
  PaymentChannel,
  WapPayFormData,
} from '../channel/payment-channel.interface';
import { cashierTokenSecret, signCashierToken } from '../cashier/cashier-token';
import { ConfigCacheService } from '../config/config-cache.service';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析构造参时只见 undefined、启动即崩。
import { PayChannelConfigService } from '../config/pay-channel.config.service';
import { DomainError } from '../http/errors';
import { paymentOrderPending } from '../metrics/payment.metrics';
import { clampMineLimit, decodePayOrdersCursor, encodePayOrdersCursor } from './pay-orders-cursor';
import { ScanService } from '../scan/scan.service';
import {
  ORDER_CLOSED_TO_PAID_REOPEN_SQL,
  ORDER_CLOSE_EXPIRED_SQL,
  ORDER_CREATED_TO_PAID_SQL,
} from './order-state';

/**
 * T13：keyset 游标件（含 `mine` 默认页大小/上限、limit clamp、游标编解码）**拆至叶子模块**
 * `pay-orders-cursor.ts`（照 T9 `scan/replay-anchor.ts` 先例——`withdraw/refund.service`
 * 的 `mine` 要 import 它，留在本文件则成 `withdraw → orders → scan → withdraw` 的 CJS 环）。
 * 这里 **re-export** 保持既有消费面（admin-pay.controller / orders-state 套件）零漂移。
 */
export {
  PAY_ORDERS_MINE_DEFAULT_LIMIT,
  PAY_ORDERS_MINE_MAX_LIMIT,
  clampMineLimit,
  encodePayOrdersCursor,
  decodePayOrdersCursor,
} from './pay-orders-cursor';

/** 支付宝 trade.close 里「已支付」的判别码（close 转 paid 路径的素材，T6 材质面）。 */
const ALIPAY_SUB_CODE_TRADE_HAS_SUCCESS = 'ACQ.TRADE_HAS_SUCCESS';

/* ------------------------------- SQL 形状 ------------------------------- */
/* ⚠️ 全部为**裸 SQL**（不用 TypeORM entity；金额全 int、时间列是 datetime(3) 的 Date）。
 * ⚠️ **时间权威 = DB `NOW(3)`**（照 risk/records 先例）：`expires_at` 由 INSERT 侧
 * `NOW(3) + INTERVAL ? MINUTE` 生成、门槛判定（5 分钟/过期）都在 SQL 里比较——应用层
 * 不掺 JS 时钟（生产同宿主机双源本可互推，但**单点权威**免掉一整类边界争议；测试用假
 * 时钟驱动同一条 SQL）。 */

const ORDER_COLUMNS =
  '`id`, `order_no`, `status`, `coins`, `amount_fen`, `package_yuan`, `coin_per_yuan`, `expires_at`, `created_at`, `paid_at`, `credited_at`, `closed_at`';

const SELECT_BY_ORDER_NO_SQL = `SELECT ${ORDER_COLUMNS} FROM \`payment_orders\` WHERE \`order_no\` = ? AND \`user_id\` = ?`;

/**
 * 桥接面公开查单（**不带 user_id** —— `/pay/cashier/:orderNo` 是浏览器直连公开面，
 * 访问控制由 HMAC 能力 token 承担，见 `cashier/cashier-token.ts`）。
 */
const SELECT_CASHIER_ORDER_SQL =
  'SELECT `status`, `package_yuan`, `amount_fen` FROM `payment_orders` WHERE `order_no` = ?';

/** 桥接页可支付判据（DB 时钟权威：created 且未过期——token 之外的终局闸）。 */
const SELECT_CASHIER_PAYABLE_SQL =
  "SELECT 1 AS `ok` FROM `payment_orders` WHERE `order_no` = ? AND `status` = 'created' AND `expires_at` > NOW(3)";

const SELECT_REUSABLE_SQL = `SELECT ${ORDER_COLUMNS} FROM \`payment_orders\` WHERE \`user_id\` = ? AND \`package_yuan\` = ? AND \`status\` = 'created' AND \`expires_at\` > NOW(3) ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT 1`;

/** `expires_at` 由 DB 时钟生成（参数尾 = 有效分钟数）；插后读回行（响应取行内快照值）。 */
const INSERT_ORDER_SQL =
  'INSERT INTO `payment_orders` (`order_no`, `user_id`, `package_yuan`, `amount_fen`, `coins`, `coin_per_yuan`, `expires_at`) VALUES (?, ?, ?, ?, ?, ?, NOW(3) + INTERVAL ? MINUTE)';

const SELECT_MINE_BASE_SQL = `SELECT ${ORDER_COLUMNS} FROM \`payment_orders\` WHERE \`user_id\` = ?`;
const MINE_CURSOR_COND_SQL = ' AND (`created_at` < ? OR (`created_at` = ? AND `id` < ?))';
const MINE_ORDER_LIMIT_SQL = ' ORDER BY `created_at` DESC, `id` DESC LIMIT ?';

const SELECT_EXPIRED_SQL =
  "SELECT `order_no` FROM `payment_orders` WHERE `status` = 'created' AND `expires_at` < NOW(3)";

/** 补单门槛（§3.1「创建超 5 分钟」）**单行**形态——`sync` 用（扫描候选是批量形态）。 */
const SELECT_SYNC_ELIGIBLE_SQL =
  "SELECT `order_no` FROM `payment_orders` WHERE `order_no` = ? AND `status` = 'created' AND `created_at` < NOW(3) - INTERVAL 5 MINUTE AND `expires_at` > NOW(3)";

const SELECT_SWEEP_CANDIDATES_SQL =
  "SELECT `order_no` FROM `payment_orders` WHERE `status` = 'created' AND `created_at` < NOW(3) - INTERVAL 5 MINUTE AND `expires_at` > NOW(3)";

const SELECT_STATUS_SQL = 'SELECT `status` FROM `payment_orders` WHERE `order_no` = ?';

const UPDATE_LAST_ERROR_SQL = 'UPDATE `payment_orders` SET `last_error` = ? WHERE `order_no` = ?';

const COUNT_BY_STATUS_SQL = 'SELECT COUNT(*) AS `count` FROM `payment_orders` WHERE `status` = ?';

/* ------------------------------ 行形态/工具 ------------------------------ */

/** 读出的行（列名即 SQL 别名；datetime 归一在这一层）。 */
interface OrderRow {
  id: number | string;
  order_no: string;
  status: string;
  coins: number | string;
  amount_fen: number | string;
  package_yuan: number | string;
  expires_at: Date | string;
  created_at: Date | string;
  paid_at: Date | string | null;
  credited_at: Date | string | null;
  closed_at: Date | string | null;
}

const ORDER_STATUSES: readonly PayOrderStatus[] = ['created', 'paid', 'credited', 'closed'];

function asOrderStatus(value: unknown): PayOrderStatus {
  if (ORDER_STATUSES.includes(value as PayOrderStatus)) return value as PayOrderStatus;
  // 不在状态机里的值不是合法状态（protocol/payment.ts 的联合类型注释）——响亮拒绝。
  throw new Error(`payment_orders.status 非状态机值：${JSON.stringify(value)}`);
}

/** 数值列（int/bigint 的驱动形态两种）⇒ 安全整数（读不出 ⇒ 抛，不静默 NaN 进 JSON）。 */
function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/** `datetime(3)` 的三种驱动形态 ⇒ epoch ms 整数（照 `records.service.ts` 先例）。 */
function toEpochMs(value: unknown, context: string): number {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(String(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`${context}：读出的时间不是有限毫秒（收到 ${JSON.stringify(value)}）`);
  }
  return ms;
}

function toEpochMsOrNull(value: unknown, context: string): number | null {
  return value === null || value === undefined ? null : toEpochMs(value, context);
}

/** 条件 UPDATE 的 `affectedRows` 判读（照 currency `apply.service.ts` 收紧口径：非整数 ⇒ 抛）。 */
function affectedRowsOf(result: unknown, context: string): number {
  const affected = (result as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof affected !== 'number' || !Number.isInteger(affected) || affected < 0) {
    throw new Error(`${context}：驱动未返回 affectedRows（收到 ${JSON.stringify(result)}）—— 拒绝继续`);
  }
  return affected;
}

/** ⚙️4：单号随机段（base36 6 位；`randomInt` 无模偏差）。 */
function randomBase36(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += randomInt(36).toString(36);
  return out;
}

/** ⚙️4：`pay_` + base36(毫秒) + 6 位随机 base36（字符集 `[0-9a-z_]`、长 ≤ 32）。 */
export function generatePayOrderNo(nowMs: number = Date.now()): string {
  return `${PAY_ORDER_PREFIX}${nowMs.toString(36)}${randomBase36(6)}`;
}

/** `uk_order_no` 撞 UK 的判别（唯一性兜底在本 UK，不在 SELECT 查重）。 */
function isDuplicateEntryError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ER_DUP_ENTRY';
}

/* --------------------------------- 服务 --------------------------------- */

/** `transitionToPaid` 的迁移结果（T8 回调以此为幂等判别面）。 */
export type PaidTransition = 'paid' | 'reopened' | 'already' | 'none';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  /** ⚠️ **值导入**四个依赖（DI 陷阱纪律：类型导入会被擦除 ⇒ 容器解析崩）。 */
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigCacheService) private readonly configCache: ConfigCacheService,
    @Inject(AlipayClient) private readonly channel: PaymentChannel,
    @Inject(PayChannelConfigService) private readonly payChannel: PayChannelConfigService,
  ) {}

  /**
   * T9：**入账钩子**（paid 之后立即尝试入账；`sync` 消费）。
   *
   * 🔴 **属性注入 + `forwardRef`**：`ScanService` 构造注入本类（循环 ①② 挂 T7 方法）
   * ⇒ `OrdersService ⇄ ScanService` 在 Nest 依赖图里互引，用 `forwardRef` 打断
   * （game-service `GameService ⇄ RobotClient` 先例；`scan.service.ts` 侧同为
   * `forwardRef` —— **两侧都要**，否则 CJS 环下装饰器求值读到半载模块 = 静默 DI 破损）。
   * 副作用：单测直接 `new OrdersService(...)` 时本属性为 `null`（不经容器）——调用点
   * `this.scan?.…` 空安全；生产由 AppModule 注册保证在场（**非 Optional**：缺注册 =
   * 启动即崩，不会静默断链）。
   */
  @Inject(forwardRef(() => ScanService))
  scan: ScanService | null = null;

  /**
   * T9：`sync` 的即时入账尝试（notify 侧同款语义）：**失败静默留给扫描**——本单的
   * 返回面（订单查询）不受入账结果影响；`creditOrder` 业务面不抛（stalled 返回），
   * DB 级异常在这里接住 + warn（下一轮扫描兜底；`paid` 事实已落库，不会丢钱）。
   */
  private async tryCredit(orderNo: string): Promise<void> {
    if (!this.scan) return; // 单测直构面（生产注册保证在场，见上面属性注）
    try {
      await this.scan.creditOrder(orderNo);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`即时入账失败（静默留给扫描重试）order_no=${orderNo}: ${reason}`);
    }
  }

  /* -------------------------------- 下单 -------------------------------- */

  /**
   * 下单（§2.4.1 #1）：开关 ⇒ 档位 ⇒ URL 素材 ⇒ 复用/插行 ⇒ `trade.wap.pay`。
   * 渠道失败 ⇒ 15001（**行保留**——重试走复用路径，同单号重生成链接）。
   */
  async createOrder(userId: string, packageYuan: unknown): Promise<PayCreateOrderResponse> {
    // ① 开关（15008；「配置从未拉到」时 getter 回落 false ⇒ 同一出口——fail-closed）。
    if (!this.configCache.rechargeEnabled()) {
      throw new DomainError(ErrCode.PAY_DISABLED, '充值暂未开放');
    }
    // ② 档位（配置权威；非整数/不在档位 ⇒ 10001）。
    const packages = this.configCache.rechargePackages();
    if (typeof packageYuan !== 'number' || !Number.isInteger(packageYuan) || !packages.includes(packageYuan)) {
      throw new DomainError(
        ErrCode.BAD_PARAM,
        `packageYuan 必须是 pay.rechargePackages 中的档位（收到 ${JSON.stringify(packageYuan)}）`,
      );
    }
    // ③ URL 素材**先于插行**解析（缺失 ⇒ 15001，不产孤儿行；每调用现拉，⚙️18 空串=未设）。
    const base = await this.publicBaseUrl();

    const coinPerYuan = this.configCache.coinPerYuan();
    const expireMinutes = this.configCache.orderExpireMinutes();
    const amountFen = packageYuan * 100; // ⚙️5：元 ⇒ 分（int）

    // ④ 复用（同用户+同档位+未过期 created ⇒ 重生成 payUrl、不新行）。
    const reusable = await this.queryRows<OrderRow[]>(SELECT_REUSABLE_SQL, [userId, packageYuan]);
    if (reusable.length > 0) {
      const row = reusable[0]!;
      const payUrl = await this.establishCashierPayment(row.order_no, packageYuan, amountFen, expireMinutes, base);
      return {
        orderNo: row.order_no,
        payUrl,
        expiresAt: toEpochMs(row.expires_at, 'orders.expires_at'),
      };
    }

    // ⑤ 插行（快照 coins/coin_per_yuan；`expires_at` 由 DB 时钟生成；单号撞 UK ⇒ 重生成重试）。
    const coins = packageYuan * coinPerYuan;
    const orderNo = await this.insertOrder({ userId, packageYuan, amountFen, coins, coinPerYuan, expireMinutes });

    // ⑥ 渠道探针 + 桥接 URL（失败 ⇒ 15001；**行保留**，重试可复用）。
    const payUrl = await this.establishCashierPayment(orderNo, packageYuan, amountFen, expireMinutes, base);
    const inserted = await this.loadOrderRow(userId, orderNo);
    if (!inserted) throw new Error(`订单 ${orderNo} INSERT 后读回失败（不变量破坏）`);
    return { orderNo, payUrl, expiresAt: toEpochMs(inserted.expires_at, 'orders.expires_at') };
  }

  /* ------------------------------ 查询/补单 ------------------------------ */

  /** `GET /api/pay/orders/:orderNo`（非本人/不存在 ⇒ 15002）。 */
  async getById(userId: string, orderNo: string): Promise<PayOrderInfo> {
    const row = await this.loadOrderRow(userId, orderNo);
    if (!row) throw new DomainError(ErrCode.PAY_ORDER_NOT_FOUND, '订单不存在或已失效');
    return toPayOrderInfo(row);
  }

  /**
   * `POST /api/pay/orders/:orderNo/sync`（§2.4.1 #3 / §3.1 补单）：
   * `created` 且超 5 分钟未过期 ⇒ `trade.query`；`TRADE_SUCCESS` ⇒ paid 迁移路径。
   * 查询失败只写 `last_error`（不把渠道故障翻成端点错误——用户面仍是订单查询）。
   */
  async sync(userId: string, orderNo: string): Promise<PayOrderInfo> {
    const row = await this.loadOrderRow(userId, orderNo);
    if (!row) throw new DomainError(ErrCode.PAY_ORDER_NOT_FOUND, '订单不存在或已失效');

    // 门槛判定走 SQL（DB 时钟权威）：`created` + 超 5 分钟 + 未过期。不合格原样返回。
    const eligible = await this.queryRows<{ order_no: string }[]>(SELECT_SYNC_ELIGIBLE_SQL, [orderNo]);
    if (eligible.length === 0) return toPayOrderInfo(row);

    const res = await this.channel.query({ outTradeNo: orderNo });
    if (!res.ok) {
      await this.setLastError(orderNo, res.lastError);
      return toPayOrderInfo(row);
    }
    if (res.data.found && res.data.tradeStatus === 'TRADE_SUCCESS') {
      const transition = await this.transitionToPaid(orderNo, res.data.tradeNo);
      if (transition === 'paid' || transition === 'reopened' || transition === 'already') {
        // T9：订单已达/新达 paid ⇒ **立即尝试入账**（设计 §4.4 时序：先 paid 落库、后 apply
        // —— 此处 paid 已落库；失败静默留给扫描，本端点返回面不受影响）。'already' 面同样
        // 尝试（幂等：已 credited ⇒ creditOrder 内 `skipped`，零 RPC）——重试单更快收敛。
        await this.tryCredit(orderNo);
      }
      if (transition === 'paid' || transition === 'reopened') {
        // 入账尝试之后再刷新（读数反映 post-credit 状态；pending_pay/paid_uncredited 两面）。
        await this.refreshOrderPendingGauges();
      }
    }
    const fresh = await this.loadOrderRow(userId, orderNo);
    return toPayOrderInfo(fresh ?? row);
  }

  /** `GET /api/pay/orders/mine`（keyset；只本人——`user_id` 是 WHERE 的第一条件）。 */
  async mine(userId: string, query: { cursor?: unknown; limit?: unknown } = {}): Promise<PayOrdersPage> {
    const limit = clampMineLimit(query.limit);
    // 游标**先于任何查询**校验：非法形态 ⇒ 10001，不落一次库。
    const cursor = query.cursor === undefined ? null : decodePayOrdersCursor(query.cursor);

    const rows = await this.queryPage(userId, cursor, limit);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    if (pageRows.length === 0) return { items: [], nextCursor: null };

    const items = pageRows.map(toPayOrderInfo);
    const last = pageRows[pageRows.length - 1]!;
    const nextCursor = hasMore
      ? encodePayOrdersCursor(toEpochMs(last.created_at, 'orders.created_at'), toSafeInt(last.id, 'orders.id'))
      : null;
    return { items, nextCursor };
  }

  /* ------------------------------ 状态迁移 ------------------------------ */

  /**
   * paid 迁移路径（回调/补单/close-已支付 共用；条件更新 ⇒ 并发安全）：
   *  ① 先试 `created→paid`（affected=1 ⇒ 'paid'）；
   *  ② affected=0 ⇒ 读现状：`closed` ⇒ 重开（记 `late_reopen_at` ⇒ 'reopened'）；
   *     `paid/credited` ⇒ 'already'（幂等面）；其余/不存在 ⇒ 'none'。
   *
   * ⚠️ **不做入账**（apply 在 T9）；`tradeNo` 可为 `null`（close-已支付分支拿不到单号）。
   */
  async transitionToPaid(orderNo: string, tradeNo: string | null): Promise<PaidTransition> {
    const moved = await this.queryRows<unknown>(ORDER_CREATED_TO_PAID_SQL, [tradeNo, orderNo]);
    if (affectedRowsOf(moved, `订单 ${orderNo} created→paid`) === 1) return 'paid';

    const current = await this.queryRows<Array<{ status: string }>>(SELECT_STATUS_SQL, [orderNo]);
    const status = current[0]?.status;
    if (status === 'closed') {
      const reopened = await this.queryRows<unknown>(ORDER_CLOSED_TO_PAID_REOPEN_SQL, [orderNo]);
      if (affectedRowsOf(reopened, `订单 ${orderNo} closed→paid 重开`) === 1) return 'reopened';
      return 'none'; // 并发窗口内被第三方再次迁移（如并发回调已重开）——交由调用方读现状
    }
    if (status === 'paid' || status === 'credited') return 'already';
    return 'none';
  }

  /* -------------------------------- 扫描 -------------------------------- */

  /**
   * 循环①：过期关闭（§3.1/§3.4①）。批量条件更新后**逐行尽力** `trade.close`：
   * close 报「已支付」（`ACQ.TRADE_HAS_SUCCESS`）⇒ 转 paid 路径（重开，防「已付被关」）；
   * 其余失败只写 `last_error`（渠道侧 trade 由 `timeout_express` 自然收口）。
   *
   * @returns 本轮**关闭行数**（= 关闭 UPDATE 的 affectedRows；重开不计减——它也是「本轮处理过」的行）。
   */
  async closeExpired(): Promise<number> {
    const rows = await this.queryRows<Array<{ order_no: string }>>(SELECT_EXPIRED_SQL);
    let closed = 0;
    if (rows.length > 0) {
      const result = await this.queryRows<unknown>(ORDER_CLOSE_EXPIRED_SQL);
      closed = affectedRowsOf(result, '订单过期关闭');
    }
    for (const row of rows) {
      const res = await this.channel.close({ outTradeNo: row.order_no });
      if (res.ok) continue;
      if (res.channelSubCode === ALIPAY_SUB_CODE_TRADE_HAS_SUCCESS) {
        // 已付被关 ⇒ 重开（closed→paid，记 late_reopen_at）——钱在手必入账。
        await this.transitionToPaid(row.order_no, null);
      } else {
        await this.setLastError(row.order_no, res.lastError);
      }
    }
    await this.refreshOrderPendingGauges();
    return closed;
  }

  /**
   * 循环②：主动查询补单（§3.1/§3.4②）。候选 = `created` 且超 5 分钟且未过期；
   * `TRADE_SUCCESS` ⇒ paid 迁移路径；查询失败写 `last_error`；`TRADE_CLOSED`/不存在留待过期。
   *
   * @returns 本轮**转入 paid 的行数**（条件更新竞争失败的不计）。
   */
  async sweepCreated(): Promise<number> {
    const rows = await this.queryRows<Array<{ order_no: string }>>(SELECT_SWEEP_CANDIDATES_SQL);
    let transitioned = 0;
    for (const row of rows) {
      const res = await this.channel.query({ outTradeNo: row.order_no });
      if (!res.ok) {
        await this.setLastError(row.order_no, res.lastError);
        continue;
      }
      if (res.data.found && res.data.tradeStatus === 'TRADE_SUCCESS') {
        if ((await this.transitionToPaid(row.order_no, res.data.tradeNo)) === 'paid') transitioned += 1;
      }
    }
    await this.refreshOrderPendingGauges();
    return transitioned;
  }

  /* -------------------------------- 内部 -------------------------------- */

  private queryRows<T>(sql: string, params: unknown[] = []): Promise<T> {
    return this.dataSource.query(sql, params) as Promise<T>;
  }

  private async loadOrderRow(userId: string, orderNo: string): Promise<OrderRow | null> {
    const rows = await this.queryRows<OrderRow[]>(SELECT_BY_ORDER_NO_SQL, [orderNo, userId]);
    return rows[0] ?? null;
  }

  private async insertOrder(args: {
    userId: string;
    packageYuan: number;
    amountFen: number;
    coins: number;
    coinPerYuan: number;
    expireMinutes: number;
  }): Promise<string> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const orderNo = generatePayOrderNo();
      try {
        await this.queryRows(INSERT_ORDER_SQL, [
          orderNo,
          args.userId,
          args.packageYuan,
          args.amountFen,
          args.coins,
          args.coinPerYuan,
          args.expireMinutes,
        ]);
        return orderNo;
      } catch (err) {
        if (!isDuplicateEntryError(err)) throw err;
        lastErr = err; // 撞 uk_order_no ⇒ 换号重试（唯一性由 UK 兜底）
      }
    }
    throw lastErr ?? new Error('订单号生成冲突');
  }

  /**
   * 下单链渠道步（复用/新建两支共用）：`channel.createPayUrl` 当场兑现
   * 配置/密钥/网关可达性探针（失败 ⇒ 15001；行保留的语义由调用方承担）；
   * wap 表单产物不落库、不下发——返回本站**桥接 URL**（表单在桥接页访问时现场重签）。
   */
  private async establishCashierPayment(
    orderNo: string,
    packageYuan: number,
    amountFen: number,
    expireMinutes: number,
    base: string,
  ): Promise<string> {
    const res = await this.channel.createPayUrl({
      outTradeNo: orderNo,
      subject: `金币充值 ${packageYuan} 元`,
      totalAmount: fen2yuan(amountFen),
      timeoutExpress: `${expireMinutes}m`,
      notifyUrl: `${base}/pay/notify/alipay`,
      returnUrl: `${base}/?pay=${orderNo}`,
    });
    if (!res.ok) throw new DomainError(res.code, '支付渠道暂时不可用，请稍后重试');
    return this.buildCashierPayUrl(base, orderNo, expireMinutes);
  }

  /** 桥接 URL = `<基址>/pay/cashier/<单号>?t=<HMAC token>`；token secret 缺失 ⇒ 15001（生产不可达）。 */
  private buildCashierPayUrl(base: string, orderNo: string, expireMinutes: number): string {
    const secret = cashierTokenSecret();
    if (secret.length === 0) {
      this.logger.warn('桥接 token 密钥缺失（INTERNAL_SERVICE_TOKEN 未设）⇒ 15001');
      throw new DomainError(ErrCode.PAY_CHANNEL_ERROR, '支付渠道暂时不可用，请稍后重试');
    }
    const token = signCashierToken(
      { orderNo, expMs: Date.now() + expireMinutes * 60_000, ttlMin: expireMinutes },
      secret,
    );
    return `${base}/pay/cashier/${orderNo}?t=${token}`;
  }

  /**
   * 桥接页上下文（CashierController 已验过 token 后调用）：
   * 无单 ⇒ `missing`（404）；非 created/已过期 ⇒ `gone`（410）；
   * 可支付 ⇒ 现拉基址 + **现场重签** wap 表单（每次新鲜 timestamp；ttlMin 取自 token 载荷，
   * 与下单意图逐字一致）；渠道侧失败 ⇒ 抛 15001 DomainError（控制器回 502）。
   */
  async cashierContext(
    orderNo: string,
    ttlMin: number,
  ): Promise<
    | { kind: 'missing' }
    | { kind: 'gone' }
    | { kind: 'form'; gatewayUrl: string; fields: Record<string, string> }
  > {
    const rows = await this.queryRows<Array<{ status: string; package_yuan: number | string; amount_fen: number | string }>>(
      SELECT_CASHIER_ORDER_SQL,
      [orderNo],
    );
    if (rows.length === 0) return { kind: 'missing' };

    const payable = await this.queryRows<Array<{ ok: number | string }>>(SELECT_CASHIER_PAYABLE_SQL, [orderNo]);
    if (payable.length === 0) return { kind: 'gone' };

    const row = rows[0]!;
    const packageYuan = toSafeInt(row.package_yuan, 'payment_orders.package_yuan');
    const amountFen = toSafeInt(row.amount_fen, 'payment_orders.amount_fen');
    const base = await this.publicBaseUrl();
    const res = await this.channel.createPayUrl({
      outTradeNo: orderNo,
      subject: `金币充值 ${packageYuan} 元`,
      totalAmount: fen2yuan(amountFen),
      timeoutExpress: `${ttlMin}m`,
      notifyUrl: `${base}/pay/notify/alipay`,
      returnUrl: `${base}/?pay=${orderNo}`,
    });
    if (!res.ok) throw new DomainError(res.code, '支付渠道暂时不可用，请稍后重试');
    return { kind: 'form', gatewayUrl: res.data.gatewayUrl, fields: res.data.fields };
  }

  /**
   * 手机端桥接代发（控制器在**手机 UA** 下、拿到 `cashierContext` 的现场重签表单后调用）：
   * 交渠道层以手机 UA 代 POST 回收手机收银台签发地址。本服务只透传——代发的重试/白名单/
   * 失败收口都在渠道层；失败面由控制器回退「自动提交表单页」（链路不死）。
   */
  async resolveMobileCashier(form: WapPayFormData): Promise<ChannelResult<MobileCashierData>> {
    return this.channel.resolveMobileCashier(form);
  }

  /**
   * 站点基址（渠道图 `pay.channel.publicBaseUrl`，经 `PayChannelConfigService` **每次调用现拉**）：
   * 缺图/缺键 = 空串 = 未设（`||` 不用 `??`）⇒ 15001；尾斜杠剥掉（T9/§3.3，语义逐字保持）。
   */
  private async publicBaseUrl(): Promise<string> {
    const creds = await this.payChannel.get();
    const base = (creds?.['pay.channel.publicBaseUrl'] || '').replace(/\/+$/, '');
    if (base.length === 0) {
      this.logger.warn('站点基址未配置（管理页 → 支付渠道）（notify_url/return_url 无法生成）⇒ 15001');
      throw new DomainError(ErrCode.PAY_CHANNEL_ERROR, '支付渠道暂时不可用，请稍后重试');
    }
    return base;
  }

  /** `last_error` 写点（§2.3：过期关闭/补单查询失败摘要；T6 材质已 ≤255）。 */
  private async setLastError(orderNo: string, message: string): Promise<void> {
    await this.queryRows(UPDATE_LAST_ERROR_SQL, [message, orderNo]);
  }

  /** 分页查询（keyset；`(created_at, id) < (cursor)` 严格降序——idx_orders_user_created）。 */
  private async queryPage(
    userId: string,
    cursor: { createdAtMs: number; rowId: number } | null,
    limit: number,
  ): Promise<OrderRow[]> {
    const sql =
      SELECT_MINE_BASE_SQL + (cursor ? MINE_CURSOR_COND_SQL : '') + MINE_ORDER_LIMIT_SQL;
    const params: unknown[] = [userId];
    if (cursor) params.push(new Date(cursor.createdAtMs), new Date(cursor.createdAtMs), cursor.rowId);
    params.push(limit + 1); // 多取一行：判 hasMore，不入响应
    return this.queryRows<OrderRow[]>(sql, params);
  }

  /** `payment_order_pending{state}` 刷新（§2.6·2；两扫描轮末 + sync 迁移后）。 */
  private async refreshOrderPendingGauges(): Promise<void> {
    const [created] = await this.queryRows<Array<{ count: number | string }>>(COUNT_BY_STATUS_SQL, ['created']);
    const [paid] = await this.queryRows<Array<{ count: number | string }>>(COUNT_BY_STATUS_SQL, ['paid']);
    paymentOrderPending.labels('pending_pay').set(Number(created?.count ?? 0));
    paymentOrderPending.labels('paid_uncredited').set(Number(paid?.count ?? 0));
  }
}

/** 行 ⇒ REST 投影（protocol `PayOrderInfo` 九键逐字；`amountYuan` 为字符串——⚙️5 禁浮点）。 */
function toPayOrderInfo(row: OrderRow): PayOrderInfo {
  return {
    orderNo: String(row.order_no),
    status: asOrderStatus(row.status),
    coins: toSafeInt(row.coins, 'orders.coins'),
    amountYuan: fen2yuan(toSafeInt(row.amount_fen, 'orders.amount_fen')),
    packageYuan: toSafeInt(row.package_yuan, 'orders.package_yuan'),
    createdAt: toEpochMs(row.created_at, 'orders.created_at'),
    paidAt: toEpochMsOrNull(row.paid_at, 'orders.paid_at'),
    creditedAt: toEpochMsOrNull(row.credited_at, 'orders.credited_at'),
    closedAt: toEpochMsOrNull(row.closed_at, 'orders.closed_at'),
  };
}
