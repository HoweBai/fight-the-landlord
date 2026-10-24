/**
 * 支付片 T8：**回调服务**（唯一信任入口的业务面；设计 §4.3 三块逐字 + 规格 §2.7.4/§3.1/§2.3/§2.6）。
 *
 * ─── 流程（控制器完成 405/415/413/429 防护闸后进入）───────────────────────
 *
 *  ① 参数面：form 解码后原文（`Record<string,string>`）；**含非字符串值（嵌套/数组形态）
 *     ⇒ 不可验签 = 不可信 ⇒ `bad_sign`**（fail-closed；不猜不回显）。
 *  ② **验签（唯一信任入口）**：`verifyNotify`（T6 复用；⚙️6① 通知走排序规范化）。
 *     公钥取自渠道图 `pay.channel.publicKey`（base64(PEM)、**每次调用现拉**——T9/§3.3 消费侧映射）；
 *     缺失/坏 ⇒ 不可验签 ⇒ `bad_sign`（不崩——暗上线期无密钥可起，见 §12 与 T8 任务卡）。
 *  ③ 四项业务校验（验签后逐条，顺序照设计 §4.3）：
 *       `app_id` == 本方（`pay.channel.appId`）· `seller_id` == 本方（`pay.channel.sellerId`）·
 *       `out_trade_no` 存在且 `total_amount` **解析整数分** == `order.amount_fen`
 *       （解析失败 ⇒ `amount_mismatch`；⚙️5 `yuan2fen` 整数比较消除格式歧义）·
 *       `trade_status ∈ {TRADE_SUCCESS, TRADE_FINISHED}`。
 *  ④ 推进：`OrdersService.transitionToPaid`（T7 复用；条件更新 ⇒ 并发安全）——
 *     `paid`（首达）/`already`（幂等）/`reopened`（closed 重开）三面都做一次
 *     **即时入账尝试**（T9：`ScanService.creditOrder`；失败静默留给扫描——success 语义
 *     不变：订单 ≥paid 即 success）；`none`（行消失/并发 churn —— 实践不可达的护栏）⇒ `unknown_order`。
 *  ⑤ `payment_notify_log` 写行（**仅验签通过件**——§2.3；`bad_sign` 只计数不落库）⇒
 *     应答两词（⚙️7）：订单 ≥paid ⇒ `success`；其余（含写库失败）⇒ `failure`
 *     （支付宝 24h 递进重试梯兜底）。
 *
 * ─── 指标映射（`payment_notify_total{result}` 五值域全收口在本文件）─────────
 *
 *  | 结果 | 触发（恰一条一路径） |
 *  |---|---|
 *  | `ok` | 验签+四校验过，且 transition ∈ {paid, already} |
 *  | `bad_sign` | 不可验签/验签失败 · app_id/seller_id ≠ 本方（含未配置）· trade_status 非成功集 · 参数非字符串 |
 *  | `amount_mismatch` | 金额解析失败或 ≠ order.amount_fen |
 *  | `unknown_order` | out_trade_no 无行 · transition='none'（护栏） |
 *  | `reopen` | closed→paid 重开（迟到回调；告警 `PaymentNotifyLateNotifyReopen`） |
 *
 * **notify_log 可落行四类 = {ok, amount_mismatch, unknown_order, reopen}**——与上表
 * 「验签通过后」的四个度点同构；其余一律只计数（§2.3：验签失败只计指标+日志，防垃圾增长）。
 *
 * `handleNotify` **不抛**：一切异常（含 DB 故障）收口为 `failure` + error 日志（应答语义
 * 由重试梯兜底——重发幂等，见 T7/§3.1 的条件更新）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { decodePem } from '../channel/alipay/client';
import { yuan2fen } from '../channel/alipay/params';
import { verifyNotify } from '../channel/alipay/sign';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析构造参时只见 undefined、启动即崩。
import { PayChannelConfigService } from '../config/pay-channel.config.service';
import { paymentNotifyTotal } from '../metrics/payment.metrics';
import { OrdersService } from '../orders/orders.service';
import { ScanService } from '../scan/scan.service';

/** 成功集（设计 §4.3 第四检逐字；两者都推进 paid 路径——退款窗口语义差异不改变入账判定）。 */
export const NOTIFY_SUCCESS_TRADE_STATUSES: readonly string[] = ['TRADE_SUCCESS', 'TRADE_FINISHED'];

/** 指标五值域（§2.6·1 逐字；单一收口）。 */
export type NotifyResult = 'ok' | 'bad_sign' | 'amount_mismatch' | 'unknown_order' | 'reopen';

/** ⚙️7 应答两词（纯文本 body；控制器原样发出）。 */
export type NotifyAnswer = 'success' | 'failure';

/** 订单读（**不带 user 条件**——回调只有渠道视角；列 = 校验/落行所需最小集）。 */
export const SELECT_NOTIFY_ORDER_SQL =
  'SELECT `order_no`, `status`, `amount_fen` FROM `payment_orders` WHERE `order_no` = ?';

/** notify_log 落行（§2.3 DDL 六列；`received_at` 走列默认 CURRENT_TIMESTAMP(3)）。 */
export const INSERT_NOTIFY_LOG_SQL =
  'INSERT INTO `payment_notify_log` (`order_no`, `result`, `trade_status`, `amount_fen`, `raw_payload`, `client_ip`) VALUES (?, ?, ?, ?, ?, ?)';

/** 读出的订单行（列名即 SQL 别名）。 */
interface NotifyOrderRow {
  order_no: string;
  status: string;
  amount_fen: number | string;
}

/** 通知参数的**原文形态**收窄：任何非字符串值 ⇒ 不可验签（null）。 */
function asStringParams(form: Readonly<Record<string, unknown>>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  /** ⚠️ **值导入**四个依赖（DI 陷阱纪律：类型导入会被擦除 ⇒ 容器解析崩）。 */
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(ScanService) private readonly scan: ScanService,
    @Inject(PayChannelConfigService) private readonly payChannel: PayChannelConfigService,
  ) {}

  /**
   * T9：**即时入账尝试**（见文件头 ④）。语义 = 「失败静默留给扫描」：业务面不抛
   * （`creditOrder` 以 `stalled` 返回），DB 级异常在这里接住 + warn，下一轮扫描兜底
   * ——`paid` 事实已落库（T7/T8 时序），钱不会丢；**应答语义不变：≥paid 即 success**。
   */
  private async tryCredit(orderNo: string): Promise<void> {
    try {
      await this.scan.creditOrder(orderNo);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`即时入账失败（静默留给扫描重试）order_no=${orderNo}: ${reason}`);
    }
  }

  /**
   * 单条回调的完整业务链（见文件头）。**不抛**：一切异常 ⇒ `failure`。
   *
   * @param form        控制器侧 form 解码后的参数对象（`express.urlencoded` 产物）
   * @param clientIp    socket peer（控制器如实取 `req.socket.remoteAddress`；不采信 XFF）
   * @param rawPayload  原始表单文本（≤16KB 已在控制器闸过；取证列 `raw_payload`）
   */
  async handleNotify(
    form: Readonly<Record<string, unknown>>,
    clientIp: string | null,
    rawPayload: string | null,
  ): Promise<NotifyAnswer> {
    try {
      return await this.dispatch(form, clientIp, rawPayload);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`回调处理异常 ⇒ 应答 failure 让重试梯兜底（重发幂等）：${reason}`);
      return 'failure';
    }
  }

  private async dispatch(
    form: Readonly<Record<string, unknown>>,
    clientIp: string | null,
    rawPayload: string | null,
  ): Promise<NotifyAnswer> {
    // ① 参数面（非字符串值不可验签 ⇒ bad_sign）
    const params = asStringParams(form);
    if (!params) {
      this.logger.warn('回调参数含非字符串值（嵌套/数组形态）—— 不可验签，按 bad_sign 拒');
      return this.reject('bad_sign');
    }

    // ② 验签（唯一信任入口；渠道图每次调用现拉——§3.3；②③ 三处读同一份图）
    const creds = await this.payChannel.get();
    const publicKeyPem = decodePem(creds?.['pay.channel.publicKey'], 'PUBLIC');
    if (!publicKeyPem) {
      this.logger.warn('渠道公钥（管理页 → 支付渠道）缺失/非法（形态 = base64(PEM)）—— 不可验签，按 bad_sign 拒（不崩）');
      return this.reject('bad_sign');
    }
    if (!verifyNotify(params, publicKeyPem)) {
      this.logger.warn(
        `回调验签失败（out_trade_no=${JSON.stringify(params['out_trade_no'] ?? null)}）—— 密钥错配或攻击的第一道铃`,
      );
      return this.reject('bad_sign');
    }

    // ③ 四项业务校验（逐条；顺序照设计 §4.3）
    const appId = creds?.['pay.channel.appId'] || '';
    if (appId.length === 0 || params['app_id'] !== appId) {
      this.logger.warn(
        appId.length === 0
          ? '渠道 APPID（管理页 → 支付渠道）未配置 —— app_id 校验不过（配置面）'
          : `回调 app_id 校验不过（收到 ${JSON.stringify(params['app_id'] ?? null)}）`,
      );
      return this.reject('bad_sign');
    }
    const sellerId = creds?.['pay.channel.sellerId'] || '';
    if (sellerId.length === 0 || params['seller_id'] !== sellerId) {
      this.logger.warn(
        sellerId.length === 0
          ? '商户 PID（管理页 → 支付渠道）未配置 —— seller_id 校验不过（本方 PID 缺失；应答 failure，不崩）'
          : `回调 seller_id 校验不过（收到 ${JSON.stringify(params['seller_id'] ?? null)}）`,
      );
      return this.reject('bad_sign');
    }

    const orderNo = params['out_trade_no'] ?? '';
    const amountFen = typeof params['total_amount'] === 'string' ? yuan2fen(params['total_amount']) : null;
    const tradeStatus = typeof params['trade_status'] === 'string' ? params['trade_status'] : null;

    const row = (await this.queryRows<NotifyOrderRow[]>(SELECT_NOTIFY_ORDER_SQL, [orderNo]))[0];
    if (!row) {
      this.count('unknown_order');
      await this.writeLog({ orderNo, result: 'unknown_order', tradeStatus, amountFen, rawPayload, clientIp });
      return 'failure';
    }
    if (amountFen === null || amountFen !== toSafeInt(row.amount_fen)) {
      // 解析失败或不等——整数比较（⚙️5）；解析失败不猜（落行 amount_fen=NULL）。
      this.count('amount_mismatch');
      await this.writeLog({ orderNo, result: 'amount_mismatch', tradeStatus, amountFen, rawPayload, clientIp });
      return 'failure';
    }
    if (tradeStatus === null || !NOTIFY_SUCCESS_TRADE_STATUSES.includes(tradeStatus)) {
      this.logger.warn(
        `回调 trade_status 非成功集（收到 ${JSON.stringify(params['trade_status'] ?? null)}；期望 TRADE_SUCCESS/TRADE_FINISHED）`,
      );
      return this.reject('bad_sign');
    }

    // ④ 状态推进（条件更新；并发安全——T7 复用）
    const tradeNo = typeof params['trade_no'] === 'string' && params['trade_no'].length > 0 ? params['trade_no'] : null;
    const transition = await this.orders.transitionToPaid(orderNo, tradeNo);

    // T9：订单已达/新达 paid ⇒ **立即尝试入账**（设计 §4.4 时序：先 paid 落库、后 apply
    // —— 此处 paid 已落库；失败静默留给扫描，应答语义不变）。'already' 面同样尝试
    // （幂等：已 credited ⇒ creditOrder 内 `skipped`，零 RPC——重试单更快收敛）。
    if (transition === 'paid' || transition === 'reopened' || transition === 'already') {
      await this.tryCredit(orderNo);
    }

    if (transition === 'paid' || transition === 'already') {
      // 首达与幂等（affected=0 且现状 ≥paid）同为 ok——重复回调直接 success（§4.3）。
      this.count('ok');
      await this.writeLog({ orderNo, result: 'ok', tradeStatus, amountFen, rawPayload, clientIp });
      return 'success';
    }
    if (transition === 'reopened') {
      // closed 重开（钱在手必入账；记 late_reopen_at 在 T7 SQL 内）。
      this.count('reopen');
      await this.writeLog({ orderNo, result: 'reopen', tradeStatus, amountFen, rawPayload, clientIp });
      return 'success';
    }
    // 'none'：行消失/并发 churn（实践不可达的护栏）——无从推进 ⇒ 计 unknown_order + failure。
    this.logger.warn(`回调无法推进订单 ${orderNo}（transition=none：行消失或并发迁移）—— 应答 failure 交重试梯`);
    this.count('unknown_order');
    await this.writeLog({ orderNo, result: 'unknown_order', tradeStatus, amountFen, rawPayload, clientIp });
    return 'failure';
  }

  /** 拒绝收口：`bad_sign` 计数（**不落 notify_log**——§2.3）+ 应答 failure。 */
  private reject(result: NotifyResult): NotifyAnswer {
    this.count(result);
    return 'failure';
  }

  /** 指标单一收口（`payment_notify_total{result}`）。 */
  private count(result: NotifyResult): void {
    paymentNotifyTotal.labels(result).inc();
  }

  /** notify_log 落行（仅验签通过件；写失败向上抛 ⇒ 顶层收成 failure——重发幂等收敛）。 */
  private async writeLog(row: {
    orderNo: string;
    result: NotifyResult;
    tradeStatus: string | null;
    amountFen: number | null;
    rawPayload: string | null;
    clientIp: string | null;
  }): Promise<void> {
    await this.queryRows(INSERT_NOTIFY_LOG_SQL, [
      row.orderNo,
      row.result,
      row.tradeStatus,
      row.amountFen,
      row.rawPayload,
      row.clientIp,
    ]);
  }

  private queryRows<T>(sql: string, params: unknown[] = []): Promise<T> {
    return this.dataSource.query(sql, params) as Promise<T>;
  }
}

/** 数值列（int 的驱动形态两种）⇒ 安全整数（读不出 ⇒ 抛——顶层收成 failure，不静默 NaN）。 */
function toSafeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`payment_orders.amount_fen 读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}
