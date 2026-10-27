import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AgentQuotaService } from '../src/agent/agent-quota.service';

type Row = { inflow_total: number; consumed_total: number };

function fakeManager() {
  const quotas = new Map<string, Row>();
  const credits = new Map<string, number>();
  const pending: Array<{ ownerId: string; sourceOpId: number; amount: number; maturesAt: Date }> =
    [];
  const manager = {
    query: async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      if (sql.includes('INSERT INTO `agent_player_quota`')) {
        const owner = String(p[0]);
        if (!quotas.has(owner)) quotas.set(owner, { inflow_total: 0, consumed_total: 0 });
        return undefined;
      }
      if (sql.includes('FROM `agent_player_quota`')) {
        const row = quotas.get(String(p[0]));
        return row === undefined ? [] : [row];
      }
      if (sql.startsWith('UPDATE `agent_player_quota`')) {
        const owner = String(p[2]);
        quotas.set(owner, { inflow_total: Number(p[0]), consumed_total: Number(p[1]) });
        return undefined;
      }
      if (sql.includes('INSERT INTO `agent_admin_quota_credits`')) {
        const key = `${String(p[0])}|${String(p[1])}`;
        if (!credits.has(key)) credits.set(key, 0);
        return undefined;
      }
      if (sql.includes('FROM `agent_admin_quota_credits`')) {
        const key = `${String(p[0])}|${String(p[1])}`;
        return credits.has(key) ? [{ credited_coins: credits.get(key)! }] : [];
      }
      if (sql.startsWith('UPDATE `agent_admin_quota_credits`')) {
        const key = `${String(p[1])}|${String(p[2])}`;
        credits.set(key, (credits.get(key) ?? 0) + Number(p[0]));
        return undefined;
      }
      if (sql.includes('INSERT INTO `agent_quota_inflows`')) {
        pending.push({
          ownerId: String(p[0]),
          sourceOpId: Number(p[1]),
          amount: Number(p[2]),
          maturesAt: p[3] as Date,
        });
        return undefined;
      }
      return undefined;
    },
  } as unknown as EntityManager;
  return { manager, quotas, credits, pending };
}

const NOW = new Date('2026-10-26T04:00:00.000Z');
const base = {
  ownerId: 'u1',
  sourceOpId: 10,
  now: NOW,
  adminDailyLimitCoins: 600,
  holdDays: 0,
};

describe('AgentQuotaService：净入金', () => {
  it('充值全额入账；台费消耗；负出账只抵扣未消耗本金', async () => {
    const { manager, quotas } = fakeManager();
    const svc = new AgentQuotaService();

    const recharged = await svc.applyDelta(manager, { ...base, source: 'recharge', delta: 1000 });
    expect(recharged).toMatchObject({ inflow: 1000, consumed: 0, available: 1000, creditedCoins: 1000 });

    const consumed = await svc.consume(manager, 'u1', 400);
    expect(consumed).toMatchObject({ inflow: 1000, consumed: 400, available: 600 });

    const withDraw = await svc.applyDelta(manager, {
      ...base,
      source: 'withdraw_hold',
      delta: -500,
    });
    expect(withDraw).toMatchObject({ inflow: 500, consumed: 400, available: 100, deductedCoins: 500 });

    const overDraw = await svc.applyDelta(manager, {
      ...base,
      source: 'withdraw_hold',
      delta: -1000,
    });
    expect(overDraw).toMatchObject({ inflow: 400, consumed: 400, available: 0, deductedCoins: 100 });
    expect(quotas.get('u1')).toEqual({ inflow_total: 400, consumed_total: 400 });
  });

  it('赢钱后提现不压低未来佣金：已消耗满额时负出账抵扣 0', async () => {
    const { manager } = fakeManager();
    const svc = new AgentQuotaService();
    await svc.applyDelta(manager, { ...base, source: 'recharge', delta: 1000 });
    await svc.consume(manager, 'u1', 1000);
    const out = await svc.applyDelta(manager, { ...base, source: 'withdraw_hold', delta: -2000 });
    expect(out).toMatchObject({ inflow: 1000, consumed: 1000, available: 0, deductedCoins: 0 });
  });

  it('admin_adjust 正数受单日上限；当天再充不再计入额度', async () => {
    const { manager, credits } = fakeManager();
    const svc = new AgentQuotaService();
    const first = await svc.applyDelta(manager, { ...base, source: 'admin_adjust', delta: 1000 });
    expect(first).toMatchObject({ inflow: 600, creditedCoins: 600 });
    const second = await svc.applyDelta(manager, { ...base, source: 'admin_adjust', delta: 1000 });
    expect(second).toMatchObject({ inflow: 600, creditedCoins: 0 });
    expect([...credits.values()][0]).toBe(600);
  });

  it('holdDays > 0：正入账进待成熟表、不立即入额度', async () => {
    const { manager, pending } = fakeManager();
    const svc = new AgentQuotaService();
    const out = await svc.applyDelta(manager, {
      ...base,
      source: 'recharge',
      delta: 1000,
      holdDays: 7,
    });
    expect(out).toMatchObject({ inflow: 0, pending: true, creditedCoins: 1000 });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ ownerId: 'u1', sourceOpId: 10, amount: 1000 });
    expect(pending[0]!.maturesAt.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
  });

  it('非额度 source ⇒ null；delta=0 只读快照', async () => {
    const { manager } = fakeManager();
    const svc = new AgentQuotaService();
    expect(await svc.applyDelta(manager, { ...base, source: 'game_settle', delta: 100 })).toBeNull();
    const zero = await svc.applyDelta(manager, { ...base, source: 'recharge', delta: 0 });
    expect(zero).toMatchObject({ inflow: 0, consumed: 0, available: 0, creditedCoins: 0 });
  });

  it('consume 超过 available ⇒ 抛错（调用方必须先裁剪）', async () => {
    const { manager } = fakeManager();
    const svc = new AgentQuotaService();
    await svc.applyDelta(manager, { ...base, source: 'recharge', delta: 10 });
    await expect(svc.consume(manager, 'u1', 11)).rejects.toThrow(/amount=11/);
  });
});
