import { createHash } from 'node:crypto';

/** 从库里读出的 number/bigint ⇒ 安全整数（读不出 ⇒ 抛，不静默转 NaN/字符串）。 */
export function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/** 手机号归一化的**唯一实现**（bind/rebind/profile 三处共用）。 */
export function normalizePhone(phone: string): string {
  return phone.trim();
}

/** 门户展示用脱敏：前 3 后 4；不足 7 位 → 原样（不编造）。 */
export function maskPhone(phone: string): string {
  const p = normalizePhone(phone);
  if (p.length < 7) return p;
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

/** SHA-256 hex（items_hash / 审计指纹）。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** MySQL datetime(3) 读回：Date 或可解析字符串；坏值抛。 */
export function toDate(value: unknown, context: string): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${context}：读出的值不是合法时间（收到 ${JSON.stringify(value)}）`);
  }
  return d;
}
