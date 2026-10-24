import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { PayChannelKey } from '@fight-the-landlord/protocol';

/**
 * 支付渠道六键的校验/规范化（规格 §2.3「规范化（canonical）」+ §2.4 校验矩阵表**逐字**；⚙️6/⚙️7）。
 *
 * 统一前置（§2.4 表注）：全键先 `trim()`；空串 ⇒ 拒（400）。逐键规则（§2.4 表）：
 *  - `gatewayUrl` / `publicBaseUrl`：`new URL()` 可解析且 protocol ∈ {`http:`,`https:`}；
 *    canonical = **去尾斜杠后的原文**（`replace(/\/+$/, '')`——与读侧今日 `orders.service.ts:484`
 *    对 `PAY_PUBLIC_BASE_URL` 的剥法逐字同规，语义搬运不等价面为零）；去尾斜杠后不得为空；canonical ≤512。
 *  - `appId` / `sellerId`：`^[0-9]{8,32}$`；canonical = 原文（纯数字，上限 32 含在正则内）。
 *  - `privateKey` / `publicKey`：接受 **PEM 原文**（含 `-----BEGIN` 即判定，§2.3 逐字）或
 *    **base64(PEM)** 两态；归一后须可被 `crypto.createPrivateKey` / `createPublicKey` **实际解析**
 *    （坏 ⇒ 400）；canonical = `base64(pem.trim() + '\n')`（尾换行归一；读侧 `decodePem` 消费形态
 *    不变——仍是 base64(PEM)）；canonical ≤8192。
 *
 * ⚠️ **理由文案不含输入值**（§2.9 纪律）：`reason` 只讲「哪里不合规」（可含键名标签/格式/上限数字），
 * 绝不内嵌 `raw` 的任何片段——400 message 会原样回显到管理页/日志，值可能含密钥材料。
 *
 * 返回联合类型 = §1.1 逐字：`{ok:true, canonical} | {ok:false, reason}`。
 */

export type PayChannelValidation = { ok: true; canonical: string } | { ok: false; reason: string };

/** §2.4 上限列：URL 两键 ≤512（canonical）。 */
const URL_MAX_LEN = 512;
/** §2.4 上限列：密钥两键 ≤8192（canonical，= base64 形态的字符数）。 */
const KEY_MAX_LEN = 8192;
/** §2.4：appId/sellerId = 8–32 位纯数字（上限 32 由正则自含）。 */
const PID_PATTERN = /^[0-9]{8,32}$/;

/* ⚠️ 下列 reason 模板全部为**常量**：不含 raw 的任何片段（§2.9）。 */
const URL_REASON = '必须是 http/https 协议的合法 URL';
const URL_LEN_REASON = `长度超过上限 ${URL_MAX_LEN}`;
const PID_REASON = '必须是 8-32 位数字';
const KEY_REASON = '密钥材料必须是可解析的 PEM（PEM 原文或 base64(PEM)）';
const KEY_LEN_REASON = `规范化后长度超过上限 ${KEY_MAX_LEN}`;
const EMPTY_REASON = '值不得为空';

function reject(reason: string): PayChannelValidation {
  return { ok: false, reason };
}

/** URL 两键共规（§2.3/§2.4）：可解析 + http(s) + 去尾斜杠 + 非空 + ≤512。 */
function validateUrl(trimmed: string): PayChannelValidation {
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return reject(URL_REASON);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reject(URL_REASON);
  const canonical = trimmed.replace(/\/+$/, '');
  if (canonical.length === 0) return reject(URL_REASON); // §2.4：去尾斜杠后非空
  if (canonical.length > URL_MAX_LEN) return reject(URL_LEN_REASON);
  return { ok: true, canonical };
}

/** appId/sellerId 共规（§2.4）：8–32 位纯数字；canonical = 原文。 */
function validatePid(trimmed: string): PayChannelValidation {
  if (!PID_PATTERN.test(trimmed)) return reject(PID_REASON);
  return { ok: true, canonical: trimmed };
}

/** 密钥两键共规（§2.3 逐字）：**三种输入形态**（2026-10-07 补第三态）⇒ 解析 ⇒ canonical = base64(trimmedPem+'\n')。
 *
 *  ① PEM 原文（含 `-----BEGIN`）；② base64(PEM)；③ **裸 base64(DER)**——支付宝控制台「复制」
 *  按钮直出的形态（只有 base64 字母表、无头尾，解码出来是二进制 DER；原实现会误拒，用户照后台复制必踩）。
 *  ③ 的规范化 = 按标准头尾重新包壳（公钥先 SPKI 再 PKCS#1；私钥先 PKCS#8 再 PKCS#1），
 *  解析校验仍由 createPrivateKey/createPublicKey 实际执行 ⇒ 烂串照旧 fail-closed。
 */
function validateKeyMaterial(trimmed: string, kind: 'PRIVATE' | 'PUBLIC'): PayChannelValidation {
  for (const candidate of pemCandidates(trimmed, kind)) {
    const normalized = candidate.trim() + '\n';
    try {
      // 解析的是**归一后**形态（= 将要落库的 canonical 还原形态）：验证与存储同一物
      if (kind === 'PRIVATE') createPrivateKey(normalized);
      else createPublicKey(normalized);
    } catch {
      continue; // 换下一候选（三态有序；全败 ⇒ KEY_REASON）
    }
    const canonical = Buffer.from(normalized, 'utf8').toString('base64');
    if (canonical.length > KEY_MAX_LEN) return reject(KEY_LEN_REASON);
    return { ok: true, canonical };
  }
  return reject(KEY_REASON);
}

/** 输入 → 候选 PEM 列表（有序；只含可能成立的包裹形态，校验仍由调用侧实解析兜底）。 */
function pemCandidates(trimmed: string, kind: 'PRIVATE' | 'PUBLIC'): string[] {
  if (trimmed.includes('-----BEGIN')) return [trimmed];
  const decodedUtf8 = Buffer.from(trimmed, 'base64').toString('utf8');
  if (decodedUtf8.includes('-----BEGIN')) return [decodedUtf8]; // ② base64(PEM)
  // ③ 裸 base64(DER)：剥空白后按标准头尾包壳（64 字符折行），两种头序备选
  const b64 = trimmed.replace(/\s+/g, '');
  const body = (b64.match(/.{1,64}/g) ?? []).join('\n');
  const headers = kind === 'PUBLIC' ? ['PUBLIC KEY', 'RSA PUBLIC KEY'] : ['PRIVATE KEY', 'RSA PRIVATE KEY'];
  return headers.map((h) => `-----BEGIN ${h}-----\n${body}\n-----END ${h}-----\n`);
}

/**
 * 六键校验/规范化入口（§1.1 接口逐字）。**纯函数、不触库**（400 先于一切库操作，§3.1/C5 纪律）。
 */
export function validateAndNormalize(key: PayChannelKey, raw: string): PayChannelValidation {
  if (typeof raw !== 'string') return reject('值必须是字符串');
  const trimmed = raw.trim(); // 全键先 trim（§2.4）
  if (trimmed.length === 0) return reject(EMPTY_REASON);

  switch (key) {
    case 'pay.channel.gatewayUrl':
    case 'pay.channel.publicBaseUrl':
      return validateUrl(trimmed);
    case 'pay.channel.appId':
    case 'pay.channel.sellerId':
      return validatePid(trimmed);
    case 'pay.channel.privateKey':
      return validateKeyMaterial(trimmed, 'PRIVATE');
    case 'pay.channel.publicKey':
      return validateKeyMaterial(trimmed, 'PUBLIC');
    default:
      // 类型上不可达（PayChannelKey 为六字面量并集）；未知键 400 的白名单在 controller 注册表（T5）
      return reject('未知键');
  }
}
