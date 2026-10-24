import { describe, expect, it } from 'vitest';
import { dingtalkHalfConfigured, sinksFromValues } from '../src/config';
import type { NotifyValues } from '../src/config';
import { configuredSinkNames } from '../src/sinks';

/**
 * T12 单测半边之二：**槽位派生纯函数**（规格 §3.3 逐字 —— 拉取图 ⇒ 槽位配置）。
 *
 *  - 四键各自在场 ⇒ 对应槽位；槽位顺序 feishu→dingtalk→wecom（扇出/日志同此序）；
 *  - 钉钉 URL/SECRET **成对**才启用：半配 ⇒ 该槽停用（`dingtalkHalfConfigured` 为真，
 *    供 server 侧「状态变化时一条」WARN）——取代旧「半配拒启动」（设计 D7）；
 *  - 空串/空白 = 未设（全仓口径）；`{}`（成功空图）⇒ 零槽（= 今天「明确未配」）。
 */

const FEISHU = 'http://127.0.0.1:9/feishu';
const WECOM = 'http://127.0.0.1:9/wecom';
const DINGTALK = 'http://127.0.0.1:9/dingtalk?access_token=tk';
const DINGTALK_SECRET = 'dt-secret-sentinel';

const FULL: NotifyValues = {
  'notify.webhook.feishuUrl': FEISHU,
  'notify.webhook.wecomUrl': WECOM,
  'notify.webhook.dingtalkUrl': DINGTALK,
  'notify.webhook.dingtalkSecret': DINGTALK_SECRET,
};

describe('sinksFromValues：槽位矩阵（§3.3）', () => {
  it('全配（含 SMTP 五键的九键图）⇒ 三槽俱启；顺序 feishu→dingtalk→wecom；值逐字（含 query）', () => {
    const nine: NotifyValues = {
      'notify.smtp.host': 'smtp.invalid',
      'notify.smtp.port': '465',
      'notify.smtp.user': 'probe@example.invalid',
      'notify.smtp.pass': 'probe-pass',
      'notify.email.to': 'probe@example.invalid',
      ...FULL,
    };
    const sinks = sinksFromValues(nine);
    expect(sinks.feishu).toEqual({ url: FEISHU });
    expect(sinks.wecom).toEqual({ url: WECOM });
    expect(sinks.dingtalk).toEqual({ url: DINGTALK, secret: DINGTALK_SECRET });
    expect(configuredSinkNames(sinks)).toEqual(['feishu', 'dingtalk', 'wecom']);
    expect(dingtalkHalfConfigured(nine)).toBe(false);
  });

  it('只 feishu ⇒ 只启 feishu（其余键缺席）', () => {
    const sinks = sinksFromValues({ 'notify.webhook.feishuUrl': FEISHU });
    expect(configuredSinkNames(sinks)).toEqual(['feishu']);
    expect(dingtalkHalfConfigured({ 'notify.webhook.feishuUrl': FEISHU })).toBe(false);
  });

  it('只 wecom ⇒ 只启 wecom', () => {
    const sinks = sinksFromValues({ 'notify.webhook.wecomUrl': WECOM });
    expect(configuredSinkNames(sinks)).toEqual(['wecom']);
  });

  it('只 dingtalk 全配 ⇒ 只启 dingtalk（url 逐字含 query + secret）', () => {
    const sinks = sinksFromValues({
      'notify.webhook.dingtalkUrl': DINGTALK,
      'notify.webhook.dingtalkSecret': DINGTALK_SECRET,
    });
    expect(configuredSinkNames(sinks)).toEqual(['dingtalk']);
    expect(sinks.dingtalk).toEqual({ url: DINGTALK, secret: DINGTALK_SECRET });
  });

  it('钉钉半配（只有 URL）⇒ 该槽停用 + half=true；其余槽不受影响', () => {
    const values: NotifyValues = { 'notify.webhook.feishuUrl': FEISHU, 'notify.webhook.dingtalkUrl': DINGTALK };
    const sinks = sinksFromValues(values);
    expect(configuredSinkNames(sinks)).toEqual(['feishu']); // dingtalk 不在
    expect(dingtalkHalfConfigured(values)).toBe(true);
  });

  it('钉钉半配（只有 SECRET）⇒ 该槽停用 + half=true', () => {
    const values: NotifyValues = { 'notify.webhook.dingtalkSecret': DINGTALK_SECRET };
    expect(configuredSinkNames(sinksFromValues(values))).toEqual([]);
    expect(dingtalkHalfConfigured(values)).toBe(true);
  });

  it('空图 ⇒ 零槽 + half=false（成功空图 = 今天「明确未配」语义）', () => {
    expect(sinksFromValues({})).toEqual({});
    expect(configuredSinkNames(sinksFromValues({}))).toEqual([]);
    expect(dingtalkHalfConfigured({})).toBe(false);
  });

  it('空串/空白值 = 未设（在场判定同口径）：空串 URL 不算配；空串 SECRET 仍算半配', () => {
    const empties: NotifyValues = {
      'notify.webhook.feishuUrl': '',
      'notify.webhook.wecomUrl': '   ',
    };
    expect(sinksFromValues(empties)).toEqual({});
    expect(dingtalkHalfConfigured(empties)).toBe(false);

    const urlWithEmptySecret: NotifyValues = { 'notify.webhook.dingtalkUrl': DINGTALK, 'notify.webhook.dingtalkSecret': '' };
    expect(sinksFromValues(urlWithEmptySecret).dingtalk).toBeUndefined();
    expect(dingtalkHalfConfigured(urlWithEmptySecret)).toBe(true);
  });

  it('SMTP 五键不产生任何槽位（两消费面不相交，⚙️1）', () => {
    const smtpOnly: NotifyValues = {
      'notify.smtp.host': 'smtp.invalid',
      'notify.smtp.port': '465',
      'notify.smtp.user': 'probe@example.invalid',
      'notify.smtp.pass': 'probe-pass',
      'notify.email.to': 'probe@example.invalid',
    };
    expect(sinksFromValues(smtpOnly)).toEqual({});
    expect(dingtalkHalfConfigured(smtpOnly)).toBe(false);
  });

  it('类型外的未知键忽略（防御性）', () => {
    const weird = { 'notify.unknown.key': 'x' } as unknown as NotifyValues;
    expect(sinksFromValues(weird)).toEqual({});
  });
});
