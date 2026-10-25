import { describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AgentAdjustmentService } from '../src/agent/agent-adjustment.service';
import type { AgentSettingsService } from '../src/agent/agent-settings.service';

interface Adj {
  id: number;
  agent_id: string;
  delta_micro: number;
  reason: string;
  status: string;
  requested_by: string;
  approved_by: string | null;
  commission_entry_id: number | null;
  created_at: Date;
  decided_at: Date | null;
}

function makeDb(opts: {
  agents?: string[];
  settings?: { coinPerYuan?: number; perOpYuan?: number; perDayYuan?: number };
} = {}) {
  const agents = new Set(opts.agents ?? ['a']);
  const adjustments = new Map<number, Adj>();
  const manual: Array<{ id: number; agent: string; micro: number; reason: string }> = [];
  let nextAdj = 1;
  let nextEntry = 1;
  const settings = {
    coinPerYuan: opts.settings?.coinPerYuan ?? 100,
    adjustMaxYuanPerOp: opts.settings?.perOpYuan ?? 10000,
    adjustMaxYuanPerDay: opts.settings?.perDayYuan ?? 20000,
  };
  const manager = {
    query: async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      if (sql.includes('FROM `agent_accounts` WHERE `id` = ? FOR UPDATE')) {
        return agents.has(String(p[0])) ? [{ id: String(p[0]) }] : [];
      }
      if (sql.includes('SUM(ABS(`delta_micro`))')) {
        const total = [...adjustments.values()]
          .filter((a) => a.agent_id === String(p[0]) && a.status !== 'rejected')
          .reduce((s, a) => s + Math.abs(a.delta_micro), 0);
        return [{ total }];
      }
      if (sql.startsWith('INSERT INTO `agent_adjustments`')) {
        const id = nextAdj;
        nextAdj += 1;
        adjustments.set(id, {
          id,
          agent_id: String(p[0]),
          delta_micro: Number(p[1]),
          reason: String(p[2]),
          status: 'pending',
          requested_by: String(p[3]),
          approved_by: null,
          commission_entry_id: null,
          created_at: new Date('2026-10-26T00:00:00Z'),
          decided_at: null,
        });
        return { insertId: id };
      }
      if (sql.includes('FROM `agent_adjustments` WHERE `id` = ?')) {
        const a = adjustments.get(Number(p[0]));
        return a === undefined ? [] : [a];
      }
      if (sql.startsWith("UPDATE `agent_adjustments` SET `status` = 'approved'")) {
        const a = adjustments.get(Number(p[2]));
        if (a !== undefined) {
          a.status = 'approved';
          a.approved_by = String(p[0]);
          a.commission_entry_id = Number(p[1]);
          a.decided_at = new Date();
        }
        return undefined;
      }
      if (sql.startsWith("UPDATE `agent_adjustments` SET `status` = 'rejected'")) {
        const a = adjustments.get(Number(p[1]));
        if (a !== undefined) {
          a.status = 'rejected';
          a.approved_by = String(p[0]);
          a.decided_at = new Date();
        }
        return undefined;
      }
      if (sql.includes('INSERT INTO `agent_commission_entries`')) {
        const id = nextEntry;
        nextEntry += 1;
        manual.push({
          id,
          agent: String(p[0]),
          micro: Number(p[1]),
          reason: String(p[2]),
        });
        return { insertId: id };
      }
      if (sql.includes('INSERT INTO `agent_admin_audit`')) return undefined;
      if (sql.includes('FROM `agent_adjustments`')) {
        return [...adjustments.values()];
      }
      throw new Error(`fake adjustment DB 未识别 SQL：${sql}`);
    },
  } as unknown as EntityManager;
  const dataSource = {
    transaction: async <T>(cb: (m: EntityManager) => Promise<T>) => cb(manager),
    query: (sql: string, params?: unknown[]) => manager.query(sql, params),
  };
  const settingsSvc = { get: vi.fn(async () => settings) } as unknown as AgentSettingsService;
  return { manager, dataSource, settingsSvc, adjustments, manual };
}

function makeService(db: ReturnType<typeof makeDb>) {
  return new AgentAdjustmentService(db.dataSource as unknown as DataSource, db.settingsSvc);
}

describe('AgentAdjustmentService：发起/复核/驳回', () => {
  it('发起 pending：deltaCoins → micro；写 audit', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const a = await svc.create({ agentId: 'a', deltaCoins: 100, reason: '补偿', requestedBy: 'admin1' });
    expect(a).toMatchObject({
      agentId: 'a',
      deltaMicro: 1_000_000,
      status: 'pending',
      requestedBy: 'admin1',
    });
  });

  it('单笔上限：101 币 > 100 币上限 ⇒ 拒绝', async () => {
    const db = makeDb({ settings: { perOpYuan: 1, coinPerYuan: 100 } });
    const svc = makeService(db);
    await expect(
      svc.create({ agentId: 'a', deltaCoins: 101, reason: 'x', requestedBy: 'admin1' }),
    ).rejects.toThrow(/单笔调账上限/);
  });

  it('单日上限：两笔合计超限 ⇒ 第二笔拒绝', async () => {
    const db = makeDb({ settings: { perOpYuan: 1000, perDayYuan: 1, coinPerYuan: 100 } });
    const svc = makeService(db);
    await svc.create({ agentId: 'a', deltaCoins: 100, reason: 'x', requestedBy: 'admin1' });
    await expect(
      svc.create({ agentId: 'a', deltaCoins: 1, reason: 'y', requestedBy: 'admin1' }),
    ).rejects.toThrow(/单日调账上限/);
  });

  it('复核人不能是发起人；另一人通过 ⇒ 插 manual 佣金行', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const a = await svc.create({ agentId: 'a', deltaCoins: 100, reason: '补偿', requestedBy: 'admin1' });
    await expect(
      svc.approve({ id: a.id, approvedBy: 'admin1' }),
    ).rejects.toMatchObject({ code: ErrCode.FORBIDDEN });

    const approved = await svc.approve({ id: a.id, approvedBy: 'admin2' });
    expect(approved.status).toBe('approved');
    expect(approved.commissionEntryId).toBe(1);
    expect(db.manual).toEqual([{ id: 1, agent: 'a', micro: 1_000_000, reason: '补偿' }]);
  });

  it('驳回：pending → rejected；重复复核 ⇒ 状态错', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const a = await svc.create({ agentId: 'a', deltaCoins: -50, reason: '扣回', requestedBy: 'admin1' });
    const rejected = await svc.reject({ id: a.id, actor: 'admin2', reason: '凭证不足' });
    expect(rejected.status).toBe('rejected');
    await expect(svc.approve({ id: a.id, approvedBy: 'admin3' })).rejects.toMatchObject({
      code: ErrCode.AGENT_SETTLEMENT_STATE,
    });
  });

  it('非法金额/原因 ⇒ BAD_PARAM', async () => {
    const db = makeDb();
    const svc = makeService(db);
    await expect(
      svc.create({ agentId: 'a', deltaCoins: 0, reason: 'x', requestedBy: 'admin1' }),
    ).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    await expect(
      svc.create({ agentId: 'a', deltaCoins: 1, reason: '  ', requestedBy: 'admin1' }),
    ).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
  });
});
