import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AgentQuotaMaturityService } from '../src/agent/agent-quota-maturity.service';

describe('AgentQuotaMaturityService：到期并入额度', () => {
  it('SKIP LOCKED 取到期行、逐行并入 inflow 并标记 matured', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const manager = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        if (sql.includes('FROM `agent_quota_inflows`')) {
          return [
            { id: 1, owner_id: 'u1', amount: 700 },
            { id: 2, owner_id: 'u2', amount: 300 },
          ];
        }
        return undefined;
      },
    } as unknown as EntityManager;
    const svc = new AgentQuotaMaturityService({} as never);

    const n = await svc.matureDue(manager);

    expect(n).toBe(2);
    expect(calls[0]!.sql).toContain('FOR UPDATE SKIP LOCKED');
    const adds = calls.filter((c) => c.sql.startsWith('UPDATE `agent_player_quota`'));
    expect(adds.map((c) => c.params)).toEqual([
      [700, 'u1'],
      [300, 'u2'],
    ]);
    const marks = calls.filter((c) => c.sql.startsWith('UPDATE `agent_quota_inflows`'));
    expect(marks.map((c) => c.params)).toEqual([[1], [2]]);
    // 每个 owner 先 ensure（原子 upsert）
    expect(calls.filter((c) => c.sql.includes('INSERT INTO `agent_player_quota`'))).toHaveLength(2);
  });

  it('无到期行 ⇒ 0、无写入', async () => {
    const calls: string[] = [];
    const manager = {
      query: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as EntityManager;
    const svc = new AgentQuotaMaturityService({} as never);
    expect(await svc.matureDue(manager)).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
