/**
 * 支付片 T6：**渠道抽象层**（设计 §2.3 的 `channel/` 组件分解）。
 *
 * `PaymentChannel` = 四方法契约（`createPayUrl / query / refund / close`），本期唯一实现 =
 * 支付宝（`alipay/client.ts`，P1 裁决）；微信等渠道**接口预埋、不实现**。
 *
 * ## 结果语义（成功/失败判别）
 *
 *  - **成功** `{ ok: true, data }` —— 渠道给出**可信的明确结果**（响应过验签。店里的
 *    "业务答否"也走这里：`query` 的 `found:false`（`ACQ.TRADE_NOT_EXIST`）是渠道的
 *    **明确回答**，不是失败）；
 *  - **失败** `{ ok: false, code, lastError, channelCode, channelSubCode }` ——
 *    一切"没拿到可信成功结果"（配置缺失/坏 · 传输/超时/非 200 · 验签失败 · 业务拒绝）。
 *    `code` 恒为 `ErrCode.PAY_CHANNEL_ERROR`（15001；⚙️8→502）；`lastError` 是**摘要素材**，
 *    已截断 ≤255 —— 可直接写 `payment_orders/refunds/withdrawals.last_error` 列；
 *    业务拒绝的**判别材料**在 `channelCode/channelSubCode`（如 close 的"已支付"类 sub_code
 *    ⇒ T7 转 paid 路径；退款窗口类 ⇒ T11 停留 approved + 退避重试）。
 *
 * ## 金额口径（本层不做换算）
 *
 * 请求里的金额一律是**字符串元**（调用方用 `params.ts` 的 `fen2yuan` 由整数分生成——
 * ⚙️5 禁浮点）；响应里的金额由实现解析回**整数分**（解析失败 ⇒ `null`，调用方按
 * `amount_mismatch` 语义处理，⚙️5/设计 §4.3）。
 */
import type { ErrCode } from '@fight-the-landlord/protocol';

/** 渠道 API 标识（同时是 `payment_outbound_fail_total{api}` 的标签值域——§2.6·10 逐字）。 */
export type ChannelApi = 'wap_pay' | 'query' | 'refund' | 'close';

export interface ChannelSuccess<T> {
  ok: true;
  data: T;
}

export interface ChannelFailure {
  ok: false;
  /** 恒 `PAY_CHANNEL_ERROR`（15001；⚙️8 表 502）。 */
  code: ErrCode;
  /** 失败摘要素材（≤255 截断；可直写 `last_error` 列）。 */
  lastError: string;
  /** 支付宝 `code`（如 `'40004'`）；配置/传输/验签类失败 ⇒ `null`。 */
  channelCode: string | null;
  /** 支付宝 `sub_code`（如 `'ACQ.TRADE_NOT_EXIST'`）；同上。 */
  channelSubCode: string | null;
}

export type ChannelResult<T> = ChannelSuccess<T> | ChannelFailure;

/* ------------------------------- 请求/数据面 ------------------------------- */

/** `createPayUrl` 的入参（`notify_url`/`return_url` 等"URL 拼接素材"由调用方传入——设计 §4.1）。 */
export interface CreatePayUrlRequest {
  /** 商户单号（⚙️4 形状；= `payment_orders.order_no`）。 */
  outTradeNo: string;
  subject: string;
  /** **元字符串**（调用方 `fen2yuan(amount_fen)`；⚙️5 禁浮点）。 */
  totalAmount: string;
  /** 支付宝 `timeout_express` 形态（如 `'15m'`）；调用方按 `orderExpireMinutes` 生成。 */
  timeoutExpress: string;
  notifyUrl: string;
  returnUrl: string;
}

/**
 * `createPayUrl` 的成功数据（桥接页形态）：
 * wap.pay 是**页面执行型**接口——服务端不出站执行它，而是产出「网关地址 + 已签名表单字段」，
 * 由本站桥接页（`/pay/cashier/:orderNo`）渲染成隐藏表单，玩家浏览器自动 POST 到 `gatewayUrl`。
 * 凭证/链路的当场校验由实现内部的 query 探针承担（失败仍走失败面 15001）。
 */
export interface WapPayFormData {
  /** 表单提交目标（支付宝网关；来自渠道图 `pay.channel.gatewayUrl`）。 */
  gatewayUrl: string;
  /** 已签名的全部表单字段（含 `sign`；浏览器侧逐字段 hidden input 原样重放）。 */
  fields: Record<string, string>;
}

/**
 * `resolveMobileCashier` 的成功数据：手机网页收银台的**一次性签发地址**。
 *
 * 形态：以手机 UA 把 `createPayUrl` 的已签名表单 POST 到网关且**不跟随 302**，
 * 回收响应 `Location`（沙箱 = `mobileclientgw-sandbox.dl.alipaydev.com/cashier/mobilepay.htm?…`，
 * 生产 = 支付宝手机网页收银台）。该地址是已授权的跳转签发：**不绑买家端 IP**，
 * 交玩家手机浏览器直达即可在收银台域内登录付款。实现侧已做支付宝域白名单校验，
 * 控制器直接作为 302 Location 下发（防开放重定向）。
 */
export interface MobileCashierData {
  cashierUrl: string;
}

export interface QueryRequest {
  outTradeNo: string;
}

export interface QueryData {
  /** 渠道**明确回答**"该单在渠道不存在"（`ACQ.TRADE_NOT_EXIST`）⇒ `false`；其余成功 ⇒ `true`。 */
  found: boolean;
  /** `TRADE_SUCCESS` / `TRADE_FINISHED` / `TRADE_CLOSED` / `WAIT_BUYER_PAY` …；not found ⇒ `null`。 */
  tradeStatus: string | null;
  tradeNo: string | null;
  /** `total_amount` 解析回整数分（⚙️5 `yuan2fen`；解析失败/缺失 ⇒ `null`）。 */
  amountFen: number | null;
}

export interface RefundRequest {
  outTradeNo: string;
  /** **元字符串**（`fen2yuan(amount_fen)`）。 */
  refundAmount: string;
  /** 退款请求**幂等键（必填）**（= `payment_refunds.refund_no`；同值重发不重复退款）。 */
  outRequestNo: string;
  reason: string;
}

export interface RefundData {
  /**
   * 渠道引用。当前实现 = 支付宝 `trade.refund` 同步响应里的 `trade_no`
   * （v1 该 API **无独立退款单号**；T11 落 `channel_refund_no` 取此值——沙箱联调若发现
   * 更合适字段随 T16 订正，登记于 progress T6 行）。
   */
  tradeNo: string | null;
  /** `fund_change='Y'` = 本次真的动账；`N` = 同 `out_request_no` 幂等重放。解析失败 ⇒ `null`。 */
  fundChange: boolean | null;
}

export interface CloseRequest {
  outTradeNo: string;
}

export interface CloseData {
  /** 渠道已受理关闭（`code=10000`）。"已支付"类拒绝走失败面 + `channelSubCode` 判别。 */
  closed: boolean;
}

/* --------------------------------- 契约面 --------------------------------- */

/**
 * 渠道方法契约（本期唯一实现 = `alipay/client.ts` 的 `AlipayClient`）。
 * 五方法：四个业务 API + 手机端桥接代发（`resolveMobileCashier`）。
 */
export interface PaymentChannel {
  createPayUrl(req: CreatePayUrlRequest): Promise<ChannelResult<WapPayFormData>>;
  /**
   * 手机端桥接代发（仅手机 UA 调用；桌面端走浏览器自发表单）：
   * 以手机 UA 把 `createPayUrl` 产出的**同一组已签名表单** POST 到网关、不跟随 302，
   * 回收手机收银台签发地址。任何"没拿到可信签发地址"都走失败面（15001），
   * 控制器据此回退自动提交表单页（不死链）。
   */
  resolveMobileCashier(form: WapPayFormData): Promise<ChannelResult<MobileCashierData>>;
  query(req: QueryRequest): Promise<ChannelResult<QueryData>>;
  refund(req: RefundRequest): Promise<ChannelResult<RefundData>>;
  close(req: CloseRequest): Promise<ChannelResult<CloseData>>;
}
