/**
 * 支付片 T6：RSA2 签名/验签（⚙️6 两口径 + 出站签名；**`node:crypto` 自实现、零新依赖**）。
 *
 * 密钥材料在本模块**只作为入参**流动（私钥/公钥 PEM 由 `client.ts` 每次调用从 env 解码后传入）
 * ——「密钥不进日志/不出响应」的机械层在 `shared` 的 `redact.ts`（PEM 形态），
 * 纪律层在 `client.ts`（不打参数全量日志）。
 *
 * 三个出口与 `params.ts` 的三个"签名输入"一一对应：
 *  - `signRequest`    = 出站请求签名（应用私钥；RSA-SHA256；base64）
 *  - `verifyNotify`   = 异步通知验签（支付宝公钥；⚙️6①）
 *  - `verifyResponse` = OpenAPI 同步响应验签（支付宝公钥；⚙️6② 原文子串）
 *
 * 失败语义（与调用方约定）：
 *  - `verifyNotify/verifyResponse` **返回 boolean、不抛**：一切"不可验"（缺 sign、
 *    节点缺失、非 JSON）都归 `false` —— 对调用方而言与坏签名**同义**（不可信 ⇒ 拒）；
 *  - 密钥本身非法（不是 PEM）时 `crypto.verify` 会抛 —— 那是**配置错误**，由 `client.ts`
 *    的配置读取面拦成 15001（本层不吞不装）。
 */
import { createSign, createVerify } from 'node:crypto';
import { buildNotifySignSource, buildRequestSignSource, extractResponseSignSource } from './params';
import type { RawParams } from './params';

/** ⚙️6 出站签名：全参数 + `sign_type=RSA2` 同序 ⇒ 应用私钥 RSA-SHA256 ⇒ `sign`（base64）。 */
export function signRequest(params: RawParams, privateKeyPem: string): string {
  return createSign('RSA-SHA256').update(buildRequestSignSource(params), 'utf8').sign(privateKeyPem, 'base64');
}

/**
 * ⚙️6① 通知验签：`params` 传**全量通知参数**（含 `sign`；`sign`/`sign_type` 由规范化排除）。
 * 值必须是 form 解码后的原文（本层不做解码/编码）。
 */
export function verifyNotify(params: RawParams, publicKeyPem: string): boolean {
  const sign = params.sign;
  if (typeof sign !== 'string' || sign.length === 0) return false;
  try {
    return createVerify('RSA-SHA256')
      .update(buildNotifySignSource(params), 'utf8')
      .verify(publicKeyPem, Buffer.from(sign, 'base64'));
  } catch {
    return false; // 坏 base64 等形状问题一律"不可验"（不抛）
  }
}

/**
 * ⚙️6② 同步响应验签：对响应体中 `<api>_response` 值的**原文子串**字节验签
 * （`sign` = 响应顶层字段）。`apiName` 传网关方法名（如 `'alipay.trade.query'`）。
 */
export function verifyResponse(apiName: string, rawBody: string, publicKeyPem: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false; // 非 JSON（反代错误页等）⇒ 不可信
  }
  const sign = (parsed as { sign?: unknown } | null)?.sign;
  if (typeof sign !== 'string' || sign.length === 0) return false;
  const source = extractResponseSignSource(rawBody, apiName);
  if (source === null) return false;
  try {
    return createVerify('RSA-SHA256')
      .update(source, 'utf8')
      .verify(publicKeyPem, Buffer.from(sign, 'base64'));
  } catch {
    return false;
  }
}
