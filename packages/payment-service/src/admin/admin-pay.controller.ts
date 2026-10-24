/**
 * 支付片 T12：**管理面控制器**（§2.4.2 八端点逐行 · ⚙️10 policy 另一侧 · §5 管理页 CSV 列逐字 ·
 * ⚙️9 非法源态 ⇒ 409+15009 · §2.4.2 末行〔actor 取网关注入 `x-admin-actor`；CSV = BOM + 公式
 * 注入消毒〕；设计 §7）。
 *
 * ─── 端点（八条 = 14 个路由句柄；全部挂在 `@Controller('admin/pay')`）────────────────────
 *  ① `GET  admin/pay/orders[.csv]`        列表（keyset：cursor 仅 JSON 版；CSV 无分页）
 *  ② `GET  admin/pay/orders/:orderNo`     详情（含 `payment_notify_log` 尾 20 条——§2.4.2 #2）
 *  ③ `GET  admin/pay/refunds[.csv]` + `/:refundNo`（无分页；同族）
 *  ④ `POST admin/pay/refunds/:refundNo/review`   {action:'approve'|'reject',note?}（T11 服务方法）
 *  ⑤ `GET  admin/pay/withdrawals[.csv]` + `/:withdrawNo`（详情 = 行 + 余额/cap 快照读）
 *  ⑥ `POST admin/pay/withdrawals/:withdrawNo/review`  {action,note?}（T10 服务方法）
 *  ⑦ `POST admin/pay/withdrawals/:withdrawNo/confirm` {voucher≤64,note?}（T10 服务方法）
 *  ⑧ `GET  admin/pay/actions[.csv]?from=&to=&actor=`   审计第六源（三表处置事件流）
 *
 * ─── 授权与身份 ──────────────────────────────────────────────────────────────
 *  授权在**网关 policy**（`api-gateway/src/auth/admin-policy.ts` P-p1..P-p7：读四面显式登记
 *  放行任意已认证角色；review/confirm 三条 `super_admin|finance`）；本服务侧 = `XAdminGuard`
 *  （`X-Admin:'1'` 必带；写面另强制合法 `x-admin-actor`，fail-closed）。**actor 绝无回退值**
 *  （reviewed_by/confirmed_by 的留痕必须指到一个真实管理身份——③ 设计 §4.2 纪律）。
 *
 * ─── 判读纪律（③ 先例逐条）───────────────────────────────────────────────────
 *  - **列表/过滤端点 = 严格白名单**（未知键 ⇒ 400 借 10001「未知查询参数：<key>」——与网关
 *    同句文案的双层校验；财务/审计面静默丢 `status` 会把「筛过的」与「全量」混同）；
 *    **详情端点 = 非列表**（未知键静默丢弃，照 ③ wallets ops/:opId 先例）。
 *  - **过滤值先于查库校验并 400**（列宽纪律 T3 教训）：status 走状态机值域数组 · userId
 *    长度 1..36 · actor 长度 1..64（管理员名 ≤32 / player userId 36 / `'system'` 同列）·
 *    from/to 十进制 epoch 毫秒（含 Date 域上界，照 ③ parseEpochMs）· cursor 复用 orders 的
 *    base64url 解码（非法 ⇒ 既有 10001 文案）。
 *  - **详情不存在 ⇒ 404 借 10001**（「订单/退款单/提现单不存在」；照 ③ `adminError(404,
 *    '操作不存在')` 先例。⚠️ 不用 15002——那是玩家面「不存在**或非本人**」的语义，admin 面
 *    无「本人」概念；登记见 progress.md）。
 *  - **提现详情余额/cap = 管理诊断读**（§2.4.2 #5；currency.withdrawable 一读）：**不是**资金
 *    裁决点——资金动作时刻的 cap 纪律（§2.2.1 锁内实时、禁缓存）不因此放宽；RPC 失败 ⇒
 *    **fail-closed**（15003「服务暂时不可用」变体 ⇒ 409），不伪造 0 读数。
 *
 * ─── CSV（§5 逐字 + §2.4.2 末行）────────────────────────────────────────────
 *  列**逐字** §5（orders 12 / refunds 10 / withdrawals 10 / actions 5——表头即蛇形列名，
 *  与 JSON 行同数据的双出口）；`CSV_BOM`/`csvCell` 消费自 protocol（**不得复制**；BOM +
 *  公式注入消毒 + RFC4180 都在那里）；行尾 `\r\n`；`Content-Type: text/csv; charset=utf-8` +
 *  `Content-Disposition: attachment; filename="pay-orders-<ts>.csv"`（<ts> = UTC
 *  `yyyyMMdd-HHmmss`，⚙️1；四文件名 pay-orders/pay-refunds/pay-withdrawals/pay-actions）。
 *  时间列值 = epoch ms 整数（JSON 同值；显示层换算北京时间）。
 *
 * ─── 通道长挂（T11 交接的运营事实，本卡登记）───────────────────────────────────
 *  退款 `POST …/review {action:'approve'}` 在服务端**就地**跑渠道退避表（1s→5s→30s→2m→10m，
 *  最长约 12.6 分钟）⇒ 网关 `GATEWAY_UPSTREAM_TIMEOUT_MS=5000` 会先掐断，管理页收到
 *  **503（10007）/ 传输失败，而服务端继续退避**；页面必须写明提示（照实际态刷新列表）。
 *  重复审批由行已离开 `pending` ⇒ **15009 兜底**（不会双退）。
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CSV_BOM, ErrCode, csvCell } from '@fight-the-landlord/protocol';
import type {
  AdminPayActionRow,
  AdminPayNotifyEntry,
  AdminPayOrderDetail,
  AdminPayOrderRow,
  AdminPayRefundRow,
  AdminPayWithdrawalRow,
  PayOrderStatus,
  PayRefundStatus,
  PayWithdrawStatus,
} from '@fight-the-landlord/protocol';
import { DataSource } from 'typeorm';
import { DomainError, httpException, toHttpException } from '../http/errors';
import { XAdminGuard, adminActorOf, type AdminRequest } from '../http/x-admin.guard';
import { decodePayOrdersCursor, encodePayOrdersCursor } from '../orders/orders.service';
import { RefundService } from '../refund/refund.service';
import { CurrencyRpcClient, TRANSPORT_FAILURE_MESSAGE } from '../rpc/currency.client';
import { WithdrawService } from '../withdraw/withdraw.service';

/* ------------------------------------------------------------------ *
 * 常量（SQL 全文钉 / 值域 / CSV 表头 / 分页）
 * ------------------------------------------------------------------ */

/**
 * orders 读列（**列序 = §5 CSV 列序逐字；`id` 前置**——keyset 分页内部列，不入 CSV/JSON 投影）。
 *
 * 🔴 **假库遮蔽族纪律（波 4 阻断-1，第 6 例）**：`id` 必须**真投影**出来——`nextCursor` 的
 * `rowId` 从这里取；缺列会让游标静默签出 `rowId=0`（自家解码器必拒 ⇒ 订单 >50 条后「加载
 * 更多」必 400）。读取侧一律**严格**（缺列/非 ≥1 整数 ⇒ 响亮抛 + 日志），禁 `?? 0` 兜底。
 */
export const ADMIN_ORDERS_SELECT_BASE =
  'SELECT `id`, `order_no`, `user_id`, `package_yuan`, `amount_fen`, `coins`, `status`, `channel`, `trade_no`, `paid_at`, `credited_at`, `closed_at`, `created_at` FROM `payment_orders`';

/** 列表排序（新→旧；`id` 取平——同 `mine` 先例）。 */
const ADMIN_ORDERS_ORDER_SUFFIX = ' ORDER BY `created_at` DESC, `id` DESC';
/** JSON 列表后缀（keyset 页大小 + 1 多取一行判 hasMore）。 */
export const ADMIN_ORDERS_LIST_SUFFIX = `${ADMIN_ORDERS_ORDER_SUFFIX} LIMIT ?`;
/**
 * keyset 游标条件（`(created_at, id)` 严格降序——同 `mine`）。
 * ⚠️ **无前导 `AND`**：与其余 cond 同列进 `WHERE` 拼装（真栈实证 2026-10-06：旧形态
 * `' AND (...)'` 在「**无过滤 + cursor**」（管理页未选筛选项点「加载更多」）时拼出
 * ``FROM `payment_orders` AND (...)`` = 语法错 500——旧实现被「rowId=0 ⇒ 解码先拒」遮蔽，
 * 是假库遮蔽族的第 7 例，见 progress.md 波 4 修复批）。
 */
export const ADMIN_ORDERS_LIST_CURSOR_COND = '(`created_at` < ? OR (`created_at` = ? AND `id` < ?))';
/** 详情（admin 面不按 user 收窄）。 */
export const ADMIN_ORDER_DETAIL_SQL = `${ADMIN_ORDERS_SELECT_BASE} WHERE \`order_no\` = ?`;

/** `payment_notify_log` 尾 20 条（新→旧；`raw_payload` 不入投影——§2.3 仅记验签通过件）。 */
export const ADMIN_NOTIFY_LOG_SQL =
  'SELECT `result`, `trade_status`, `amount_fen`, `client_ip`, `received_at` FROM `payment_notify_log` WHERE `order_no` = ? ORDER BY `id` DESC LIMIT 20';

/** refunds 读列（= §5 refunds 列序逐字）。 */
export const ADMIN_REFUNDS_SELECT_BASE =
  'SELECT `refund_no`, `order_no`, `user_id`, `coins`, `status`, `reason`, `reviewed_by`, `reviewed_at`, `refunded_at`, `created_at` FROM `payment_refunds`';
/** refunds 列表排序（无分页——§2.4.2 #3 无 cursor，§7「管理页不做分页」）。 */
export const ADMIN_REFUNDS_LIST_SUFFIX = ' ORDER BY `created_at` DESC, `id` DESC';
/** refunds 详情。 */
export const ADMIN_REFUND_DETAIL_SQL = `${ADMIN_REFUNDS_SELECT_BASE} WHERE \`refund_no\` = ?`;

/** withdrawals 读列（= §5 withdrawals 列序逐字）。 */
export const ADMIN_WITHDRAWALS_SELECT_BASE =
  'SELECT `withdraw_no`, `user_id`, `coins`, `status`, `timeout_at`, `reviewed_by`, `confirmed_by`, `voucher`, `rolled_back_at`, `created_at` FROM `payment_withdrawals`';
/** withdrawals 列表排序（无分页，同 refunds）。 */
export const ADMIN_WITHDRAWALS_LIST_SUFFIX = ' ORDER BY `created_at` DESC, `id` DESC';
/** withdrawals 详情。 */
export const ADMIN_WITHDRAW_DETAIL_SQL = `${ADMIN_WITHDRAWALS_SELECT_BASE} WHERE \`withdraw_no\` = ?`;

/**
 * **审计第六源**（§2.4.2 #8；设计 §7）：三表处置事件流 —— 五类语义（申请/审/驳回/确认/回滚）
 * 以 `kind` 出（`applied`/`approved`/`rejected`/`confirmed`/`rolled_back`；单号前缀 + detail
 * 区分实体）。逐条口径：
 *  - 申请：三表 `created_at`（actor = 玩家 user_id——申请动作的发生者）；
 *  - 审：`reviewed_at IS NOT NULL` 且（refund）`status ∈ approved|refunded` /
 *    （withdraw）`rollback_reason IS NULL OR = 'timeout'`（审通过行；超时回滚不抹审通过事实）；
 *  - 驳回：`reviewed_at IS NOT NULL` 且 refund `status ∈ rejecting|rejected` /
 *    withdraw `rollback_reason='rejected'`；
 *  - 确认：`confirmed_at IS NOT NULL`（actor = confirmed_by；voucher 入 detail）；
 *  - 回滚：`rolled_back_at IS NOT NULL AND rollback_reason='timeout'`（actor = `'system'`，
 *    照风控 auto 动作的 actor 先例——扫描自动动作没有管理身份）。
 *  所有 `at` 由谓词保证非 NULL；ORDER BY `at` DESC, `ref_no` ASC（确定性平手）。
 */
export const ADMIN_ACTIONS_SELECT_BASE =
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
  ') AS t';
/** actions 排序（新→旧；`ref_no` 平手定序）。 */
export const ADMIN_ACTIONS_SUFFIX = ' ORDER BY t.`at` DESC, t.`ref_no` ASC';

/** 状态机值域（protocol `payment.ts` 三联合类型逐字——本服务侧校验用的运行时数组，单测钉住）。 */
export const ADMIN_ORDER_STATUSES: readonly PayOrderStatus[] = ['created', 'paid', 'credited', 'closed'];
export const ADMIN_REFUND_STATUSES: readonly PayRefundStatus[] = [
  'holding',
  'pending',
  'approved',
  'rejecting',
  'rejected',
  'refunded',
  'failed',
];
export const ADMIN_WITHDRAW_STATUSES: readonly PayWithdrawStatus[] = [
  'holding',
  'pending',
  'approved',
  'paid',
  'rolling_back',
  'rejected',
  'timeout_rolled_back',
  'failed',
];

/** orders 列表页大小（§2.4.2 #1 未给 limit 键 ⇒ 服务端定值；管理页「加载更多」消费 nextCursor）。 */
export const ADMIN_PAY_ORDERS_PAGE_SIZE = 50;

/** CSV 表头**逐字** §5（四组；蛇形列名即 wire 契约）。 */
export const ADMIN_ORDERS_CSV_HEADER = [
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
] as const;
export const ADMIN_REFUNDS_CSV_HEADER = [
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
] as const;
export const ADMIN_WITHDRAWALS_CSV_HEADER = [
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
] as const;
export const ADMIN_ACTIONS_CSV_HEADER = ['at', 'actor', 'kind', 'ref_no', 'detail'] as const;

/** query **白名单**（§2.4.2 过滤键逐字；CSV 变体 = JSON 版去 `cursor`——带上即 400）。 */
export const ADMIN_PAY_ORDERS_QUERY_KEYS: readonly string[] = ['status', 'userId', 'from', 'to', 'cursor'];
export const ADMIN_PAY_REFUNDS_QUERY_KEYS: readonly string[] = ['status', 'userId'];
export const ADMIN_PAY_WITHDRAWALS_QUERY_KEYS: readonly string[] = ['status', 'userId'];
export const ADMIN_PAY_ACTIONS_QUERY_KEYS: readonly string[] = ['from', 'to', 'actor'];
const WITHOUT_CURSOR = (keys: readonly string[]): readonly string[] => keys.filter((k) => k !== 'cursor');
const ADMIN_PAY_ORDERS_CSV_QUERY_KEYS = WITHOUT_CURSOR(ADMIN_PAY_ORDERS_QUERY_KEYS);

/* ------------------------------------------------------------------ *
 * 校验（400 借 10001；文案就地定死、被单测钉）
 * ------------------------------------------------------------------ */

type QueryMap = Record<string, unknown>;

const unknownKeyMessage = (key: string) => `未知查询参数：${key}`;
const STATUS_MESSAGE = (entity: '订单' | '退款' | '提现') => `status 非法：须为${entity}状态机值之一`;
const USER_ID_MESSAGE = 'userId 非法：长度须为 1–36';
const ACTOR_MESSAGE = 'actor 非法：长度须为 1–64';
const EPOCH_MESSAGE = (name: 'from' | 'to') => `${name} 非法：须为非负整数（epoch 毫秒）`;

const badRequest = (message: string) => httpException(ErrCode.BAD_PARAM, message);

/** 404 借码信封（照 ③ `adminError(404, …)` 先例；`code` 缺省 10001）。 */
function notFound(message: string): HttpException {
  return new HttpException({ code: ErrCode.BAD_PARAM, message, data: null }, 404);
}

/** 未知 query 键 ⇒ 400（第一个未知键即拒；与网关白名单同句文案——双层校验）。 */
function assertKnownKeys(query: QueryMap, allowed: readonly string[]): void {
  for (const k of Object.keys(query)) {
    if (!allowed.includes(k)) throw badRequest(unknownKeyMessage(k));
  }
}

function parseStatus<T extends string>(
  query: QueryMap,
  allowed: readonly T[],
  entity: '订单' | '退款' | '提现',
): T | undefined {
  const raw = query['status'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw badRequest(STATUS_MESSAGE(entity));
  }
  return raw as T;
}

function parseUserId(query: QueryMap): string | undefined {
  const raw = query['userId'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 36) throw badRequest(USER_ID_MESSAGE);
  return raw;
}

function parseActor(query: QueryMap): string | undefined {
  const raw = query['actor'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 64) throw badRequest(ACTOR_MESSAGE);
  return raw;
}

/** 十进制 epoch 毫秒（'1.5'/'1e3'/'-1'/超安全整数/超 Date 域 一律拒）。 */
function parseEpochMs(query: QueryMap, name: 'from' | 'to'): number | undefined {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw badRequest(EPOCH_MESSAGE(name));
  }
  const n = Number(raw);
  if (Number.isNaN(new Date(n).getTime())) throw badRequest(EPOCH_MESSAGE(name)); // Date 域上界
  return n;
}

/* ------------------------------------------------------------------ *
 * 行映射（读不出 ⇒ 抛，不静默编造读数；同 orders/records 先例）
 * ------------------------------------------------------------------ */

function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

function toEpochMs(value: unknown, context: string): number {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(String(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`${context}：读出的时间不是有限毫秒（收到 ${JSON.stringify(value)}）`);
  }
  return ms;
}

/**
 * keyset 游标行的 `id` 严格读（波 4 阻断-1）：安全整数**且 ≥1**——游标解码器同款边界
 * （`rowId < 1 ⇒ invalidCursor`），此处先于编码把坏值**响亮拒**（缺列/0/负/非整数 ⇒ 抛，
 * 绝不 `?? 0` 静默兜底签出自家解码器必拒的游标）。同 `toActionRow` 的「读不出 ⇒ 抛」纪律。
 */
function toCursorRowId(value: unknown): number {
  const n = toSafeInt(value, 'payment_orders.id');
  if (n < 1) {
    throw new Error(`payment_orders.id：游标行 id 不是 ≥1 的安全整数（收到 ${JSON.stringify(value)}）—— 拒签 nextCursor`);
  }
  return n;
}

function toEpochMsOrNull(value: unknown, context: string): number | null {
  return value === null || value === undefined ? null : toEpochMs(value, context);
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toOrderRow(row: Record<string, unknown>): AdminPayOrderRow {
  return {
    orderNo: String(row['order_no']),
    userId: String(row['user_id']),
    packageYuan: toSafeInt(row['package_yuan'], 'payment_orders.package_yuan'),
    amountFen: toSafeInt(row['amount_fen'], 'payment_orders.amount_fen'),
    coins: toSafeInt(row['coins'], 'payment_orders.coins'),
    status: String(row['status']) as PayOrderStatus,
    channel: String(row['channel']),
    tradeNo: toNullableString(row['trade_no']),
    paidAt: toEpochMsOrNull(row['paid_at'], 'payment_orders.paid_at'),
    creditedAt: toEpochMsOrNull(row['credited_at'], 'payment_orders.credited_at'),
    closedAt: toEpochMsOrNull(row['closed_at'], 'payment_orders.closed_at'),
    createdAt: toEpochMs(row['created_at'], 'payment_orders.created_at'),
  };
}

function toNotifyEntry(row: Record<string, unknown>): AdminPayNotifyEntry {
  return {
    result: String(row['result']),
    tradeStatus: toNullableString(row['trade_status']),
    amountFen: row['amount_fen'] === null || row['amount_fen'] === undefined ? null : toSafeInt(row['amount_fen'], 'payment_notify_log.amount_fen'),
    clientIp: toNullableString(row['client_ip']),
    receivedAt: toEpochMs(row['received_at'], 'payment_notify_log.received_at'),
  };
}

function toRefundRow(row: Record<string, unknown>): AdminPayRefundRow {
  return {
    refundNo: String(row['refund_no']),
    orderNo: String(row['order_no']),
    userId: String(row['user_id']),
    coins: toSafeInt(row['coins'], 'payment_refunds.coins'),
    status: String(row['status']) as PayRefundStatus,
    reason: String(row['reason']),
    reviewedBy: toNullableString(row['reviewed_by']),
    reviewedAt: toEpochMsOrNull(row['reviewed_at'], 'payment_refunds.reviewed_at'),
    refundedAt: toEpochMsOrNull(row['refunded_at'], 'payment_refunds.refunded_at'),
    createdAt: toEpochMs(row['created_at'], 'payment_refunds.created_at'),
  };
}

function toWithdrawRow(row: Record<string, unknown>): AdminPayWithdrawalRow {
  return {
    withdrawNo: String(row['withdraw_no']),
    userId: String(row['user_id']),
    coins: toSafeInt(row['coins'], 'payment_withdrawals.coins'),
    status: String(row['status']) as PayWithdrawStatus,
    timeoutAt: toEpochMs(row['timeout_at'], 'payment_withdrawals.timeout_at'),
    reviewedBy: toNullableString(row['reviewed_by']),
    confirmedBy: toNullableString(row['confirmed_by']),
    voucher: toNullableString(row['voucher']),
    rolledBackAt: toEpochMsOrNull(row['rolled_back_at'], 'payment_withdrawals.rolled_back_at'),
    createdAt: toEpochMs(row['created_at'], 'payment_withdrawals.created_at'),
  };
}

function toActionRow(row: Record<string, unknown>): AdminPayActionRow {
  const actor = toNullableString(row['actor']);
  const kind = row['kind'];
  const refNo = row['refNo'];
  const detail = row['detail'];
  if (actor === null || typeof kind !== 'string' || typeof refNo !== 'string' || typeof detail !== 'string') {
    // 不变量：五个事件族的 actor/kind/refNo/detail 都由产生该事件的同一 SELECT 投影好
    //（refNo 是 SQL **别名**——⚠️ 真栈实证：按列底名 `ref_no` 取会得到 undefined 并被
    // String() 静默写成字面量 'undefined'；此处**严格拒**，读不出即响亮抛）。
    throw new Error(`payment_actions 行形状破损（actor/kind/refNo/detail 之一缺失或非字符串）：${JSON.stringify(row)}`);
  }
  return {
    at: toEpochMs(row['at'], 'payment_actions.at'),
    actor,
    kind,
    refNo,
    detail,
  };
}

/* ------------------------------------------------------------------ *
 * CSV 拼装（算法本体 = protocol `csvCell`/`CSV_BOM`，此处只拼行；§5 列逐字）
 * ------------------------------------------------------------------ */

interface CsvRes {
  setHeader: (name: string, value: string) => void;
}

function csvBody(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return CSV_BOM + lines.map((line) => `${line}\r\n`).join('');
}

/** 文件名时间戳 `yyyyMMdd-HHmmss`（UTC——容器 TZ=UTC，⚙️1；照 ③ 口径）。 */
function csvStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/** 落两枚响应头 + 拼全量 CSV 体（体由 Nest 原样出站；网关按字节透传——③ T6 联测先例）。 */
function sendCsv(
  res: CsvRes,
  name: string,
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${csvStamp(new Date())}.csv"`);
  return csvBody(header, rows);
}

/* ------------------------------------------------------------------ *
 * 控制器（授权在网关 policy；本层只做 query 校验 / 信封 / CSV / 递达服务）
 * ------------------------------------------------------------------ */

@Controller('admin/pay')
@UseGuards(XAdminGuard)
export class AdminPayController {
  private readonly logger = new Logger(AdminPayController.name);

  /** ⚠️ **值导入**四个依赖（DI 陷阱纪律：类型导入会被擦除 ⇒ 容器解析崩）。 */
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(CurrencyRpcClient) private readonly currency: CurrencyRpcClient,
    @Inject(RefundService) private readonly refunds: RefundService,
    @Inject(WithdrawService) private readonly withdrawals: WithdrawService,
  ) {}

  /* ────────────────────────────── ① orders ─────────────────────────────── */

  /** `GET /api/admin/pay/orders`：列表（keyset；§2.4.2 #1）。 */

  /**
   * 批量玩家充值汇总（玩家管理页 2026-10-22）：仅 `credited_at IS NOT NULL`；
   * 毛充值（未扣退款）；1–100 个 userId 去重；无记录 ⇒ 0/0/null。
   */
  @Post('players/summary')
  @HttpCode(200)
  async playersSummary(@Body() body: { userIds?: unknown }): Promise<{
    code: ErrCode;
    data: { players: Array<{ userId: string; rechargeCount: number; rechargeFen: number; lastRechargeAt: number | null }> };
  }> {
    const userIds = normalizePlayerIds(body?.userIds);
    const rows =
      userIds.length === 0
        ? []
        : ((await this.dataSource.query(
            `SELECT user_id, COUNT(*) AS cnt, SUM(amount_fen) AS fen, MAX(credited_at) AS last_at
             FROM payment_orders WHERE credited_at IS NOT NULL AND user_id IN (${userIds
               .map(() => '?')
               .join(',')}) GROUP BY user_id`,
            userIds,
          )) as Array<Record<string, unknown>>);
    const byId = new Map(rows.map((r) => [String(r.user_id), r]));
    return {
      code: ErrCode.OK,
      data: {
        players: userIds.map((userId) => {
          const r = byId.get(userId);
          return {
            userId,
            rechargeCount: r === undefined ? 0 : toSafeInt(r.cnt, 'payment_orders.count'),
            rechargeFen: r === undefined ? 0 : toSafeInt(r.fen, 'payment_orders.amount_fen_sum'),
            lastRechargeAt:
              r === undefined || r.last_at === null || r.last_at === undefined
                ? null
                : new Date(String(r.last_at)).getTime(),
          };
        }),
      },
    };
  }

  @Get('orders')
  @HttpCode(200)
  async ordersList(@Query() query: QueryMap) {
    assertKnownKeys(query, ADMIN_PAY_ORDERS_QUERY_KEYS);
    const status = parseStatus(query, ADMIN_ORDER_STATUSES, '订单');
    const userId = parseUserId(query);
    const from = parseEpochMs(query, 'from');
    const to = parseEpochMs(query, 'to');
    // 游标**先于任何查询**校验（非法 ⇒ 10001，不落一次库——orders.mine 同款；
    // 非字符串形态由 decodePayOrdersCursor 原样拒；DomainError 在此翻成 HTTP）。
    const rawCursor = query['cursor'];
    let cursor: { createdAtMs: number; rowId: number } | null = null;
    if (rawCursor !== undefined) {
      try {
        cursor = decodePayOrdersCursor(rawCursor);
      } catch (err) {
        throw toHttpException(err);
      }
    }

    const conds: string[] = [];
    const params: unknown[] = [];
    if (status !== undefined) (conds.push('`status` = ?'), params.push(status));
    if (userId !== undefined) (conds.push('`user_id` = ?'), params.push(userId));
    if (from !== undefined) (conds.push('`created_at` >= ?'), params.push(new Date(from)));
    if (to !== undefined) (conds.push('`created_at` < ?'), params.push(new Date(to)));
    // 游标条件与其余 cond 同列（**无前导 AND**）——「无过滤 + cursor」时 WHERE 仍成立
    //（真栈实证的语法错 500 由此关死；见 ADMIN_ORDERS_LIST_CURSOR_COND 注）。
    if (cursor !== null) {
      conds.push(ADMIN_ORDERS_LIST_CURSOR_COND);
      params.push(new Date(cursor.createdAtMs), new Date(cursor.createdAtMs), cursor.rowId);
    }
    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    params.push(ADMIN_PAY_ORDERS_PAGE_SIZE + 1); // 多取一行判 hasMore，不入响应

    const rows = (await this.dataSource.query(
      `${ADMIN_ORDERS_SELECT_BASE}${where}${ADMIN_ORDERS_LIST_SUFFIX}`,
      params,
    )) as Array<Record<string, unknown>>;
    const hasMore = rows.length > ADMIN_PAY_ORDERS_PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, ADMIN_PAY_ORDERS_PAGE_SIZE) : rows;
    const items = pageRows.map(toOrderRow);
    const last = pageRows[pageRows.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && last) {
      // 🔴 游标构造**严格读**（波 4 阻断-1）：`id` 缺列/非 ≥1 ⇒ 响亮抛 + error 日志——
      // 静默兜底（旧 `?? 0`）会签出自家解码器必拒的 `rowId=0`，订单 >50 条后翻页必 400。
      try {
        nextCursor = encodePayOrdersCursor(
          toEpochMs(last['created_at'], 'payment_orders.created_at'),
          toCursorRowId(last['id']),
        );
      } catch (err) {
        this.logger.error(
          `管理订单列表 nextCursor 构造失败（行形状破损，拒绝静默兜底）：${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }
    return { code: ErrCode.OK, data: { items, nextCursor } };
  }

  /** `GET /api/admin/pay/orders.csv`：导出（§5 列逐字；无分页/无 cursor）。 */
  @Get('orders.csv')
  @HttpCode(200)
  async ordersCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    assertKnownKeys(query, ADMIN_PAY_ORDERS_CSV_QUERY_KEYS);
    const status = parseStatus(query, ADMIN_ORDER_STATUSES, '订单');
    const userId = parseUserId(query);
    const from = parseEpochMs(query, 'from');
    const to = parseEpochMs(query, 'to');
    const conds: string[] = [];
    const params: unknown[] = [];
    if (status !== undefined) (conds.push('`status` = ?'), params.push(status));
    if (userId !== undefined) (conds.push('`user_id` = ?'), params.push(userId));
    if (from !== undefined) (conds.push('`created_at` >= ?'), params.push(new Date(from)));
    if (to !== undefined) (conds.push('`created_at` < ?'), params.push(new Date(to)));
    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    const rows = (await this.dataSource.query(
      `${ADMIN_ORDERS_SELECT_BASE}${where}${ADMIN_ORDERS_ORDER_SUFFIX}`,
      params,
    )) as Array<Record<string, unknown>>;
    return sendCsv(
      res,
      'pay-orders',
      ADMIN_ORDERS_CSV_HEADER,
      rows.map(toOrderRow).map((r) => [
        r.orderNo,
        r.userId,
        r.packageYuan,
        r.amountFen,
        r.coins,
        r.status,
        r.channel,
        r.tradeNo,
        r.paidAt,
        r.creditedAt,
        r.closedAt,
        r.createdAt,
      ]),
    );
  }

  /** `GET /api/admin/pay/orders/:orderNo`：详情（行 + notify_log 尾 20；不存在 ⇒ 404 借 10001）。 */
  @Get('orders/:orderNo')
  @HttpCode(200)
  async orderDetail(@Param('orderNo') orderNo: string) {
    const rows = (await this.dataSource.query(ADMIN_ORDER_DETAIL_SQL, [orderNo])) as Array<
      Record<string, unknown>
    >;
    const row = rows[0];
    if (!row) throw notFound('订单不存在');
    const notify = (await this.dataSource.query(ADMIN_NOTIFY_LOG_SQL, [orderNo])) as Array<
      Record<string, unknown>
    >;
    const detail: AdminPayOrderDetail = { ...toOrderRow(row), notifyLog: notify.map(toNotifyEntry) };
    return { code: ErrCode.OK, data: detail };
  }

  /* ────────────────────────────── ③ refunds ────────────────────────────── */

  /** `GET /api/admin/pay/refunds`：列表（无分页——§2.4.2 #3 无 cursor）。 */
  @Get('refunds')
  @HttpCode(200)
  async refundsList(@Query() query: QueryMap) {
    assertKnownKeys(query, ADMIN_PAY_REFUNDS_QUERY_KEYS);
    const { where, params } = this.refundFilters(query);
    const rows = (await this.dataSource.query(
      `${ADMIN_REFUNDS_SELECT_BASE}${where}${ADMIN_REFUNDS_LIST_SUFFIX}`,
      params,
    )) as Array<Record<string, unknown>>;
    return { code: ErrCode.OK, data: { items: rows.map(toRefundRow) } };
  }

  /** `GET /api/admin/pay/refunds.csv`：导出（§5 refunds 列逐字）。 */
  @Get('refunds.csv')
  @HttpCode(200)
  async refundsCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    assertKnownKeys(query, ADMIN_PAY_REFUNDS_QUERY_KEYS);
    const { where, params } = this.refundFilters(query);
    const rows = (await this.dataSource.query(
      `${ADMIN_REFUNDS_SELECT_BASE}${where}${ADMIN_REFUNDS_LIST_SUFFIX}`,
      params,
    )) as Array<Record<string, unknown>>;
    return sendCsv(
      res,
      'pay-refunds',
      ADMIN_REFUNDS_CSV_HEADER,
      rows.map(toRefundRow).map((r) => [
        r.refundNo,
        r.orderNo,
        r.userId,
        r.coins,
        r.status,
        r.reason,
        r.reviewedBy,
        r.reviewedAt,
        r.refundedAt,
        r.createdAt,
      ]),
    );
  }

  /** `GET /api/admin/pay/refunds/:refundNo`：详情（规格未列附加字段——与行同形）。 */
  @Get('refunds/:refundNo')
  @HttpCode(200)
  async refundDetail(@Param('refundNo') refundNo: string) {
    const rows = (await this.dataSource.query(ADMIN_REFUND_DETAIL_SQL, [refundNo])) as Array<
      Record<string, unknown>
    >;
    const row = rows[0];
    if (!row) throw notFound('退款单不存在');
    return { code: ErrCode.OK, data: toRefundRow(row) };
  }

  /**
   * `POST /api/admin/pay/refunds/:refundNo/review`（§2.4.2 #4）：approve 就地跑渠道退避表
   * （见文件头「通道长挂」——网关 5s 掐断但服务端继续）；非法源态 ⇒ 15009（T11 服务层）。
   */
  @Post('refunds/:refundNo/review')
  @HttpCode(200)
  async refundReview(
    @Param('refundNo') refundNo: string,
    @Body() body: { action?: unknown; note?: unknown } | undefined,
    @Req() req: AdminRequest,
  ) {
    const actor = adminActorOf(req);
    try {
      return { code: ErrCode.OK, data: await this.refunds.review(actor, refundNo, body) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /* ──────────────────────────── ⑤ withdrawals ──────────────────────────── */

  /** `GET /api/admin/pay/withdrawals`：列表（无分页）。 */
  @Get('withdrawals')
  @HttpCode(200)
  async withdrawalsList(@Query() query: QueryMap) {
    assertKnownKeys(query, ADMIN_PAY_WITHDRAWALS_QUERY_KEYS);
    const { where, params } = this.withdrawFilters(query);
    const rows = (await this.dataSource.query(
      `${ADMIN_WITHDRAWALS_SELECT_BASE}${where}${ADMIN_WITHDRAWALS_LIST_SUFFIX}`,
      params,
    )) as Array<Record<string, unknown>>;
    return { code: ErrCode.OK, data: { items: rows.map(toWithdrawRow) } };
  }

  /** `GET /api/admin/pay/withdrawals.csv`：导出（§5 withdrawals 列逐字）。 */
  @Get('withdrawals.csv')
  @HttpCode(200)
  async withdrawalsCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    assertKnownKeys(query, ADMIN_PAY_WITHDRAWALS_QUERY_KEYS);
    const { where, params } = this.withdrawFilters(query);
    const rows = (await this.dataSource.query(
      `${ADMIN_WITHDRAWALS_SELECT_BASE}${where}${ADMIN_WITHDRAWALS_LIST_SUFFIX}`,
      params,
    )) as Array<Record<string, unknown>>;
    return sendCsv(
      res,
      'pay-withdrawals',
      ADMIN_WITHDRAWALS_CSV_HEADER,
      rows.map(toWithdrawRow).map((r) => [
        r.withdrawNo,
        r.userId,
        r.coins,
        r.status,
        r.timeoutAt,
        r.reviewedBy,
        r.confirmedBy,
        r.voucher,
        r.rolledBackAt,
        r.createdAt,
      ]),
    );
  }

  /**
   * `GET /api/admin/pay/withdrawals/:withdrawNo`：详情（行 + **余额/cap 快照读**——§2.4.2 #5）。
   * 该读是管理诊断读（**不是**资金裁决点，§2.2.1 锁内纪律不因此放宽）；RPC 失败 ⇒
   * fail-closed（15003 变体 ⇒ 409），不伪造 0 读数。
   */
  @Get('withdrawals/:withdrawNo')
  @HttpCode(200)
  async withdrawDetail(@Param('withdrawNo') withdrawNo: string) {
    const rows = (await this.dataSource.query(ADMIN_WITHDRAW_DETAIL_SQL, [withdrawNo])) as Array<
      Record<string, unknown>
    >;
    const row = rows[0];
    if (!row) throw notFound('提现单不存在');
    const base = toWithdrawRow(row);
    let balance: number;
    let withdrawable: number;
    try {
      ({ balance, cap: withdrawable } = await this.currency.withdrawable({ ownerId: base.userId }));
    } catch {
      // 具体原因由 CurrencyRpcClient 侧（warn 日志）承载；本面只做 fail-closed 响应（翻 HTTP）。
      throw toHttpException(
        new DomainError(ErrCode.PAY_WITHDRAW_UNAVAILABLE, `提现详情读取失败（${TRANSPORT_FAILURE_MESSAGE}）`),
      );
    }
    return { code: ErrCode.OK, data: { ...base, balance, withdrawable } };
  }

  /** `POST /api/admin/pay/withdrawals/:withdrawNo/review`（§2.4.2 #6；approve/reject 语义在 T10 服务层）。 */
  @Post('withdrawals/:withdrawNo/review')
  @HttpCode(200)
  async withdrawReview(
    @Param('withdrawNo') withdrawNo: string,
    @Body() body: { action?: unknown; note?: unknown } | undefined,
    @Req() req: AdminRequest,
  ) {
    const actor = adminActorOf(req);
    try {
      return { code: ErrCode.OK, data: await this.withdrawals.review(actor, withdrawNo, body) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /** `POST /api/admin/pay/withdrawals/:withdrawNo/confirm`（§2.4.2 #7；claim approved→paid，T10 服务层）。 */
  @Post('withdrawals/:withdrawNo/confirm')
  @HttpCode(200)
  async withdrawConfirm(
    @Param('withdrawNo') withdrawNo: string,
    @Body() body: { voucher?: unknown; note?: unknown } | undefined,
    @Req() req: AdminRequest,
  ) {
    const actor = adminActorOf(req);
    try {
      return { code: ErrCode.OK, data: await this.withdrawals.confirmPaid(actor, withdrawNo, body) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /* ────────────────────────────── ⑧ actions ────────────────────────────── */

  /** `GET /api/admin/pay/actions`：审计第六源（三表处置事件流；无分页）。 */
  @Get('actions')
  @HttpCode(200)
  async actionsList(@Query() query: QueryMap) {
    assertKnownKeys(query, ADMIN_PAY_ACTIONS_QUERY_KEYS);
    const { where, params } = this.actionFilters(query);
    const rows = (await this.dataSource.query(
      `${ADMIN_ACTIONS_SELECT_BASE}${where}${ADMIN_ACTIONS_SUFFIX}`,
      params,
    )) as Array<Record<string, unknown>>;
    return { code: ErrCode.OK, data: { items: rows.map(toActionRow) } };
  }

  /** `GET /api/admin/pay/actions.csv`：导出（§5 actions 列逐字）。 */
  @Get('actions.csv')
  @HttpCode(200)
  async actionsCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    assertKnownKeys(query, ADMIN_PAY_ACTIONS_QUERY_KEYS);
    const { where, params } = this.actionFilters(query);
    const rows = (await this.dataSource.query(
      `${ADMIN_ACTIONS_SELECT_BASE}${where}${ADMIN_ACTIONS_SUFFIX}`,
      params,
    )) as Array<Record<string, unknown>>;
    return sendCsv(
      res,
      'pay-actions',
      ADMIN_ACTIONS_CSV_HEADER,
      rows.map(toActionRow).map((r) => [r.at, r.actor, r.kind, r.refNo, r.detail]),
    );
  }

  /* ─────────────────────────────── 内部 ─────────────────────────────────── */

  /** refunds 过滤（status → userId；顺序即拼装顺序）。 */
  private refundFilters(query: QueryMap): { where: string; params: unknown[] } {
    const status = parseStatus(query, ADMIN_REFUND_STATUSES, '退款');
    const userId = parseUserId(query);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (status !== undefined) (conds.push('`status` = ?'), params.push(status));
    if (userId !== undefined) (conds.push('`user_id` = ?'), params.push(userId));
    return { where: conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '', params };
  }

  /** withdrawals 过滤（同 refunds）。 */
  private withdrawFilters(query: QueryMap): { where: string; params: unknown[] } {
    const status = parseStatus(query, ADMIN_WITHDRAW_STATUSES, '提现');
    const userId = parseUserId(query);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (status !== undefined) (conds.push('`status` = ?'), params.push(status));
    if (userId !== undefined) (conds.push('`user_id` = ?'), params.push(userId));
    return { where: conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '', params };
  }

  /** actions 过滤（from → to → actor；半开区间 [from, to)，作用在外层 `t.at`）。 */
  private actionFilters(query: QueryMap): { where: string; params: unknown[] } {
    const from = parseEpochMs(query, 'from');
    const to = parseEpochMs(query, 'to');
    const actor = parseActor(query);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (from !== undefined) (conds.push('t.`at` >= ?'), params.push(new Date(from)));
    if (to !== undefined) (conds.push('t.`at` < ?'), params.push(new Date(to)));
    if (actor !== undefined) (conds.push('t.`actor` = ?'), params.push(actor));
    return { where: conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '', params };
  }
}

/** 批量玩家 userIds：数组、1–100、去重、每个 1–36；非法 ⇒ 400（10001）。 */
function normalizePlayerIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) {
    throw httpException(ErrCode.BAD_PARAM, 'userIds 必须是 1–100 个元素的数组');
  }
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 36) {
      throw httpException(ErrCode.BAD_PARAM, 'userIds 元素必须是 1–36 字符的字符串');
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
