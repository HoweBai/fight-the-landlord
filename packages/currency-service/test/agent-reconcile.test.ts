import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { AgentReconcileService, buildEnabledPeriods } from '../src/agent/agent-reconcile.service';
import type { AgentSettingsService } from '../src/agent/agent-settings.service';

const T0 = new Date('2026-10-01T00:00:00Z');
const T1 = new Date('2026-10-10T00:00:00Z');
const T2 = new Date('2026-10-20T00:00:00Z');
const T3 = new Date('2026-10-26T00:00:00Z');

describe('buildEnabledPeriods：启用区间', () => {
  it('history 空 + 当前 enabled ⇒ [effective_from, to]；disabled ⇒ []', () => {
    expect(
      buildEnabledPeriods([], { enabled: true, effectiveFrom: T0 }, T3),
    ).toEqual([{ start: T0, end: T3 }]);
    expect(buildEnabledPeriods([], { enabled: false, effectiveFrom: T0 }, T3)).toEqual([]);
  });

  it('enable → disable → enable ⇒ 两段；第二段从**本次** changed_at 起（不回卷覆盖关闭窗口）', () => {
    expect(
      buildEnabledPeriods(
        [
          { enabled: true, effectiveFrom: T0, changedAt: T0 },
          { enabled: false, effectiveFrom: T0, changedAt: T1 },
          { enabled: true, effectiveFrom: T0, changedAt: T2 },
        ],
        { enabled: true, effectiveFrom: T0 },
        T3,
      ),
    ).toEqual([
      { start: T0, end: T1 },
      { start: T2, end: T3 },
    ]);
  });
});

function makeDb() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('LEFT JOIN `agent_revenue_events`')) return [{ cnt: 2 }];
    if (sql.includes('COUNT(*) AS `cnt` FROM `agent_ledger_gaps`')) return [{ cnt: 1 }];
    if (sql.includes('SUM(-f.`delta`)')) return [{ total: 100 }];
    if (sql.includes('`agent_id` IS NOT NULL')) return [{ total: 80 }];
    if (sql.includes('`agent_id` IS NULL')) return [{ total: 20 }];
    if (sql.includes('SUM(`base_amount`)')) return [{ total: 70, expected: 75 }];
    if (sql.includes('SUM(`commission_micro`)')) return [{ total: 56 }];
    if (sql.includes('SUM(`total_coins`)')) return [{ total: 50 }];
    if (sql.includes('FROM `agent_settings_history`')) {
      return [{ enabled: 1, effective_from: T0, changed_at: T0 }];
    }
    throw new Error(`fake reconcile DB 未识别 SQL：${sql.slice(0, 80)}`);
  });
  return { query };
}

describe('AgentReconcileService.summary', () => {
  it('汇总台费/绑定/未绑定/基数/佣金/已付/缺口/缺行', async () => {
    const db = makeDb();
    const settings = {
      getOrDefault: vi.fn(async () => ({ enabled: true, effectiveFrom: T0 })),
    } as unknown as AgentSettingsService;
    const svc = new AgentReconcileService(db as unknown as DataSource, settings);
    const s = await svc.summary(T0, T3);
    expect(s).toMatchObject({
      entryFeeTotal: 100,
      boundFeeTotal: 80,
      unboundFeeTotal: 20,
      baseTotal: 70,
      commissionMicroTotal: 56,
      expectedMaxMicroTotal: 75,
      paidCoins: 50,
      gapCount: 1,
      missingEventCount: 2,
    });
  });
});
