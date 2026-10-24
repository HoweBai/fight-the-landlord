/**
 * §5.5 的脱敏规则**唯一实现**（R142）。
 *
 * 为什么在 `shared` 而不是每个服务一份：规则是本片最容易漂移的东西
 * （一个服务补了手机号、另一个漏了手牌 = **静默泄敏**）。Nest 适配层
 * （`redacting-logger.ts`）也放这里，但**不 import `@nestjs/common`** ——
 * `packages/shared` 的 tsconfig 是 `"types": []`，而且加依赖要动
 * `pnpm-lock.yaml`（协调者独占的根配置）。
 *
 * 覆盖面（§5.5 的表 + 对账表 S7 的手牌要求）：
 *   手机号 / JWT 全文与 Bearer / 密码类键 / 内部头的值 / 手牌类键。
 * **不覆盖**：`X-User-Id`（§5.5 允许记录，排障需要）—— 是有意的，不是漏了。
 */
export const REDACTED = '[REDACTED]' as const;

/**
 * 手牌类键：命中就把整个数组换成只留张数的占位（**牌面一律不落盘**）。
 *
 * `deck` 在这里是「预防性」的：`PlayerView` 现在不含它，但它是 `GameSession`
 * 的字段，本片新加的正则**不能**只挡住「现在恰好会出现的键」。
 */
const CARD_KEYS = 'hand|hands|cards|bottomCards|actionLog|playedCards|deck';

const CARD_LIST = new RegExp(`(["']?(?:${CARD_KEYS})["']?\\s*[:=]\\s*)\\[([^\\]]*)\\]`, 'gi');
const SECRET_KEY = new RegExp(
  `(["']?(?:password|passwd|pwd|passwordHash|password_hash|refreshToken|accessToken)["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,}]+)`,
  'gi',
);
const SECRET_HEADER = /((?:x-internal-token|x-token-jti)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const PHONE = /1[3-9]\d{9}/g;

/**
 * PEM **私钥块**（支付片 §12 的机械层）：从 `-----BEGIN … PRIVATE KEY-----`
 * 到对应 `-----END … PRIVATE KEY-----` 的**整块** ⇒ `[REDACTED_PRIVATE_KEY]`。
 *
 * ⚠️ **必须排在本链第一**（顺序是判据的一部分）：块正文是 base64，其中的数字串会命中
 * `PHONE` 等后续规则 ⇒ 先被局部替换后，整块正则再也认不出开始/结束标记，留下
 * `138****1234` 这类"半脱敏残渣"。整块先拿走，正文才不可能被别的规则啃。
 *
 * 覆盖面声明（有意为之）：只认 **PEM 形状**（含 JSON 转义成 `\n` 两字符的形态）；
 * `PUBLIC KEY` / `CERTIFICATE` 块**不匹配**（不是秘密）；`base64(PEM)` 的原文形态
 * 超出形状可判范围 —— 支付片靠纪律兜底（`ALIPAY_PRIVATE_KEY` 等 env 值不进日志/响应）；
 * **支付配置管理化片（评审 G1）** 对渠道键名补第一层结构性兜底：值形态（base64 PEM /
 * 随机令牌）本规则仍认不出，但 `SECRET_KEY_NAME` 命中 `pay.channel.privateKey` /
 * `PAY_CHANNEL_PULL_TOKEN` 这类**键名**时整值替换（见该常量注释）。
 */
const PRIVATE_KEY_PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * 替换时**保留原来的引号风格**：JSON 日志里 `"password":"pw"` 换成 `"password":"[REDACTED]"`
 * 才仍然是合法 JSON（换成不带引号的 bare 词会让后续解析器炸，也会让日志看起来像坏了）。
 */
const maskValue = (value: string): string =>
  value.startsWith('"') ? `"${REDACTED}"` : value.startsWith("'") ? `'${REDACTED}'` : REDACTED;

/** `[3,4,5]` → `"[REDACTED 3 cards]"`（只留张数，牌面绝不出现）。 */
const countCards = (list: string): string => {
  const trimmed = list.trim();
  const n = trimmed.length === 0 ? 0 : trimmed.split(',').length;
  return `"[REDACTED ${n} cards]"`;
};

/**
 * 文本脱敏（§5.5）。**顺序有意义**：
 *  0. **最先**处理 PEM 私钥块（支付片 §12）—— 形状规则，整块替换见 `PRIVATE_KEY_PEM` 注释；
 *  1. 再处理**结构化**的模式（键值对、列表）—— 它们带上下文，能保留引号风格；
 *  2. 最后处理**自包含**的令牌（JWT / Bearer）与手机号。
 *
 * 反过来（先替换 JWT）会让 `"password":"<jwt>"` 这类嵌套情形丢掉引号风格。
 */
export function redactText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(PRIVATE_KEY_PEM, '[REDACTED_PRIVATE_KEY]')
    .replace(CARD_LIST, (_m, prefix: string, list: string) => `${prefix}${countCards(list)}`)
    .replace(SECRET_HEADER, (_m, prefix: string, value: string) => `${prefix}${maskValue(value)}`)
    .replace(SECRET_KEY, (_m, prefix: string, value: string) => `${prefix}${maskValue(value)}`)
    .replace(JWT, '[REDACTED_JWT]')
    .replace(BEARER, 'Bearer [REDACTED_JWT]')
    .replace(PHONE, (m) => `${m.slice(0, 3)}****${m.slice(7)}`);
}

/** 递归深度上限：超深结构整体替换，免得日志被一个深对象打爆。 */
const MAX_DEPTH = 6;

/**
 * 键名脱敏（对象路径）。既有敏感键 = 整键全等（`^…$`）；
 * **支付配置管理化片（评审 G1）** 追加一支**段界**规则：渠道私钥与拉取令牌在日志
 * 对象里的键名形态 —— `pay.channel.privateKey`（点号前缀）/ `privateKey` / `private_key`
 * 与 `PAY_CHANNEL_PULL_TOKEN` / `pullToken` / `pull_token`（段界 `(^|[._])`，下划线分隔
 * 的 env 形态与驼峰/点号形态同命中）。
 * **通知通道管理化片（T10）** 再追加一支**枚举式**规则：通知命名空间（第三键空间）的
 * **五密键全名** —— `notify.smtp.pass` 与 `notify.webhook.{feishuUrl,wecomUrl,dingtalkUrl,dingtalkSecret}`
 * （值 = 邮箱授权码 / 平台 webhook URL（含加签密钥），形状规则认不出 ⇒ 键名是唯一可靠的上下文）。
 * ⚠️ **枚举而非通配 `notify.*` / 裸 `url`**：非密键（`notify.smtp.host` 等）与
 * `REDIS_URL` / `DOUZERO_URL` 一律**不得**命中（单测负例钉住）。
 * ⚠️ 段界是判据的一部分：**不得**吞掉 `alipayPrivateKey`（无段界）—— 那个名字走文本
 * 路径的 PEM 块规则（产出 `[REDACTED_PRIVATE_KEY]` 形态，既有单测钉住）；
 * `publicKey` 类名不命中（公钥不是秘密）。
 * **广告片（T10）** 再追加一枚**枚举式**全名：第四键空间（广告回调密钥，工作名
 * `ad.callbackSecret` —— T0-2 回填可改名，影响面 = 本规则 + 单测，低）的**唯一键**
 * （该键空间全键 = 密键；值 = 平台回调密钥，形状规则认不出 ⇒ 键名是唯一可靠上下文）。
 * ⚠️ 同样**枚举而非通配 `ad.*`**：第 41 键 `ad.reliefAdpid`（参数键、在广播快照里、
 * 非秘密）一律**不得**命中（单测负例钉住）；`AD_CHANNEL_PULL_TOKEN`（env 形拉取令牌）
 * **无需**枚举加项 —— 上面段界规则 `(^|[._])pull[_]?token$` 已覆盖（单测正例钉住）。
 */
const SECRET_KEY_NAME =
  /^(password|passwd|pwd|passwordHash|password_hash|refreshToken|accessToken)$|(^|[._])(private[_]?key|pull[_]?token)$|(^|[._])notify\.(smtp\.pass|webhook\.(feishuUrl|wecomUrl|dingtalkUrl|dingtalkSecret))$|(^|[._])ad\.callbackSecret$/i;
const CARD_KEY_NAME = new RegExp(`^(${CARD_KEYS})$`, 'i');
const INTERNAL_HEADER_NAME = /^(x-internal-token|x-token-jti)$/i;

/**
 * 对象/数组先**按键名**脱敏，再交给 `redactText` 兜底（调用方可能直接 log 一个对象，
 * 那时键名就是唯一可靠的上下文 —— 只靠正则扫文本会漏掉 `{ hand: [3,4,5] }`）。
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_NAME.test(k)) out[k] = REDACTED;
      else if (CARD_KEY_NAME.test(k)) out[k] = `[REDACTED ${Array.isArray(v) ? v.length : 0} cards]`;
      else if (INTERNAL_HEADER_NAME.test(k)) out[k] = REDACTED;
      else out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}
