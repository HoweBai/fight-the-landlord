/**
 * 支付片 T1：**REST 契约面**（玩家 9 端点 + 管理 8 端点）+ 单号前缀常量。
 *
 * 形状真源 = 规格 v1.1.1 §2.4 两表（§2.4.1 玩家面 / §2.4.2 管理面）+ §5 管理 CSV 列 + ⚙️4。
 * 冻结口径（改任一键 = 改契约，同提交改本文件与消费侧测试）：
 *  - 本文件的**一切响应类型描述的是平台信封 `{code,message,data}` 里的 `data` 载荷**
 *    （§11.1 信封；规格表里的「`200 {…}`」即 `data` 本体；错误体 `{code,message}` 照既有）。
 *  - 时间戳一律 **epoch 毫秒整数**（照记录片 REST 先例 `MyRecord.endedAt`；存储 UTC、
 *    按日与显示 +08:00 是**服务端**的换算责任，见 §3.2 时区口径）。
 *  - `amountYuan` = **字符串**（`fen2yuan(amount_fen)`，⚙️5——金科玉律：金额禁浮点）；
 *    内部记账/渠道参数用整数分（`amountFen`，管理面 CSV 列的原生形态）。
 *  - `nextCursor` = **不透明串**（终页 `null`；客户端原样回传、不解析——记录片同款）。
 *  - 状态联合类型 = 各状态机（§3.1 订单 / §3.2 提现 / §3.3 退款）的**全值集**，
 *    不在状态机里的值不是合法状态。
 *
 * 规格**未**逐键枚举的形状（`mine` 列表行 / 管理行 / notifyLog 条目）按对应 DDL 列（§2.3）
 * 与 CSV 列（§5）投影；实现任务（T7–T13）若增删字段，同提交改本文件（防「第二真源」）。
 *
 * ⚠️ 本文件经 `src/index.ts` 的 `export *` 进入客户端依赖面（`apps/client` 依赖本包）
 * ⇒ **不得静态引入 `node:` 内建**（理由见 `currency.ts` 头注）；目前只有三个字符串常量
 * 是运行期键，其余全是类型。
 */

/* ------------------------------------------------------------------ *
 * 单号前缀（⚙️4：`pay_`/`rf_`/`wd_` + base36(毫秒) + 6 位 base36 随机；
 * 字符集 `[0-9a-z_]`、长 ≤ 32——满足支付宝 out_trade_no 约束；生成器在 T7/T10/T11）
 * ------------------------------------------------------------------ */

/** 支付订单单号前缀（锚形 `pay:<orderNo>`，§2.1）。 */
export const PAY_ORDER_PREFIX = 'pay_';
/** 退款单单号前缀（锚形 `refund:<refundNo>` / 回滚 `refund_rb:<refundNo>`，§2.1）。 */
export const REFUND_PREFIX = 'rf_';
/** 提现单单号前缀（锚形 `withdraw:<withdrawNo>` / 回滚 `withdraw_rb:<withdrawNo>`，§2.1）。 */
export const WITHDRAW_PREFIX = 'wd_';

/* ------------------------------------------------------------------ *
 * 状态联合（状态机全值集，逐字 §3.1/§3.2/§3.3——含中间态）
 * ------------------------------------------------------------------ */

/** 订单状态（§3.1：`closed` 单可被迟到回调重开为 `paid`）。 */
export type PayOrderStatus = 'created' | 'paid' | 'credited' | 'closed';

/** 退款状态（§3.3：`rejecting` 为驳回回滚在途中间态；`refunded` 保留幂等槽）。 */
export type PayRefundStatus =
  | 'holding'
  | 'pending'
  | 'approved'
  | 'rejecting'
  | 'rejected'
  | 'refunded'
  | 'failed';

/** 提现状态（§3.2：`rolling_back` 为回滚在途中间态；终态集合见 ⚙️15 槽语义）。 */
export type PayWithdrawStatus =
  | 'holding'
  | 'pending'
  | 'approved'
  | 'paid'
  | 'rolling_back'
  | 'rejected'
  | 'timeout_rolled_back'
  | 'failed';

/* ------------------------------------------------------------------ *
 * 玩家面（`/api/pay/*`，用户 JWT；§2.4.1 表 1–9）
 * ------------------------------------------------------------------ */

/** ① `POST /api/pay/orders` 请求（档位为元、整数；合法性 = 档位配置 `pay.rechargePackages`，服务端权威）。 */
export interface PayCreateOrderRequest {
  packageYuan: number;
}

/** ① 响应（`payUrl` 为渠道收银台跳转地址，客户端仅跳转不加工）。 */
export interface PayCreateOrderResponse {
  orderNo: string;
  payUrl: string;
  /** 过期时刻（epoch ms；`pay.orderExpireMinutes` 快照）。 */
  expiresAt: number;
}

/**
 * ② `GET /api/pay/orders/:orderNo` 与 ③ `POST …/:orderNo/sync` 的响应（**同形**，规格写死 9 键）；
 * ④ `GET /api/pay/orders/mine` 的列表行同用本类型（规格未另列行形状）。
 */
export interface PayOrderInfo {
  orderNo: string;
  status: PayOrderStatus;
  /** 入账金币数（下单时刻 `packageYuan × coinPerYuan` 快照）。 */
  coins: number;
  /** 字符串金额（`fen2yuan`；⚙️5）。 */
  amountYuan: string;
  packageYuan: number;
  createdAt: number;
  paidAt: number | null;
  creditedAt: number | null;
  closedAt: number | null;
}

/** ④ `GET /api/pay/orders/mine` 查询（keyset；`limit` 默认 20、上限 50——服务端 clamp）。 */
export interface PayOrdersMineQuery {
  cursor?: string;
  limit?: number;
}

/** ④ 响应（keyset 页；`nextCursor === null` ⇒ 终页）。 */
export interface PayOrdersPage {
  items: PayOrderInfo[];
  nextCursor: string | null;
}

/** ⑤ `GET /api/pay/wallet/summary` 响应（末项按 §3.2 日限口径实算——客户端「剩余可申额度」数据源）。 */
export interface PayWalletSummary {
  balance: number;
  /** 可离场额度（cap，§2.2.1；只读展示切片，非资金裁决点——裁决点恒在锁内实时重取）。 */
  withdrawable: number;
  dailyWithdrawRemainingCoins: number;
}

/** ⑥ `POST /api/pay/refunds` 请求（`reason` ≤255 列宽；申请即冻结，§3.3）。 */
export interface PayRefundApplyRequest {
  orderNo: string;
  reason: string;
}

/** ⑥ 响应（`status` 起步恒为 `holding`——冻结落账后转 `pending`）。 */
export interface PayRefundApplyResponse {
  refundNo: string;
  status: PayRefundStatus;
}

/**
 * ⑦ `GET /api/pay/refunds/mine` 的列表行（规格未逐键枚举；投影 = §2.3 `payment_refunds` 列
 * 中本人可见面）。金额双形态：`coins`（金币）+ `amountYuan`（字符串，`fen2yuan(amount_fen)`）。
 */
export interface PayRefundInfo {
  refundNo: string;
  orderNo: string;
  coins: number;
  amountYuan: string;
  status: PayRefundStatus;
  reason: string;
  /** 审核附言（驳回时可给本人看；未审 `null`）。 */
  reviewNote: string | null;
  reviewedAt: number | null;
  refundedAt: number | null;
  createdAt: number;
}

/** ⑦ 查询（keyset；同 `PayOrdersMineQuery` 口径）。 */
export interface PayRefundsMineQuery {
  cursor?: string;
  limit?: number;
}

/** ⑦ 响应。 */
export interface PayRefundsPage {
  items: PayRefundInfo[];
  nextCursor: string | null;
}

/** ⑧ `POST /api/pay/withdrawals` 请求（`coins` 整数；门槛/限额/日限/cap 校验在服务端锁内，§3.2）。 */
export interface PayWithdrawApplyRequest {
  coins: number;
}

/** ⑧ 响应（`status` 起步恒为 `holding`——冻结落账后转 `pending`）。 */
export interface PayWithdrawApplyResponse {
  withdrawNo: string;
  status: PayWithdrawStatus;
}

/**
 * ⑨ `GET /api/pay/withdrawals/mine` 的列表行（规格未逐键枚举；投影 = §2.3 `payment_withdrawals`
 * 列中本人可见面）。`rollback_reason` 不入行——超时/驳回由 `status` 区分（14006/14007 行内提示，§2.8）。
 */
export interface PayWithdrawInfo {
  withdrawNo: string;
  coins: number;
  amountYuan: string;
  status: PayWithdrawStatus;
  /** 超时回滚截止（`created_at + pay.withdrawTimeoutMinutes` 快照）。 */
  timeoutAt: number;
  reviewNote: string | null;
  reviewedAt: number | null;
  confirmedAt: number | null;
  rolledBackAt: number | null;
  createdAt: number;
}

/** ⑨ 查询（keyset；同 `PayOrdersMineQuery` 口径）。 */
export interface PayWithdrawalsMineQuery {
  cursor?: string;
  limit?: number;
}

/** ⑨ 响应。 */
export interface PayWithdrawalsPage {
  items: PayWithdrawInfo[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ *
 * 管理面（`/api/admin/pay/*`，admin JWT + policy ⚙️10；§2.4.2 表 1–8）
 *
 * 行形状 = §5 CSV 列（同一份数据的 JSON/CSV 双出口；CSV = BOM + 公式注入消毒，字符串形态）。
 * 写面非法源态 ⇒ HTTP 409 + `ErrCode.PAY_STATE_CONFLICT`（message 含当前态与合法动作）。
 * `.csv` 出口为 text/csv 字节流，无 JSON DTO。
 * ------------------------------------------------------------------ */

/** ① `GET /api/admin/pay/orders[.csv]` 查询（`from`/`to` 为 +08:00 日界，照 ③ CONVERT_TZ 先例）。 */
export interface AdminPayOrdersQuery {
  status?: PayOrderStatus;
  userId?: string;
  from?: string;
  to?: string;
  cursor?: string;
}

/** ① 行 = §5 CSV 列 orders 逐字（camelCase 投影；`amountFen` 为整数分）。 */
export interface AdminPayOrderRow {
  orderNo: string;
  userId: string;
  packageYuan: number;
  amountFen: number;
  coins: number;
  status: PayOrderStatus;
  channel: string;
  tradeNo: string | null;
  paidAt: number | null;
  creditedAt: number | null;
  closedAt: number | null;
  createdAt: number;
}

/** ① 响应（orders 是管理面唯一带 `cursor` 的列表——§2.4.2 #1）。 */
export interface AdminPayOrdersPage {
  items: AdminPayOrderRow[];
  nextCursor: string | null;
}

/**
 * ② `GET /api/admin/pay/orders/:orderNo` 详情：行 + `payment_notify_log` 尾 20 条
 * （§2.3：该表**仅记验签通过件**；`raw_payload` 不入 DTO）。
 */
export interface AdminPayNotifyEntry {
  result: string;
  tradeStatus: string | null;
  amountFen: number | null;
  clientIp: string | null;
  receivedAt: number;
}

/** ② 响应。 */
export interface AdminPayOrderDetail extends AdminPayOrderRow {
  /** `payment_notify_log` 尾 20 条（新→旧；§2.4.2 #2）。 */
  notifyLog: AdminPayNotifyEntry[];
}

/** ③ `GET /api/admin/pay/refunds[.csv]` 查询（§2.4.2 #3：无 cursor——管理页不做分页，§7）。 */
export interface AdminPayRefundsQuery {
  status?: PayRefundStatus;
  userId?: string;
}

/** ③ 行 = §5 CSV 列 refunds 逐字（camelCase 投影）。 */
export interface AdminPayRefundRow {
  refundNo: string;
  orderNo: string;
  userId: string;
  coins: number;
  status: PayRefundStatus;
  reason: string;
  reviewedBy: string | null;
  reviewedAt: number | null;
  refundedAt: number | null;
  createdAt: number;
}

/** ③ 列表响应（无分页）。 */
export interface AdminPayRefundsList {
  items: AdminPayRefundRow[];
}

/** ③ `GET /api/admin/pay/refunds/:refundNo` 详情（规格未列附加字段——与行同形）。 */
export type AdminPayRefundDetail = AdminPayRefundRow;

/** ④/⑥ `POST …/review` 请求（退款与提现审共同形状；`approve`/`reject` 二值逐字 §2.4.2）。 */
export interface AdminPayReviewRequest {
  action: 'approve' | 'reject';
  /** 审核附言（≤255 列宽）。 */
  note?: string;
}

/** ④ `POST /api/admin/pay/refunds/:refundNo/review` 响应（「200 返回实际态」——渠道失败停留 `approved`）。 */
export interface AdminPayRefundReviewResponse {
  refundNo: string;
  status: PayRefundStatus;
}

/** ⑤ `GET /api/admin/pay/withdrawals[.csv]` 查询（无 cursor，同 §2.4.2 #5）。 */
export interface AdminPayWithdrawalsQuery {
  status?: PayWithdrawStatus;
  userId?: string;
}

/** ⑤ 行 = §5 CSV 列 withdrawals 逐字（camelCase 投影）。 */
export interface AdminPayWithdrawalRow {
  withdrawNo: string;
  userId: string;
  coins: number;
  status: PayWithdrawStatus;
  timeoutAt: number;
  reviewedBy: string | null;
  confirmedBy: string | null;
  voucher: string | null;
  rolledBackAt: number | null;
  createdAt: number;
}

/** ⑤ 列表响应（无分页）。 */
export interface AdminPayWithdrawalsList {
  items: AdminPayWithdrawalRow[];
}

/**
 * ⑤ `GET /api/admin/pay/withdrawals/:withdrawNo` 详情：行 + **余额/cap 快照读**（§2.4.2 #5）。
 * ⚠️ 该读是规格点名的**管理诊断读**（详情展示专用），**不是**资金裁决点——
 * 资金动作时刻的 cap 取数纪律（§2.2.1：锁内实时、禁缓存）不因此放宽。
 */
export interface AdminPayWithdrawalDetail extends AdminPayWithdrawalRow {
  balance: number;
  withdrawable: number;
}

/** ⑥ `POST /api/admin/pay/withdrawals/:withdrawNo/review` 响应（reject 后回滚落账 ⇒ `rejected`）。 */
export interface AdminPayWithdrawReviewResponse {
  withdrawNo: string;
  status: PayWithdrawStatus;
}

/** ⑦ `POST /api/admin/pay/withdrawals/:withdrawNo/confirm` 请求（打款台账登记；`voucher` ≤64 列宽）。 */
export interface AdminPayConfirmRequest {
  voucher: string;
  note?: string;
}

/** ⑦ 响应（成功 ⇒ `paid`）。 */
export interface AdminPayWithdrawConfirmResponse {
  withdrawNo: string;
  status: PayWithdrawStatus;
}

/** ⑧ `GET /api/admin/pay/actions[.csv]` 查询（审计第六源；日界 +08:00，`actor` = admin 用户名）。 */
export interface AdminPayActionsQuery {
  from?: string;
  to?: string;
  actor?: string;
}

/**
 * ⑧ 行 = §5 CSV 列 actions 逐字：`at,actor,kind,refNo,detail`。
 * `kind`/`detail` 的**运行时值域未由规格钉死**（中文映射见设计 §7：申请/审/驳回/确认/回滚）——
 * 类型上保持 `string`，由 T12 实现 + slice-21 断言实际值（不在此发明枚举）。
 */
export interface AdminPayActionRow {
  at: number;
  actor: string;
  kind: string;
  refNo: string;
  detail: string;
}

/** ⑧ 列表响应（无分页）。 */
export interface AdminPayActionsList {
  items: AdminPayActionRow[];
}
