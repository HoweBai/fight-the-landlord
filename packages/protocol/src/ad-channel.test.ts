/**
 * 广告片 T4（规格 §2.3 逐字）：广告回调密钥键空间四条断言——
 * ① 键名单恰 1 枚且逐字（**含顺序** = 管理页显示序）；② 全键 ∈ `AD_CHANNEL_SECRET_KEYS`
 * （规格 §2.3：「`AD_CHANNEL_SECRET_KEYS` = 全键」——双向不越界）；③ 类型导出
 * （`AdChannelKey` / `ConfigAdChannelGetRequest/Response` 可编译引用；响应字段名
 * `values` 钉住）；④ 与 `CONFIG_KEYS`（49 键面）交集为空（D1 结构性：广告凭据键
 * 不入 CONFIG_KEYS ⇒ 不进广播快照；防将来「顺手」塞进 49 键面——照 pay-channel
 * 先例）。⚠️ RPC pattern（`config.adChannel.get`）归 T7 与接收侧同提交
 * （J21 闸 `robot-availability-wiring.gate.test.ts:205`）——本文件不含。
 */
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from './config';
import {
  AD_CHANNEL_KEYS,
  AD_CHANNEL_SECRET_KEYS,
  type AdChannelKey,
  type ConfigAdChannelGetRequest,
  type ConfigAdChannelGetResponse,
} from './ad-channel';

describe('广告回调密钥键空间（ad-channel.ts，规格 §2.3）', () => {
  it('键名单恰 1 枚且逐字（工作名，T0-2 回填可改名）', () => {
    expect(AD_CHANNEL_KEYS).toEqual(['ad.callbackSecret']);
  });

  it('全键 ∈ SECRET（规格 §2.3：「AD_CHANNEL_SECRET_KEYS = 全键」——双向不越界）', () => {
    const secret = new Set<string>(AD_CHANNEL_SECRET_KEYS);
    expect(AD_CHANNEL_KEYS.filter((key) => !secret.has(key))).toEqual([]);
    const keys = new Set<string>(AD_CHANNEL_KEYS);
    expect(AD_CHANNEL_SECRET_KEYS.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('与 CONFIG_KEYS 交集为空（D1 结构性：广告凭据键不入 49 键面）', () => {
    const overlap = AD_CHANNEL_KEYS.filter((key) => (CONFIG_KEYS as readonly string[]).includes(key));
    expect(overlap).toEqual([]);
  });

  it('类型导出（编译期）：AdChannelKey / Request / Response 可引用，响应字段名 values', () => {
    const key: AdChannelKey = 'ad.callbackSecret';
    const req: ConfigAdChannelGetRequest = { pullToken: 'tok-1', meta: { traceId: 'trace-1' } };
    const res: ConfigAdChannelGetResponse = { values: { 'ad.callbackSecret': 'secret-v1' } };
    expect(req.pullToken).toBe('tok-1');
    expect(req.meta?.traceId).toBe('trace-1');
    expect(res.values[key]).toBe('secret-v1');
  });
});
