/**
 * 支付片：桥接页能力 token（`/pay/cashier/:orderNo?t=…` 的唯一访问凭证；无状态 HMAC）。
 *
 * ─── 信任模型 ─────────────────────────────────────────────────────────────
 * 桥接页是**玩家浏览器直连的公开面**（不经网关 JWT、不带内部 token），页面里含有该订单
 * 已签名的 wap.pay 表单。谁持有桥接 URL，谁就能在订单有效期内打开收银台——与旧实现直接
 * 下发「网关?已签名表单」能力 URL 的威胁级别相同。故 token：
 *  - HMAC-SHA256 签名，secret = `INTERNAL_SERVICE_TOKEN`（内部调用面同一密钥；服务启动
 *    fail-closed 强制在场，**不新增 env**）；
 *  - 载荷绑定 `orderNo`（控制器比对路径段）与 `expMs`（= 下单时刻 + 订单 TTL）；
 *    `ttlMin` 随载荷签名保护，桥接页重签 `timeout_express` 与下单意图逐字一致；
 *  - 比对走 `timingSafeEqual`；任何畸形/篡改/过期 ⇒ `null`（调用方一律回 404，
 *       不区分「单不存在」与「token 非法」）。
 * 终局可支付判据仍由 OrdersService 的 SQL（`status='created' AND expires_at > NOW(3)`）裁决，
 * token 只负责页面访问面（应用时钟与 DB 时钟的秒级偏差由 SQL 终裁）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** token 载荷（orderNo/expMs/ttlMin 全部参与签名）。 */
export interface CashierTokenPayload {
  orderNo: string;
  /** 过期时刻（epoch ms；应用时钟；与订单 expires_at 同级有效期）。 */
  expMs: number;
  /** 下单时的订单有效分钟数（桥接页重签 timeout_express 用，防管理员事后改 TTL）。 */
  ttlMin: number;
}

/** 签发新 token：`<base64url(payload)>.<base64url(hmac)>`。 */
export function signCashierToken(payload: CashierTokenPayload, secret: string): string {
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${hmac(body, secret)}`;
}

/**
 * 校验 token。`expectedOrderNo` 非空时要求载荷单号与其逐字一致（路径绑定）。
 * 任何不符（形状/签名/过期/绑定/非 JSON/非有限数）⇒ `null`，不抛。
 */
export function verifyCashierToken(
  token: string,
  secret: string,
  nowMs: number,
  expectedOrderNo?: string,
): CashierTokenPayload | null {
  if (typeof token !== 'string' || token.length === 0 || typeof secret !== 'string' || secret.length === 0) {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (body.length === 0 || mac.length === 0) return null;

  const expectedMac = hmac(body, secret);
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainRecord(payload)) return null;
  const { orderNo, expMs, ttlMin } = payload;
  if (typeof orderNo !== 'string' || orderNo.length === 0) return null;
  if (typeof expMs !== 'number' || !Number.isFinite(expMs)) return null;
  if (typeof ttlMin !== 'number' || !Number.isFinite(ttlMin) || ttlMin <= 0) return null;
  if (typeof nowMs === 'number' && Number.isFinite(nowMs) && expMs <= nowMs) return null;
  if (expectedOrderNo !== undefined && orderNo !== expectedOrderNo) return null;
  return { orderNo, expMs, ttlMin };
}

/** secret 现读（env 空串 = 未设，fail-closed）。 */
export function cashierTokenSecret(): string {
  return process.env.INTERNAL_SERVICE_TOKEN || '';
}

function hmac(body: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(body, 'utf8').digest());
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
