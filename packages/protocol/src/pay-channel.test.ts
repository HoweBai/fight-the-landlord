/**
 * 支付配置管理化片 T1（规格 §2.1 逐字）：渠道键空间三条断言——
 * ① 六键数组逐字（**含顺序** = 管理页显示序，⚙️1）；② 机密集恰 `['pay.channel.privateKey']`（v1 唯一）；
 * ③ 与 `CONFIG_KEYS`（49 键面）交集为空（D1 结构性：六键不入 CONFIG_KEYS ⇒ 不进广播快照；
 * 防将来「顺手」把渠道键塞进 49 键面）。
 */
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from './config';
import { PAY_CHANNEL_KEYS, PAY_CHANNEL_SECRET_KEYS } from './pay-channel';

describe('支付渠道键空间（pay-channel.ts，规格 §2.1 逐字）', () => {
  it('六键逐字且顺序固定（= 管理页显示序，⚙️1）', () => {
    expect(PAY_CHANNEL_KEYS).toEqual([
      'pay.channel.gatewayUrl',
      'pay.channel.appId',
      'pay.channel.privateKey',
      'pay.channel.publicKey',
      'pay.channel.sellerId',
      'pay.channel.publicBaseUrl',
    ]);
  });

  it('机密集恰 [pay.channel.privateKey]（v1 唯一）', () => {
    expect(PAY_CHANNEL_SECRET_KEYS).toEqual(['pay.channel.privateKey']);
  });

  it('与 CONFIG_KEYS 交集为空（D1 结构性：渠道键不入 49 键面）', () => {
    const overlap = PAY_CHANNEL_KEYS.filter((key) => (CONFIG_KEYS as readonly string[]).includes(key));
    expect(overlap).toEqual([]);
  });
});
