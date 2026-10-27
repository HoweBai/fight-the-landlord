import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import {
  AGENT_SETTINGS_DEFAULTS,
  AgentSettingsService,
} from '../src/agent/agent-settings.service';

type Call = { sql: string; params: unknown[] };

function fakeManager(initial: Record<string, unknown> | null) {
  const calls: Call[] = [];
  let row = initial === null ? null : { ...initial };
  const manager = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes('FROM `agent_settings`')) return row === null ? [] : [row];
      if (sql.includes('SELECT NOW(3)')) return [{ now: new Date('2026-10-26T03:04:05.000Z') }];
      if (sql.startsWith('UPDATE `agent_settings`')) {
        const p = params ?? [];
        row = {
          enabled: p[0],
          effective_from: p[1],
          default_rate_bp: p[2],
          min_settlement_yuan: p[3],
          coin_per_yuan: p[4],
          quota_hold_days: p[5],
          quota_admin_adjust_daily_limit_coins: p[6],
          adjust_max_yuan_per_op: p[7],
          adjust_max_yuan_per_day: p[8],
        };
        return undefined;
      }
      return undefined;
    },
  } as unknown as EntityManager;
  const dataSource = {
    transaction: async <T>(cb: (m: EntityManager) => Promise<T>) => cb(manager),
  };
  return { manager, dataSource, calls, getRow: () => row };
}

const dbRow = {
  enabled: 0,
  effective_from: null,
  default_rate_bp: 5000,
  min_settlement_yuan: 100,
  coin_per_yuan: 100,
  quota_hold_days: 0,
  quota_admin_adjust_daily_limit_coins: 50000,
  adjust_max_yuan_per_op: 10000,
  adjust_max_yuan_per_day: 20000,
};

describe('AgentSettingsService', () => {
  it('get：bigint/字符串读回转安全整数；enabled 归一 boolean', async () => {
    const { manager, dataSource } = fakeManager({ ...dbRow, default_rate_bp: '5000' });
    const svc = new AgentSettingsService(dataSource as never);
    const s = await svc.get(manager);
    expect(s).toEqual({
      enabled: false,
      effectiveFrom: null,
      defaultRateBp: 5000,
      minSettlementYuan: 100,
      coinPerYuan: 100,
      quotaHoldDays: 0,
      quotaAdminAdjustDailyLimitCoins: 50000,
      adjustMaxYuanPerOp: 10000,
      adjustMaxYuanPerDay: 20000,
    });
  });

  it('缺行 ⇒ null / getOrDefault 返回 enabled=false 的 fail-safe', async () => {
    const { manager, dataSource } = fakeManager(null);
    const svc = new AgentSettingsService(dataSource as never);
    expect(await svc.get(manager)).toBeNull();
    expect(await svc.getOrDefault(manager)).toEqual(AGENT_SETTINGS_DEFAULTS);
    expect(AGENT_SETTINGS_DEFAULTS.enabled).toBe(false);
  });

  it('首次 enable 写 effective_from + history + audit；再次 enable 不重置', async () => {
    const { dataSource, calls, getRow } = fakeManager({ ...dbRow });
    const svc = new AgentSettingsService(dataSource as never);

    const first = await svc.update({ enabled: true, defaultRateBp: 8000 }, 'admin', '上线');
    expect(first.enabled).toBe(true);
    expect(first.effectiveFrom).toBeInstanceOf(Date);
    expect(getRow()!.enabled).toBe(1);
    expect(calls.some((c) => c.sql.includes('INSERT INTO `agent_settings_history`'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO `agent_admin_audit`'))).toBe(true);

    const firstEffective = first.effectiveFrom!.toISOString();
    const second = await svc.update({ enabled: false }, 'admin', '停用');
    expect(second.effectiveFrom?.toISOString()).toBe(firstEffective);
    const third = await svc.update({ enabled: true }, 'admin', '再开');
    expect(third.effectiveFrom?.toISOString()).toBe(firstEffective);
  });

  it('缺 settings 行时 update 抛错（迁移事故不静默）', async () => {
    const { dataSource } = fakeManager(null);
    const svc = new AgentSettingsService(dataSource as never);
    await expect(svc.update({ enabled: true }, 'admin', 'x')).rejects.toThrow(/单行缺失/);
  });
});
