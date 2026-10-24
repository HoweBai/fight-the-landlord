/**
 * 支付片 T13：**三表 `mine` 共用的 keyset 游标件**（从 `orders.service.ts` 原样拆出——
 * 叶子模块纪律照 T9 `scan/replay-anchor.ts` 先例：`withdraw.service`/`refund.service`
 * 要 import 本件，若留在 `orders.service.ts` 则成
 * `withdraw → orders → scan → withdraw` 的 CJS 模块环（装饰器读半载模块 = 静默 DI 破损）。
 * `orders.service.ts` **re-export** 本件全部符号 ⇒ 既有消费面（admin-pay.controller /
 * orders-state 套件）导入点零漂移。
 *
 * 口径（T7 起冻结）：游标明文 `epochMs:rowId` 经 **base64url**（URL 安全——`+` 在查询串里
 * 会被解成空格）；非法形态**当场拒**（10001），不静默回落第一页；`limit` 缺省 20、上限 50
 * （§2.4.1 #4/#7/#9；非法值回落默认而非报错）。
 */

import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';

/** `mine` 默认页大小与上限（§2.4.1 #4：默认 20、≤50——服务端 clamp）。 */
export const PAY_ORDERS_MINE_DEFAULT_LIMIT = 20;
export const PAY_ORDERS_MINE_MAX_LIMIT = 50;

/** `mine` 的 limit clamp（§2.4.1 #4：默认 20、上限 50；非法值回落默认而非报错）。 */
export function clampMineLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) return PAY_ORDERS_MINE_DEFAULT_LIMIT;
  return Math.min(n, PAY_ORDERS_MINE_MAX_LIMIT);
}

/** 游标明文形态：`epochMs:rowId`（收在服务端内部；照 records 先例）。 */
const CURSOR_RE = /^(\d{1,15}):(\d{1,15})$/;

/** 解码产物（三表 `mine` 与 admin orders 共用形状）。 */
export interface PayOrdersCursor {
  createdAtMs: number;
  rowId: number;
}

const invalidCursor = (): DomainError =>
  new DomainError(ErrCode.BAD_PARAM, 'cursor 不合法：须为本服务签发的 nextCursor 原样回传');

/** `(createdAt, id)` ⇒ 不透明串（base64url —— URL 安全）。 */
export function encodePayOrdersCursor(createdAtMs: number, rowId: number): string {
  return Buffer.from(`${createdAtMs}:${rowId}`, 'utf8').toString('base64url');
}

/** 不透明串 ⇒ `(createdAt, id)`；非法形态**当场拒**（10001），不静默回落第一页。 */
export function decodePayOrdersCursor(cursor: unknown): PayOrdersCursor {
  if (typeof cursor !== 'string' || cursor.length === 0) throw invalidCursor();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw invalidCursor();
  const m = CURSOR_RE.exec(decoded);
  if (!m) throw invalidCursor();
  const createdAtMs = Number(m[1]);
  const rowId = Number(m[2]);
  if (!Number.isSafeInteger(createdAtMs) || !Number.isSafeInteger(rowId) || rowId < 1) throw invalidCursor();
  return { createdAtMs, rowId };
}
