import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, RelayConfigError, dingtalkHalfConfigured, loadConfig, sinksFromValues } from '../src/config';
import type { NotifyValues } from '../src/config';
import { configuredSinkNames } from '../src/sinks';

/**
 * T12 单测半边之三（原 C8 env 装配用例的三态改写，§5.3#1/#2）：
 *
 *  - **env 装配退役**：四 IM 键不再读取 —— 权威值 = `config.notifyChannel.get` 拉取图；
 *    `loadConfig` 只剩 `PORT`（§3.3「PORT env 保留」；`RelayConfigError` **保留给 PORT**）。
 *  - **钉钉半配拒起退役 → 停用 + WARN**：原「半配 ⇒ 拒启动」三态改为「不抛 + 派生面停用」
 *    （派生矩阵的完整面在 `sinks-from-values.test.ts`；这里钉「旧三态在新语义下的落点」）。
 */

/** 半配哨兵：警告/错误都不许回声值（值即凭据，S2③）。 */
const URL_SENTINEL = 'http://sentinel.example/SENTINEL-URL-VALUE';
const SECRET_SENTINEL = 'SENTINEL-SECRET-VALUE';

describe('loadConfig：只剩 PORT（空串/空白 = 未设 ⇒ 默认；非法 ⇒ 拒启动）', () => {
  it('空 env ⇒ 默认端口 8090；PORT 可覆写；空串/空白 = 未设 ⇒ 默认', () => {
    expect(loadConfig({})).toEqual({ port: DEFAULT_PORT });
    expect(loadConfig({ PORT: '9000' }).port).toBe(9000);
    expect(loadConfig({ PORT: '' }).port).toBe(DEFAULT_PORT);
    expect(loadConfig({ PORT: '  ' }).port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(8090); // 规格钉死
  });

  it.each(['abc', '0', '65536', '-1', '80.5'])('非法 PORT=%j ⇒ 拒启动（RelayConfigError —— 保留给 PORT）', (value) => {
    expect(() => loadConfig({ PORT: value })).toThrow(RelayConfigError);
  });
});

describe('env 面退役：四 IM 键不再读取（§5.3#1），返回值不含 sinks 字段', () => {
  it('旧四键（含飞书/企微/钉钉全配）出现在 env 里 ⇒ 照常只返回 {port}（不读、不派生）', () => {
    const env = {
      PORT: '9000',
      FEISHU_WEBHOOK_URL: URL_SENTINEL,
      WECOM_WEBHOOK_URL: URL_SENTINEL,
      DINGTALK_WEBHOOK_URL: URL_SENTINEL,
      DINGTALK_SECRET: SECRET_SENTINEL,
    };
    const cfg = loadConfig(env);
    expect(cfg).toEqual({ port: 9000 });
    expect(Object.keys(cfg)).toEqual(['port']); // 无 sinks 字段（权威值已迁拉取图）
  });
});

describe('钉钉半配三态：拒起 → 停用 + 半配判定（原 config.test.ts 三用例改写）', () => {
  it.each([
    ['只有 URL（缺 SECRET）', { 'notify.webhook.dingtalkUrl': URL_SENTINEL }],
    ['只有 SECRET（缺 URL）', { 'notify.webhook.dingtalkSecret': SECRET_SENTINEL }],
    ['URL 在场而 SECRET 为空串（空串=未设 ⇒ 仍是半配）', { 'notify.webhook.dingtalkUrl': URL_SENTINEL, 'notify.webhook.dingtalkSecret': '' }],
    ['URL 空串而 SECRET 在场', { 'notify.webhook.dingtalkUrl': '', 'notify.webhook.dingtalkSecret': SECRET_SENTINEL }],
  ] as Array<[string, NotifyValues]>)('%s ⇒ 不再拒起（loadConfig 不抛）；派生面该槽停用 + half 为真', (_name, values) => {
    // ① 拒起退役：旧 env 形态（含半配）不再让进程起不来。
    expect(() => loadConfig({ DINGTALK_WEBHOOK_URL: URL_SENTINEL })).not.toThrow();
    expect(() => loadConfig({ DINGTALK_SECRET: SECRET_SENTINEL })).not.toThrow();

    // ② 新语义落在派生面：钉钉槽停用（不带着必败的槽位出站），半配标志供 WARN。
    expect(sinksFromValues(values).dingtalk).toBeUndefined();
    expect(configuredSinkNames(sinksFromValues(values))).toEqual([]);
    expect(dingtalkHalfConfigured(values)).toBe(true);
  });

  it('成对在场 ⇒ 启用（对照：半配判定不是「钉钉永久停用」）', () => {
    const values: NotifyValues = {
      'notify.webhook.dingtalkUrl': URL_SENTINEL,
      'notify.webhook.dingtalkSecret': SECRET_SENTINEL,
    };
    expect(configuredSinkNames(sinksFromValues(values))).toEqual(['dingtalk']);
    expect(dingtalkHalfConfigured(values)).toBe(false);
  });
});
