/**
 * 通知通道管理化片 T1（规格 §2.1 逐字）：通知键空间四条断言 ——
 * ① 九键数组逐字（**含顺序** = 管理页显示序与拉取地图组装序，⚙️1）；② 机密集恰五
 * （`smtp.pass` + 三 URL + `dingtalkSecret`，⚙️1 按消费方切分）；③ 与 `CONFIG_KEYS`（49 键面）
 * 交集为空（D1 结构性：九键不入 CONFIG_KEYS ⇒ 不进广播快照；防将来「顺手」把通知键塞进 49 键面）；
 * ④ 与 `PAY_CHANNEL_KEYS` 交集为空（两专用键空间互斥——各自独立表与独立拉取通道）。
 * 外加 `RPC_PATTERNS.configNotifyChannelGet` 键值逐字（⚙️4；全量清单钉在 `messages.test.ts`）。
 */
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from './config';
import { PAY_CHANNEL_KEYS } from './pay-channel';
import { NOTIFY_CHANNEL_KEYS, NOTIFY_CHANNEL_SECRET_KEYS } from './notify-channel';
import { RPC_PATTERNS } from './rpc';

describe('通知通道键空间（notify-channel.ts，规格 §2.1 逐字）', () => {
  it('九键逐字且顺序固定（= 管理页显示序与拉取地图组装序，⚙️1）', () => {
    expect(NOTIFY_CHANNEL_KEYS).toEqual([
      'notify.smtp.host',
      'notify.smtp.port',
      'notify.smtp.user',
      'notify.smtp.pass',
      'notify.email.to',
      'notify.webhook.feishuUrl',
      'notify.webhook.wecomUrl',
      'notify.webhook.dingtalkUrl',
      'notify.webhook.dingtalkSecret',
    ]);
  });

  it('机密集恰五（smtp.pass + 三 URL + dingtalkSecret，⚙️1 按消费方切分）', () => {
    expect(NOTIFY_CHANNEL_SECRET_KEYS).toEqual([
      'notify.smtp.pass',
      'notify.webhook.feishuUrl',
      'notify.webhook.wecomUrl',
      'notify.webhook.dingtalkUrl',
      'notify.webhook.dingtalkSecret',
    ]);
  });

  it('与 CONFIG_KEYS 交集为空（D1 结构性：通知键不入 49 键面）', () => {
    const overlap = NOTIFY_CHANNEL_KEYS.filter((key) => (CONFIG_KEYS as readonly string[]).includes(key));
    expect(overlap).toEqual([]);
  });

  it('与 PAY_CHANNEL_KEYS 交集为空（两专用键空间互斥）', () => {
    const overlap = NOTIFY_CHANNEL_KEYS.filter((key) => (PAY_CHANNEL_KEYS as readonly string[]).includes(key));
    expect(overlap).toEqual([]);
  });

  it('RPC pattern 键值逐字：config.notifyChannel.get（⚙️4）', () => {
    expect(RPC_PATTERNS.configNotifyChannelGet).toBe('config.notifyChannel.get');
  });
});
