import { createHash, createHmac } from 'node:crypto';

/** 从库里读出的 number/bigint ⇒ 安全整数（读不出 ⇒ 抛，不静默转 NaN/字符串）。 */
export function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/**
 * 手机号归一化的**唯一实现**（bind/rebind/profile 三处共用）。
 *
 * 2026-10-26 r3 审查 Important #2：只 trim 会让 `+86 138…` / `138-…` 等**同一手机号的不同写法**
 * 产生不同 HMAC ⇒ 代理可用变体号注册玩家绕过「自玩不拿佣金」特判。这里做**有限**数字归一：
 *  - 全角数字 → 半角；去掉所有非数字（空格/`+`/`-`/括号）；
 *  - 去 `0086` / `86` 国家码前缀；
 *  - 结果必须恰为 `^1\d{10}$`，否则**保留 trim 原值**（不认识的格式不擅自改写）。
 * 归一后的值同时用于代理手机号存储/登录与绑定 HMAC（两侧同式）。
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const halfWidth = trimmed.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  const digits = halfWidth.replace(/\D/g, '');
  let local = digits;
  if (/^0086\d{11}$/.test(local)) local = local.slice(4);
  else if (/^86\d{11}$/.test(local)) local = local.slice(2);
  return /^1\d{10}$/.test(local) ? local : trimmed;
}

/** 门户展示用脱敏：前 3 后 4；不足 7 位 → 原样（不编造）。 */
export function maskPhone(phone: string): string {
  const p = normalizePhone(phone);
  if (p.length < 7) return p;
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

/** 手机号 HMAC（自玩判定）。production 缺 key 由 `main.ts` 启动 fail-closed。 */
export function hmacPhone(phone: string): string {
  const key = process.env.AGENT_PHONE_HMAC_KEY || 'dev-agent-phone-hmac-key';
  return createHmac('sha256', key).update(normalizePhone(phone)).digest('hex');
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

/** Asia/Shanghai 自然日的 UTC 区间 `[start, end)`（日限查询用）。 */
export function shanghaiDayRange(now: Date): { start: Date; end: Date } {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string): number =>
    Number(day.find((p) => p.type === type)?.value ?? '0');
  const startMs = Date.UTC(part('year'), part('month') - 1, part('day')) - 8 * 3_600_000;
  return { start: new Date(startMs), end: new Date(startMs + 86_400_000) };
}
