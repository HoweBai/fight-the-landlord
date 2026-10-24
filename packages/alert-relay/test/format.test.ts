import { describe, expect, it } from 'vitest';
import { formatAlert, humanDuration } from '../src/format';
import type { AlertmanagerWebhookPayload } from '../src/format';

/**
 * C8 单测半边：**文案层**（规格 §2.6「文案」段）。
 *
 * 判据要点（负对照/敏感性）：
 *  - golden：标题 `[severity] alertname`；正文逐 alert 一行，**逐字**钉住；
 *  - 「无用户数据、无 URL」是**不变量**：`generatorURL`/`externalURL`/`runbook_url`
 *    与注释文本里的链接都不得出现在产物里；
 *  - 容错：缺 summary / 缺 annotations / 缺 alerts / 时间非法 —— 都不许抛；
 *  - 时间与持续**全由注入的 `nowMs` 决定**（golden 不看墙上时钟）。
 */

/** 固定时钟：2026-10-03T04:05:00Z（`Date.parse` 对同值的跨平台确定性 = RFC3339 解析）。 */
const NOW = Date.parse('2026-10-03T04:05:00Z');

/** Alertmanager v0.34 webhook v4 形状的合成载荷（golden fixture；真栈 dump 由 T12 回填）。 */
function fixture(over: Partial<AlertmanagerWebhookPayload> = {}): AlertmanagerWebhookPayload {
  return {
    version: '4',
    groupKey: '{}/{alertname="ServiceDown"}:{job="api-gateway"}',
    truncatedAlerts: 0,
    status: 'firing',
    receiver: 'all',
    groupLabels: { alertname: 'ServiceDown', job: 'api-gateway' },
    commonLabels: { alertname: 'ServiceDown', severity: 'critical', job: 'api-gateway' },
    commonAnnotations: { summary: 'api-gateway 抓不到了' },
    externalURL: 'http://alertmanager:9093',
    alerts: [
      {
        status: 'firing',
        labels: {
          alertname: 'ServiceDown',
          severity: 'critical',
          job: 'api-gateway',
          instance: 'api-gateway:9000',
        },
        annotations: { summary: 'api-gateway 抓不到了', runbook: '先看容器 docker ps，再追 traceId' },
        startsAt: '2026-10-03T04:00:00Z',
        endsAt: '0001-01-01T00:00:00Z', // firing 的零值 endsAt（AM 实测形态）——不得被当成结束时间
        generatorURL: 'http://prometheus:9090/graph?g0.expr=up',
        fingerprint: 'aa11bb22',
      },
    ],
    ...over,
  };
}

describe('formatAlert（C8：文案 golden + 无 URL 不变量 + 容错）', () => {
  it('单 alert golden：标题 [severity] alertname；正文字段序 = job/实例 · 摘要 · 开始 · 持续', () => {
    const msg = formatAlert(fixture(), NOW);
    expect(msg.title).toBe('[critical] ServiceDown');
    expect(msg.body).toBe(
      '- api-gateway/api-gateway:9000 · api-gateway 抓不到了 · 开始 2026-10-03 04:00 UTC · 持续 5m',
    );
    // 无 URL 不变量：把「恰好没写」变成机械判据（generatorURL/externalURL 都在 fixture 里）
    expect(msg.title + msg.body).not.toMatch(/https?:\/\//);
  });

  it('多 alert：逐行按序；resolved 用 endsAt−startsAt 算持续；无 summary 时回落首条非 URL annotation', () => {
    const msg = formatAlert(
      fixture({
        alerts: [
          fixture().alerts![0],
          {
            status: 'resolved',
            labels: { alertname: 'ServiceDown', severity: 'critical', job: 'room-service', instance: 'room-service:9002' },
            annotations: { note: '房间服务 3 分钟无响应' },
            startsAt: '2026-10-03T03:00:00Z',
            endsAt: '2026-10-03T03:30:00Z',
          },
        ],
      }),
      NOW,
    );
    expect(msg.body).toBe(
      [
        '- api-gateway/api-gateway:9000 · api-gateway 抓不到了 · 开始 2026-10-03 04:00 UTC · 持续 5m',
        '- room-service/room-service:9002 · 房间服务 3 分钟无响应 · 开始 2026-10-03 03:00 UTC · 持续 30m',
      ].join('\n'),
    );
  });

  it('summary 为空串 ⇒ 回落首条 annotation；`*_url` 键被跳过（URL 即凭据，不许进文案）', () => {
    const msg = formatAlert(
      fixture({
        alerts: [
          {
            labels: { job: 'room-service', instance: 'room-service:9002' },
            annotations: { summary: '', runbook_url: 'http://runbooks/ftl/service-down', note: '先看 docker ps' },
            startsAt: '2026-10-03T04:00:00Z',
          },
        ],
      }),
      NOW,
    );
    expect(msg.body).toBe('- room-service/room-service:9002 · 先看 docker ps · 开始 2026-10-03 04:00 UTC · 持续 5m');
    expect(msg.body).not.toContain('runbooks');
  });

  it('摘要文本里的链接被替换（「文案无 URL」的不变量，不靠调用方自觉）', () => {
    const msg = formatAlert(
      fixture({
        alerts: [
          {
            labels: { job: 'user-service', instance: 'user-service:9001' },
            annotations: { summary: '见 http://wiki/ftl/user-service 的处置' },
            startsAt: '2026-10-03T04:00:00Z',
          },
        ],
      }),
      NOW,
    );
    expect(msg.body).toBe(
      '- user-service/user-service:9001 · 见 （链接已省略） 的处置 · 开始 2026-10-03 04:00 UTC · 持续 5m',
    );
  });

  it('无 annotations ⇒ 摘要段整体省略（行仍合法）', () => {
    const msg = formatAlert(
      fixture({
        alerts: [{ labels: { job: 'game-service', instance: 'game-service:9003' }, startsAt: '2026-10-03T04:00:00Z' }],
      }),
      NOW,
    );
    expect(msg.body).toBe('- game-service/game-service:9003 · 开始 2026-10-03 04:00 UTC · 持续 5m');
  });

  it('alerts 缺失/为空 ⇒ 明示「无明细」（不抛、不留半截文案）', () => {
    for (const alerts of [[], undefined]) {
      const msg = formatAlert(fixture({ alerts }), NOW);
      expect(msg.title).toBe('[critical] ServiceDown'); // 标题照样从 commonLabels 来
      expect(msg.body).toBe('- （无 alert 明细）');
    }
  });

  it('标题回落链：commonLabels 缺 ⇒ 首 alert 的 labels；两者都缺 ⇒ [unknown] unknown', () => {
    const fromAlert = formatAlert(
      fixture({
        commonLabels: {},
        alerts: [{ labels: { severity: 'warning', alertname: 'HostDiskSpaceLow' }, startsAt: '2026-10-03T04:00:00Z' }],
      }),
      NOW,
    );
    expect(fromAlert.title).toBe('[warning] HostDiskSpaceLow');

    const unknown = formatAlert({ alerts: [] }, NOW);
    expect(unknown.title).toBe('[unknown] unknown');
  });

  it('特殊字符：引号原样、换行/制表折叠为单个空格（正文行结构不被值破坏）', () => {
    const msg = formatAlert(
      fixture({
        alerts: [
          {
            labels: { job: 'game\n"service"', instance: 'x\ty' },
            annotations: { summary: '磁盘  快满\n了' },
            startsAt: '2026-10-03T04:00:00Z',
          },
        ],
      }),
      NOW,
    );
    expect(msg.body).toBe('- game "service"/x y · 磁盘 快满 了 · 开始 2026-10-03 04:00 UTC · 持续 5m');
    expect(msg.body.split('\n')).toHaveLength(1); // 单 alert ⇒ 正文恰一行（值里的换行没有破坏行结构）
  });

  it('时间容错：startsAt 不可解析 ⇒ 开始/持续都是「未知」（不抛）', () => {
    const msg = formatAlert(
      fixture({ alerts: [{ labels: { job: 'x' }, startsAt: 'not-a-time' }] }),
      NOW,
    );
    expect(msg.body).toBe('- x · 开始 未知 · 持续 未知');
  });

  it('未来 startsAt（时钟回拨/快照）⇒ 持续钳到 0s，不许出现负值', () => {
    const msg = formatAlert(
      fixture({ alerts: [{ labels: { job: 'x' }, startsAt: '2026-10-03T04:06:00Z' }] }),
      NOW,
    );
    expect(msg.body).toBe('- x · 开始 2026-10-03 04:06 UTC · 持续 0s');
  });
});

describe('humanDuration（持续时长的唯一渲染口径）', () => {
  it.each([
    [0, '0s'],
    [45_000, '45s'],
    [75_000, '1m15s'],
    [300_000, '5m'],
    [3_600_000, '1h'],
    [3_660_000, '1h1m'],
    [90_000_000, '1d1h'],
    [172_800_000, '2d'],
    [-5_000, '0s'], // 负值钳零（调用侧也会钳，双保险）
  ])('%ims ⇒ %s', (ms, expected) => {
    expect(humanDuration(ms)).toBe(expected);
  });
});
