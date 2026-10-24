/**
 * 支付片 T6：支付宝**参数规范化**（规格 ⚙️6 两口径 + ⚙️5 金额格式化；零外部依赖）。
 *
 * 三个函数 = 三种"签名输入"：
 *  - `buildNotifySignSource` —— ⚙️6① **通知**口径：除 `sign`/`sign_type` 外全部参数，
 *    按参数名 **ASCII 升序**，`k=v` 以 `&` 连接；**值取解码后原文、不二次编码**
 *    （form 解码由控制器侧完成——本函数拿到的是已解码的字符串）。
 *  - `buildRequestSignSource` —— **出站请求**口径：全参数 + `sign_type=RSA2` 同序
 *    （与通知口径的**关键差异**：`sign_type` **参与**出站签名、不参与通知验签）。
 *  - `extractResponseSignSource` —— ⚙️6② **同步响应**口径：`<api>_response` 键对应值的
 *    **原文子串**（逐字节切片，不是重排序、不是重序列化）。
 *
 * ## 低置信登记（⚙️6 逐字里没有、但真实支付宝文档有出入的两点）
 *
 * ① **空值参数**：官方签名规则含「值为空的参数不参与签名」，本规格 ⚙️6 逐字未写 ⇒ 本实现
 *    按逐字**不剔除空值**（`a=` 照常参与）。实践中调用方（`client.ts` 组装 + 回调解析侧）
 *    不产生空值参数 ⇒ 与官方规则在可观测层面等价；沙箱联调（T16）若采集到空值参数，
 *    改动点 = 两个函数的 filter + 同提交测试。
 * ② **出站 `sign_type` 覆盖**：本函数把 `sign_type` **强制**为 `RSA2`（有则覆盖、无则补上,
 *    见下方注释）——本项目只支持 RSA2；若调用方传了别的值，签名串与线上表单会在网关侧
 *    **响亮失败**（不会静默签出错误协议）。
 *
 * ⚠️ 本模块**零依赖**（只 import 无：纯函数）—— 不引 `node:crypto`（那是 `sign.ts` 的事），
 * 也**不做金额换算以外的任何解析**。
 */

export type RawParams = Record<string, string>;

const ASCII_ASC = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** ⚙️6 共性：按参数名 ASCII 升序 ⇒ `k=v` 以 `&` 连接（值原样，不 encode）。 */
function canonicalize(entries: Array<[string, string]>): string {
  return entries
    .sort(([a], [b]) => ASCII_ASC(a, b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** ⚙️6① 通知验签的规范化串（除 `sign`/`sign_type` 外全部参数，ASCII 升序）。 */
export function buildNotifySignSource(params: RawParams): string {
  return canonicalize(Object.entries(params).filter(([k]) => k !== 'sign' && k !== 'sign_type'));
}

/** ⚙️6 出站请求签名的规范化串（全参数 + `sign_type=RSA2` 同序；只排除 `sign`）。 */
export function buildRequestSignSource(params: RawParams): string {
  return canonicalize([
    ...Object.entries(params).filter(([k]) => k !== 'sign' && k !== 'sign_type'),
    ['sign_type', 'RSA2'],
  ]);
}

/** `alipay.trade.query` ⇒ `alipay_trade_query_response`（⚙️6② 的键形状）。 */
export function apiResponseKey(apiName: string): string {
  return `${apiName.replace(/\./g, '_')}_response`;
}

/**
 * ⚙️6②：从响应体**原文**里切出 `<api>_response` 键对应值的子串（含首尾花括号/方括号，
 * 逐字节；若值是字符串则含引号）。取不到 ⇒ `null`。
 *
 * 实现：定位 `"<key>"` → `:` → 跳过空白 → 从值的起始字符起做**括号配对扫描**
 * （尊重 JSON 字符串与 `\` 转义）。**不得**用 `JSON.stringify(JSON.parse(...))` 代替 ——
 * 那会把空白/转义形态重排，与支付宝实际签名时的字节不再一致（判别性用例在 sign.test.ts）。
 *
 * 边界（登记）：键名若在**其它字符串值内部**出现（如某个值的内容就是 `"alipay_trade_query_response"`），
 * 朴素 `indexOf` 会先命中它 —— 支付宝响应形状下该情形不发生（键都是顶层字面键），
 * 与官方 SDK 的同类朴素定位一致；出现即拒签（fail-closed 方向）。
 */
export function extractResponseSignSource(rawBody: string, apiName: string): string | null {
  const marker = `"${apiResponseKey(apiName)}"`;
  const at = rawBody.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  while (i < rawBody.length && /\s/.test(rawBody[i]!)) i += 1;
  if (rawBody[i] !== ':') return null;
  i += 1;
  while (i < rawBody.length && /\s/.test(rawBody[i]!)) i += 1;
  const start = i;
  const first = rawBody[start];

  if (first === '{' || first === '[') {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < rawBody.length; i += 1) {
      const c = rawBody[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{' || c === '[') {
        depth += 1;
      } else if (c === '}' || c === ']') {
        depth -= 1;
        if (depth === 0) return rawBody.slice(start, i + 1);
      }
    }
    return null; // 括号不闭合 = 形状非法
  }

  if (first === '"') {
    for (i = start + 1; i < rawBody.length; i += 1) {
      const c = rawBody[i]!;
      if (c === '\\') i += 1;
      else if (c === '"') return rawBody.slice(start, i + 1);
    }
    return null;
  }

  return null;
}

/**
 * ⚙️5 逐字：`fen2yuan(fen)` = `` `${Math.floor(fen/100)}.${String(fen%100).padStart(2,'0')}` ``
 * ——**禁浮点**（`0.1+0.2` 类误差在这里结构上不可能出现）。
 */
export function fen2yuan(fen: number): string {
  return `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, '0')}`;
}

/**
 * ⚙️5 逐字：`yuan2fen(s)` —— `/^[0-9]{1,7}(\.[0-9]{1,2})?$/` ⇒ 整数分；
 * 不匹配 ⇒ `null`（调用方按语义转 `amount_mismatch`——解析失败**不猜**）。
 * 实现用字符串拆分（不 `parseFloat`×100——浮点乘会引入 655.00000001 类截断事故）。
 */
export function yuan2fen(yuan: string): number | null {
  const m = /^([0-9]{1,7})(?:\.([0-9]{1,2}))?$/.exec(yuan);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
