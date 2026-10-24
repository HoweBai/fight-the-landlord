import { describe, expect, it } from 'vitest';
import { buildDingtalkUrl, dingtalkSign } from '../src/sinks';

/**
 * C8 单测半边：**钉钉加签对照向量**（规格 §2.6「三 sink」· Y12）。
 *
 * ## 为什么这些期望值是**硬编码的字面量**
 *
 * 「不得用测试自身现算的时间戳自证」：如果测试用被测实现 `dingtalkSign(secret, Date.now())
 * === sign` 去比，**单位错（秒 vs 毫秒）也照样绿** —— 4096 之外的差异全被自洽吃掉。
 * 向量必须外部独立算出、以固定值写死：
 *
 * ```
 * printf '%s' "$TS\n$SECRET" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64
 * ```
 * （上式对三条向量逐条实跑过；并与 `node -e` 的 `createHmac` 相互对账一致。）
 *
 * ## 单位纪律（Y12）
 *
 * 钉钉要求 **毫秒** 时间戳；秒级会被平台以 `310000` **静默拒收**（HTTP 200 + errcode）
 * —— 本包按状态码判定成败 ⇒ 秒级单位写错在本仓**内部无人看得见**，只有这条向量拦得住。
 * 下方「秒级负对照」把两个 sign 的差异也钉死：万一有人把 `/1000` 加回去，断言当场红。
 */

/** 向量 1：钉钉官方文档样例同款参数（secret 出自官方加签说明的示例串）。 */
const V1 = {
  secret: 'SEC5b17d83d0e2627c5f6aac34d78912ab2a91221f307dbe0bab7c7a268cec8c916',
  timestampMs: 1579659829250,
  sign: 'Exy6a4GAAJ7WliaOkGZ14WzlEeuWP7npnn+DvqtkbxI=',
  signEncoded: 'Exy6a4GAAJ7WliaOkGZ14WzlEeuWP7npnn%2BDvqtkbxI%3D',
} as const;

/** 向量 2：签名字符全在 base64 常规区（只含 `=` 一处需转义）。 */
const V2 = {
  secret: 'alertrelay-sign-test-secret',
  timestampMs: 1700000000000,
  sign: 'EgI6kwYCFa0DnOIX2A7JzC6AXliAUpipo31dsz4ebfY=',
  signEncoded: 'EgI6kwYCFa0DnOIX2A7JzC6AXliAUpipo31dsz4ebfY%3D',
} as const;

/** 向量 3：签名以 `/` 开头（`%2F` 路径，防「只转义 `=` 忘了 `/`」的实现）。 */
const V3 = {
  secret: 'ftl-dingtalk-secret-demo',
  timestampMs: 1760000000123,
  sign: '/ybMPgdwnDcHGNLQFEnWqgHT6XHyF1tr4eQIRj2zzos=',
  signEncoded: '%2FybMPgdwnDcHGNLQFEnWqgHT6XHyF1tr4eQIRj2zzos%3D',
} as const;

/** 向量 1 的**秒级**变体（负对照；同样独立算出）。 */
const V1_SECONDS_VARIANT_SIGN = 'Cgiz9eLyhzk6Dlm+YMjYlfrtooIqUprUr17/gyIBQtY=';

describe('dingtalkSign：对照向量取固定值（C8 · 时钟注入的外部对账）', () => {
  it.each([V1, V2, V3])('sign(ts=$timestampMs) 与外部独立算出的向量逐字一致', ({ secret, timestampMs, sign }) => {
    expect(dingtalkSign(secret, timestampMs)).toBe(sign);
  });

  it('负对照：秒级时间戳的 sign ≠ 毫秒级（单位写错必被向量抓出）', () => {
    expect(dingtalkSign(V1.secret, 1579659829)).toBe(V1_SECONDS_VARIANT_SIGN);
    expect(dingtalkSign(V1.secret, 1579659829)).not.toBe(V1.sign);
  });

  it('timestamp 必须**毫秒**出现在 URL 上（13 位），且 sign 已 percent-encode', () => {
    const url = buildDingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=tk', V1.secret, V1.timestampMs);
    expect(url).toBe(
      `https://oapi.dingtalk.com/robot/send?access_token=tk&timestamp=${V1.timestampMs}&sign=${V1.signEncoded}`,
    );
    // 单位判据从 URL 本身读回（不是从参数对象读回）：秒级截断在这里当场现形。
    expect(url.match(/timestamp=(\d+)/)![1]).toBe('1579659829250');
  });
});

describe('buildDingtalkUrl：query 拼接与转义', () => {
  it('URL 已带 query ⇒ 用 & 追加（webhook URL 必带 access_token=）', () => {
    const url = buildDingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=tk', V2.secret, V2.timestampMs);
    expect(url).toBe(
      `https://oapi.dingtalk.com/robot/send?access_token=tk&timestamp=${V2.timestampMs}&sign=${V2.signEncoded}`,
    );
  });

  it('URL 无 query ⇒ 用 ? 起头（不产生 `/send?&timestamp` 这种畸形）', () => {
    const url = buildDingtalkUrl('https://oapi.dingtalk.com/robot/send', V2.secret, V2.timestampMs);
    expect(url).toBe(
      `https://oapi.dingtalk.com/robot/send?timestamp=${V2.timestampMs}&sign=${V2.signEncoded}`,
    );
  });

  it('sign 值里不得残留裸 `+`/`/`/`=`（base64 未转义 ⇒ 钉钉 310000「sign 不匹配」）', () => {
    const url = buildDingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=tk', V3.secret, V3.timestampMs);
    expect(url).toBe(
      `https://oapi.dingtalk.com/robot/send?access_token=tk&timestamp=${V3.timestampMs}&sign=${V3.signEncoded}`,
    );
    const rawSign = url.slice(url.indexOf('sign=') + 'sign='.length);
    expect(rawSign).not.toMatch(/[+/=]/);
  });
});
