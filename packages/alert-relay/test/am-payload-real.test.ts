import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatAlert } from '../src/format';
import type { AlertmanagerWebhookPayload } from '../src/format';

/**
 * 真栈 golden：`alertmanager-v4-real.golden.json` = **真 AM v0.34.1 实发载荷**（T12 真栈 dump 回填，
 * 规格 §2.6 的 ⚙️「AM 0.34 的 payload 字段以实施时真栈 dump 一例钉 golden」）。
 *
 * 与 `format.test.ts` 的合成 fixture 的**差异就是本文件的存在理由**（真载荷独有的字段面）：
 *  - `notification_reason: "first notification"`（v0.34 新增 —— 类型定义**未声明**它，
 *    这里刻意用 `as never` 喂进去：真实世界里它就在正文里，格式器必须容错吞掉、不许抛）；
 *  - `routeLabels: {}`（同）；
 *  - `externalURL` 是 AM 容器的**内部主机名**（`http://<container-id>:9093`）——无 URL 不变量的
 *    又一个真实样本（合成 fixture 里是规整域名，这里才是「野」形态）。
 *
 * ⚠️ dump 方式（可复现）：临时 `prom/alertmanager:v0.34.1` + `group_wait: 1s` 的临时配置 +
 *    指向探针 stub 的 webhook 接收器 ⇒ `POST /api/v2/alerts`（label 面 = 本仓 ServiceDown 的
 *    真实形状）⇒ stub 收到的 JSON 原文即本 fixture（中文 UTF-8 原样保留）。
 */
const FIXTURE = join(__dirname, 'fixtures', 'alertmanager-v4-real.golden.json');

/** 固定时钟（> startsAt，避开「持续」为负的边界；不看墙上时钟）。 */
const NOW = Date.parse('2026-10-03T10:30:00Z');

describe('formatAlert × 真栈 AM v0.34.1 载荷（T12 golden dump）', () => {
  it('真载荷不抛且标题/正文成形（job 与 summary 都进了正文）；无 URL 不变量仍成立', () => {
    const payload = JSON.parse(readFileSync(FIXTURE, 'utf8')) as AlertmanagerWebhookPayload;
    const msg = formatAlert(payload, NOW);
    expect(msg.title).toBe('[critical] ServiceDown');
    expect(msg.body).toContain('api-gateway');
    expect(msg.body).toContain('api-gateway 抓不到了');
    // 无 URL 不变量：generatorURL（prometheus graph URL）与注释/文本里的一切链接都不得出境。
    expect(msg.title + msg.body).not.toMatch(/https?:\/\//);
  });

  it('v0.34 独有字段（notification_reason/routeLabels）不在类型定义里也必须被容错吞掉', () => {
    const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
    // 自证：fixture 里**真的**带着那两个合成 fixture 没有的字段（否则本用例退化成重复）。
    expect(raw.notification_reason).toBe('first notification');
    expect(raw.routeLabels).toEqual({});
    const msg = formatAlert(raw as never, NOW);
    // 逐字正文（真 startsAt=10:23:10.26Z；NOW=10:30:00 ⇒ 持续 6m49s）——summary 优先、runbook 不进正文。
    expect(msg.body).toBe(
      '- api-gateway/api-gateway:9000 · api-gateway 抓不到了 · 开始 2026-10-03 10:23 UTC · 持续 6m49s',
    );
  });
});
