/**
 * `risk.metrics.ts` 四指标的**定义面** —— 风控片 T4（规格 §2.12 user 四行；写点在 T5/T6）。
 *
 * 本任务的交付只是「四个名字与标签面进 shared registry、与规格逐字同名」；写点与行为断言
 * 归 T5（scan）/T6（actions）的任务卡。这里用 `getSingleMetric` 查**登记面**——
 * 名字写错 / 落错 registry（直连 prom-client 而非 shared 构造器）都会当场红。
 */
import { describe, it, expect } from 'vitest';
import { metricsRegistry } from '@fight-the-landlord/shared';
import {
  riskScanRunsTotal,
  riskScanLastSuccessTimestampSeconds,
  riskReviewsOpen,
  riskActionsTotal,
  riskScanSqlFailuresTotal,
} from '../src/risk/risk.metrics';

describe('风控指标定义（T4 只建文件；写点 T5/T6）', () => {
  it('四个指标名逐字进 shared registry（§2.12：risk_scan_runs_total / risk_scan_last_success_timestamp_seconds / risk_reviews_open / risk_actions_total）', () => {
    for (const name of [
      'risk_scan_runs_total',
      'risk_scan_last_success_timestamp_seconds',
      'risk_reviews_open',
      'risk_actions_total',
      'risk_scan_sql_failures_total',
    ]) {
      expect(metricsRegistry().getSingleMetric(name), `registry 里没有 ${name}`).toBeDefined();
    }
  });

  it('标签面逐字（功能断言）：runs 按 result、actions 按 action 真的可打点；两 gauge 无标签', async () => {
    // 同一条对象（导出常量与 registry 不是两份定义）。
    expect(metricsRegistry().getSingleMetric('risk_scan_runs_total')).toBe(riskScanRunsTotal);
    expect(metricsRegistry().getSingleMetric('risk_actions_total')).toBe(riskActionsTotal);
    expect(metricsRegistry().getSingleMetric('risk_reviews_open')).toBe(riskReviewsOpen);
    expect(metricsRegistry().getSingleMetric('risk_scan_last_success_timestamp_seconds')).toBe(
      riskScanLastSuccessTimestampSeconds,
    );
    expect(metricsRegistry().getSingleMetric('risk_scan_sql_failures_total')).toBe(
      riskScanSqlFailuresTotal,
    );

    // 标签维度用**输出面**钉（prom-client 的 .d.ts 不公开 labelNames ⇒ 读文本才是真断言）：
    // 打得进 result/action 维度 ⇒ 标签面与规格 `{result}` / `{action}` 逐字同形。
    riskScanRunsTotal.inc({ result: 'ok' });
    riskActionsTotal.inc({ action: 'ban' });
    riskScanSqlFailuresTotal.inc({ scope: 'paodekuai' });
    const text = await metricsRegistry().metrics();
    expect(text, 'result 维度').toMatch(/^risk_scan_runs_total\{result="ok"\} \d+$/m);
    expect(text, 'action 维度').toMatch(/^risk_actions_total\{action="ban"\} \d+$/m);
    expect(text, 'scope 维度').toMatch(
      /^risk_scan_sql_failures_total\{scope="paodekuai"\} \d+$/m,
    );
    // 两个 gauge 无标签（裸 `名字 值` 行；带标签的话这两条会红）。
    expect(text, 'reviews_open 无标签').toMatch(/^risk_reviews_open \d+(\.\d+)?$/m);
    expect(text, 'last_success 无标签').toMatch(/^risk_scan_last_success_timestamp_seconds \d+(\.\d+)?$/m);
  });
});
