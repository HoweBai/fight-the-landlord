import type { NotifyChannelKey } from '@fight-the-landlord/protocol';

/**
 * 通知通道九键的校验/规范化 + URL hint 原语（规格 §2.4 校验矩阵与 hint 规则**逐字**；⚙️7）。
 *
 * 统一前置（§2.4 表注）：全键先 `trim()`；trim 后空串 ⇒ 拒（400）。空串理由 = `值不得为空`
 * （§2.4 表 host 行的第三理由；预检对九键统一执行——照支付片 `pay-channel.validators.ts`
 * 「全键先 trim；空串 ⇒ 拒」同形先例）。**canonical 规则 = §2.3「唯一变换 = trim」**：
 * 连 URL 也不改写（凭据 URL 逐字保真——与支付片「剥尾斜杠」**有意不同规**）。
 *
 * 逐键（§2.4 表逐格）：
 *  - `smtp.host`：`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$`
 *    （**微审 v1.7** 收紧：拒 `...`/`..`/首尾点/首尾横线/纯符号，≥1 字母数字——W3 深扫实证旧式
 *    `^[A-Za-z0-9.-]+$` 放行 `...` ⇒ 邮件静默死）；canonical = trim 原文；≤253。
 *  - `smtp.port`：`^\d{1,5}$` 且数值 1–65535；canonical = trim 原文数字串（前导零不剥）。
 *  - `smtp.user`：无空白（`\s`）；canonical = trim 原文；≤254。
 *  - `smtp.pass`：无 `\u0000-\u001f`/`\u007f` 控制字符（**空格合法**）；canonical = trim 原文；≤512。
 *  - `email.to`：逗号分隔逐项（非空 + `^[^\s@,]+@[^\s@,]+$`）；canonical = 逐项 trim 后 `,` 连接；项 ≤254。
 *  - 三 URL 键：`new URL()` 可解析 + protocol ∈ {`http:`,`https:`}；canonical = trim 原文；≤2048。
 *  - `dingtalkSecret`：无空白；canonical = trim 原文；≤256。
 *
 * ⚠️ **理由文案不含输入值**（§2.9 纪律）：`reason` 只讲「哪里不合规」（可含上限数字），
 * 绝不内嵌 `raw` 的任何片段——400 message 会原样回显到管理页/日志，值可能含密钥材料。
 *
 * `urlHint(value)`（§2.4 hint 规则逐字；由调用侧**只对三 URL 键**调用）：`h = new URL(value).host`
 * （WHATWG 已小写归一、默认端口被删）**全等**匹配三平台 allowlist 之一 ⇒ 返回 `origin`；否则
 * `'外部地址'`；非 URL/解析失败 ⇒ `null`。全等匹配防 `endsWith`/`includes` 类仿冒变体
 * （如 `evilqyapi.weixin.qq.com.hk`、`qyapi.weixin.qq.com.evil.com`）。其余六键 `hint` 恒 null
 * （由调用侧按键分发，见 T5 service）。
 */

export type NotifyChannelValidation = { ok: true; canonical: string } | { ok: false; reason: string };

/* §2.4 上限列（逐键；数值仅出现在 reason 文案里时保持逐字——由模板拼出）。 */
const HOST_MAX_LEN = 253;
const PORT_MAX = 65535;
const USER_MAX_LEN = 254;
const PASS_MAX_LEN = 512;
const EMAIL_ITEM_MAX_LEN = 254;
const URL_MAX_LEN = 2048;
const DINGTALK_SECRET_MAX_LEN = 256;

/* ⚠️ 下列 reason 全部为**常量**：不含 raw 的任何片段（§2.9）；文案逐字 = §2.4 表 reason 列。 */
const EMPTY_REASON = '值不得为空';
const HOST_PATTERN_REASON = '必须是合法主机名（字母/数字/点/横线）';
const HOST_LEN_REASON = `长度超过上限 ${HOST_MAX_LEN}`;
const PORT_REASON = '必须是 1-65535 的端口号';
const WHITESPACE_REASON = '不得包含空白字符';
const USER_LEN_REASON = `长度超过上限 ${USER_MAX_LEN}`;
const PASS_CONTROL_REASON = '授权码不得包含换行或控制字符';
const PASS_LEN_REASON = `长度超过上限 ${PASS_MAX_LEN}`;
const EMAIL_FORMAT_REASON = '收件地址格式不合法（单个或逗号分隔列表）';
const EMAIL_LEN_REASON = `长度超过上限 ${EMAIL_ITEM_MAX_LEN}`;
const URL_REASON = '必须是 http/https 协议的合法 URL';
const URL_LEN_REASON = `长度超过上限 ${URL_MAX_LEN}`;
const DINGTALK_SECRET_LEN_REASON = `长度超过上限 ${DINGTALK_SECRET_MAX_LEN}`;

/* §2.4 smtp.host 行**逐字**（微审 v1.7 收紧——每标签 ≥1 字母数字、首尾均字母数字、点仅作标签分隔；
   旧式 `^[A-Za-z0-9.-]+$` 放行 `...`/`..`/`-`/首尾点横线 ⇒ 邮件静默失效且完整性规则不响）。 */
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const PORT_PATTERN = /^\d{1,5}$/;
const EMAIL_ITEM_PATTERN = /^[^\s@,]+@[^\s@,]+$/;
const WHITESPACE_PATTERN = /\s/;
/** `\u0000-\u001f`（含 `\t\n\r`）+ `\u007f`（DEL）——§2.4 pass 行逐字。 */
const CONTROL_CHARS_PATTERN = /[\u0000-\u001f\u007f]/;

/** hint 三平台 allowlist（§2.4：`h = new URL(value).host` 与之**全等**比较；WHATWG 已小写归一）。 */
const HINT_HOST_ALLOWLIST: ReadonlySet<string> = new Set([
  'qyapi.weixin.qq.com',
  'open.feishu.cn',
  'oapi.dingtalk.com',
]);
const HINT_EXTERNAL = '外部地址';

function reject(reason: string): NotifyChannelValidation {
  return { ok: false, reason };
}

/** host 共规（§2.4；**v1.7**）：正则（拒下划线/冒号/空格/中文等非字母数字点横线字符，且拒裸点串/
 * `..`/首尾点/首尾横线——≥1 字母数字、每标签首尾均字母数字）→ ≤253。 */
function validateHost(trimmed: string): NotifyChannelValidation {
  if (!HOST_PATTERN.test(trimmed)) return reject(HOST_PATTERN_REASON);
  if (trimmed.length > HOST_MAX_LEN) return reject(HOST_LEN_REASON);
  return { ok: true, canonical: trimmed };
}

/** port 共规（§2.4）：`^\d{1,5}$` → 数值 1–65535；canonical = trim 原文数字串（不剥前导零）。 */
function validatePort(trimmed: string): NotifyChannelValidation {
  if (!PORT_PATTERN.test(trimmed)) return reject(PORT_REASON);
  const port = Number(trimmed);
  if (port < 1 || port > PORT_MAX) return reject(PORT_REASON);
  return { ok: true, canonical: trimmed };
}

/** 非空（预检已证）+ 无空白 + 限长共规（`smtp.user` ≤254 · `dingtalkSecret` ≤256）；canonical = trim 原文。 */
function validateNoWhitespace(trimmed: string, maxLen: number, lenReason: string): NotifyChannelValidation {
  if (WHITESPACE_PATTERN.test(trimmed)) return reject(WHITESPACE_REASON);
  if (trimmed.length > maxLen) return reject(lenReason);
  return { ok: true, canonical: trimmed };
}

/** pass 专项（§2.4）：无控制字符（**空格 ` ` 不是控制字符、合法**——授权码可含空格）→ ≤512。 */
function validatePass(trimmed: string): NotifyChannelValidation {
  if (CONTROL_CHARS_PATTERN.test(trimmed)) return reject(PASS_CONTROL_REASON);
  if (trimmed.length > PASS_MAX_LEN) return reject(PASS_LEN_REASON);
  return { ok: true, canonical: trimmed };
}

/**
 * `email.to` 专项（§2.4）：逗号分隔**逐项**——项 trim 后须非空且过 `^[^\s@,]+@[^\s@,]+$`，
 * 项长 ≤254；canonical = 逐项 trim 后 `,` 连接（全列表无总长上限——上限列 = 「项 ≤254」逐字）。
 */
function validateEmailToList(trimmed: string): NotifyChannelValidation {
  const canonicalItems: string[] = [];
  for (const item of trimmed.split(',')) {
    const address = item.trim();
    if (address.length === 0 || !EMAIL_ITEM_PATTERN.test(address)) return reject(EMAIL_FORMAT_REASON);
    if (address.length > EMAIL_ITEM_MAX_LEN) return reject(EMAIL_LEN_REASON);
    canonicalItems.push(address);
  }
  return { ok: true, canonical: canonicalItems.join(',') };
}

/** 三 URL 键共规（§2.4）：可解析 + protocol ∈ {http:, https:} → ≤2048；canonical = trim 原文（**不改写**）。 */
function validateHttpUrl(trimmed: string): NotifyChannelValidation {
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return reject(URL_REASON);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reject(URL_REASON);
  if (trimmed.length > URL_MAX_LEN) return reject(URL_LEN_REASON);
  return { ok: true, canonical: trimmed };
}

/**
 * 九键校验/规范化入口（§1.1 接口逐字）。**纯函数、不触库**（400 先于一切库操作，§3.1 纪律）。
 */
export function validateAndNormalize(key: NotifyChannelKey, raw: string): NotifyChannelValidation {
  if (typeof raw !== 'string') return reject('值必须是字符串'); // 防御支（照 pay 同形）；类型调用面不可达
  const trimmed = raw.trim(); // 全键先 trim（§2.4）
  if (trimmed.length === 0) return reject(EMPTY_REASON);

  switch (key) {
    case 'notify.smtp.host':
      return validateHost(trimmed);
    case 'notify.smtp.port':
      return validatePort(trimmed);
    case 'notify.smtp.user':
      return validateNoWhitespace(trimmed, USER_MAX_LEN, USER_LEN_REASON);
    case 'notify.smtp.pass':
      return validatePass(trimmed);
    case 'notify.email.to':
      return validateEmailToList(trimmed);
    case 'notify.webhook.feishuUrl':
    case 'notify.webhook.wecomUrl':
    case 'notify.webhook.dingtalkUrl':
      return validateHttpUrl(trimmed);
    case 'notify.webhook.dingtalkSecret':
      return validateNoWhitespace(trimmed, DINGTALK_SECRET_MAX_LEN, DINGTALK_SECRET_LEN_REASON);
    default:
      // 类型上不可达（NotifyChannelKey 为九字面量并集）；未知键 400 的白名单在 controller 注册表（T6）
      return reject('未知键');
  }
}

/**
 * URL `hint` 原语（§2.4 hint 规则逐字）——**只对三 URL 键调用**（调用侧纪律）。
 *
 * 返回：三平台 allowlist 的 `.host` **全等**命中 ⇒ `origin`；其余可解析 URL ⇒ `'外部地址'`；
 * 非 URL/解析失败 ⇒ `null`（防御支路：读路径以已验 canonical http(s) 值调用）。
 * WHATWG 语义注意：`.host` 已小写归一、**默认端口被删**（`:443` https / `:80` http 与无端口等价
 * ⇒ 仍全等命中）；显式**非默认**端口会进入 `.host`（如 `host:8443`）⇒ 不全等 ⇒ `'外部地址'`。
 */
export function urlHint(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return HINT_HOST_ALLOWLIST.has(parsed.host) ? parsed.origin : HINT_EXTERNAL;
}
