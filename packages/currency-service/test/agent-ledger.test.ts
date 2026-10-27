import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AgentLedgerService, type AgentApplyContext } from '../src/agent/agent-ledger.service';
import { AgentSettingsService } from '../src/agent/agent-settings.service';
import { AgentQuotaService } from '../src/agent/agent-quota.service';
import { AgentGapService } from '../src/agent/agent-gap.service';
import { hmacPhone } from '../src/agent/agent.util';

const NOW = new Date('2026-10-26T00:00:00.000Z');
const EFFECTIVE = new Date('2026-10-01T00:00:00.000Z');

const settingsRow = (overrides: Record<string, unknown> = {}) => ({
  enabled: 1,
  effective_from: EFFECTIVE,
  default_rate_bp: 0,
  min_settlement_yuan: 100,
  coin_per_yuan: 100,
  quota_hold_days: 0,
  quota_admin_adjust_daily_limit_coins: 50000,
  adjust_max_yuan_per_op: 10000,
  adjust_max_yuan_per_day: 20000,
  ...overrides,
});

interface AgentRow {
  phone: string;
  rate_bp: number;
  status: string;
  parent_id: string | null;
}
interface RevenueRow {
  id: number;
  owner_id: string;
  agent_id: string | null;
  source_op_id: number;
  fee_amount: number;
  base_amount: number;
  quota_consumed: number;
  top_rate_bp: number;
  expected_max_micro: number;
  chain_json: string | null;
  skipped_reason: string | null;
  ref_id: string | null;
}
interface CommissionRow {
  agent_id: string;
  owner_id: string;
  revenue_event_id: number;
  source_op_id: number;
  level: number;
  rate_bp: number;
  paid_bp: number;
  commission_micro: number;
}

function makeDb(opts: {
  settings?: Record<string, unknown> | null;
  bindings?: Record<string, { agent_id: string; phone_hash: string }>;
  agents?: Record<string, AgentRow>;
  quota?: Record<string, { inflow: number; consumed: number }>;
  revenue?: RevenueRow[];
  opCreatedAt?: Date;
}) {
  const settings = opts.settings ?? settingsRow();
  const bindings = new Map(Object.entries(opts.bindings ?? {}));
  const agents = new Map(Object.entries(opts.agents ?? {}));
  const quota = new Map(
    Object.entries(opts.quota ?? {}).map(([k, v]) => [k, { inflow_total: v.inflow, consumed_total: v.consumed }]),
  );
  const credits = new Map<string, number>();
  const pending: Array<{ ownerId: string; sourceOpId: number; amount: number; maturesAt: Date }> = [];
  const revenue: RevenueRow[] = [...(opts.revenue ?? [])];
  const commissions: CommissionRow[] = [];
  const calls: string[] = [];
  let revenueId = Math.max(0, ...revenue.map((r) => r.id));
  const opCreatedAt = opts.opCreatedAt ?? NOW;

  const manager = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      const p = params ?? [];
      if (sql.includes('FROM `agent_settings`')) return settings === null ? [] : [settings];
      if (sql.includes('FROM `currency_ops`')) return [{ created_at: opCreatedAt }];
      if (sql.includes('FROM `agent_revenue_events` WHERE `source_op_id`')) {
        return revenue
          .filter((r) => r.source_op_id === Number(p[0]) && r.owner_id === String(p[1]))
          .map((r) => ({ id: r.id }));
      }
      if (sql.includes('FROM `agent_bindings`')) {
        const b = bindings.get(String(p[0]));
        return b === undefined ? [] : [b];
      }
      if (sql.includes('WITH RECURSIVE _chain')) {
        // 递归 CTE 拉全链：p[0]=directAgentId, p[1]=maxDepth-1
        const directId = String(p[0]);
        const maxLevel = Number(p[1]);
        const out: Array<Record<string, unknown>> = [];
        let curId: string | undefined = directId;
        let lvl = 0;
        while (curId && lvl <= maxLevel) {
          const a = agents.get(curId);
          if (!a) break;
          out.push({ id: curId, lvl, ...a });
          curId = a.parent_id === null ? undefined : String(a.parent_id);
          lvl += 1;
        }
        return out;
      }
      if (sql.includes('FROM `agent_accounts`')) {
        const a = agents.get(String(p[0]));
        return a === undefined ? [] : [{ id: String(p[0]), ...a }];
      }
      if (sql.includes('INSERT INTO `agent_revenue_events`')) {
        const [ownerId, agentId, opId, fee, base, consumed, top, expected, chain, skipped, refId] = p;
        const existing = revenue.find(
          (r) => r.source_op_id === Number(opId) && r.owner_id === String(ownerId),
        );
        if (existing) return { insertId: existing.id };
        revenueId += 1;
        revenue.push({
          id: revenueId,
          owner_id: String(ownerId),
          agent_id: agentId === null ? null : String(agentId),
          source_op_id: Number(opId),
          fee_amount: Number(fee),
          base_amount: Number(base),
          quota_consumed: Number(consumed),
          top_rate_bp: Number(top),
          expected_max_micro: Number(expected),
          chain_json: chain === null ? null : String(chain),
          skipped_reason: skipped === null ? null : String(skipped),
          ref_id: refId === null ? null : String(refId),
        });
        return { insertId: revenueId };
      }
      if (sql.includes('INSERT INTO `agent_commission_entries`')) {
        const [agentId, ownerId, revenueEventId, opId, level, rateBp, paidBp, micro] = p;
        commissions.push({
          agent_id: String(agentId),
          owner_id: String(ownerId),
          revenue_event_id: Number(revenueEventId),
          source_op_id: Number(opId),
          level: Number(level),
          rate_bp: Number(rateBp),
          paid_bp: Number(paidBp),
          commission_micro: Number(micro),
        });
        return undefined;
      }
      if (sql.includes('INSERT INTO `agent_player_quota`')) {
        const owner = String(p[0]);
        if (!quota.has(owner)) quota.set(owner, { inflow_total: 0, consumed_total: 0 });
        return undefined;
      }
      if (sql.includes('FROM `agent_player_quota`')) {
        const row = quota.get(String(p[0]));
        return row === undefined ? [] : [row];
      }
      if (sql.startsWith('UPDATE `agent_player_quota`')) {
        quota.set(String(p[2]), { inflow_total: Number(p[0]), consumed_total: Number(p[1]) });
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
      throw new Error(`fake manager 未识别 SQL：${sql}`);
    },
  } as unknown as EntityManager;

  return { manager, settings, bindings, agents, quota, credits, pending, revenue, commissions, calls };
}

function makeLedger() {
  const gap = { record: vi.fn(async () => undefined) } as unknown as AgentGapService;
  const ledger = new AgentLedgerService(
    new AgentSettingsService({} as never),
    new AgentQuotaService(),
    gap,
  );
  return { ledger, gap };
}

const ctx = (source: string, delta: number, opId = 10): AgentApplyContext => ({
  opId,
  actionId: `test:${opId}`,
  source,
  refId: 'ROOM01',
  entries: [{ ownerId: 'u1', ownerType: 'user', delta }],
});

const agents9060 = {
  a: { phone: '13800000001', rate_bp: 6000, status: 'active', parent_id: 'b' },
  b: { phone: '13800000002', rate_bp: 8000, status: 'active', parent_id: 'c' },
  c: { phone: '13800000003', rate_bp: 9000, status: 'active', parent_id: null },
};

describe('AgentLedgerService：台费记账', () => {
  it('绑定玩家：1 revenue + 3 级差佣金；额度消耗 1', async () => {
    const db = makeDb({
      bindings: { u1: { agent_id: 'a', phone_hash: hmacPhone('13900000000') } },
      agents: agents9060,
      quota: { u1: { inflow: 100, consumed: 0 } },
    });
    const { ledger } = makeLedger();

    await ledger.onApply(db.manager, ctx('entry_fee', -1));

    expect(db.revenue).toHaveLength(1);
    expect(db.revenue[0]).toMatchObject({
      agent_id: 'a',
      fee_amount: 1,
      base_amount: 1,
      quota_consumed: 1,
      top_rate_bp: 9000,
      expected_max_micro: 9000,
      skipped_reason: null,
      ref_id: 'ROOM01',
    });
    expect(db.commissions.map((c) => [c.agent_id, c.level, c.paid_bp, c.commission_micro])).toEqual([
      ['a', 0, 6000, 6000],
      ['b', 1, 2000, 2000],
      ['c', 2, 1000, 1000],
    ]);
    expect(db.quota.get('u1')).toEqual({ inflow_total: 100, consumed_total: 1 });
  });

  it('未绑定：写 unbound event、无佣金、不动额度', async () => {
    const db = makeDb({ quota: { u1: { inflow: 100, consumed: 0 } } });
    const { ledger } = makeLedger();
    await ledger.onApply(db.manager, ctx('entry_fee', -1));
    expect(db.revenue).toHaveLength(1);
    expect(db.revenue[0]).toMatchObject({ agent_id: null, base_amount: 0, skipped_reason: 'unbound' });
    expect(db.commissions).toHaveLength(0);
    expect(db.quota.get('u1')).toEqual({ inflow_total: 100, consumed_total: 0 });
  });

  it('额度耗尽：base=0、skipped=quota_exhausted、无佣金', async () => {
    const db = makeDb({
      bindings: { u1: { agent_id: 'a', phone_hash: hmacPhone('13900000000') } },
      agents: agents9060,
      quota: { u1: { inflow: 100, consumed: 100 } },
    });
    const { ledger } = makeLedger();
    await ledger.onApply(db.manager, ctx('entry_fee', -1));
    expect(db.revenue[0]).toMatchObject({ base_amount: 0, skipped_reason: 'quota_exhausted' });
    expect(db.revenue[0]!.chain_json).toContain('"level":0');
    expect(db.commissions).toHaveLength(0);
  });

  it('自玩：直接代理份额顺延给上级（上级拿 80%）', async () => {
    const db = makeDb({
      bindings: { u1: { agent_id: 'a', phone_hash: hmacPhone('13800000001') } },
      agents: agents9060,
      quota: { u1: { inflow: 100, consumed: 0 } },
    });
    const { ledger } = makeLedger();
    await ledger.onApply(db.manager, ctx('entry_fee', -1));
    expect(db.commissions.map((c) => [c.agent_id, c.paid_bp, c.commission_micro])).toEqual([
      ['b', 8000, 8000],
      ['c', 1000, 1000],
    ]);
  });

  it('冻结：直接代理 0 且份额归平台（上级只拿级差 20%）', async () => {
    const db = makeDb({
      bindings: { u1: { agent_id: 'a', phone_hash: hmacPhone('13900000000') } },
      agents: { ...agents9060, a: { ...agents9060.a, status: 'frozen' } },
      quota: { u1: { inflow: 100, consumed: 0 } },
    });
    const { ledger } = makeLedger();
    await ledger.onApply(db.manager, ctx('entry_fee', -1));
    expect(db.commissions.map((c) => [c.agent_id, c.paid_bp, c.commission_micro])).toEqual([
      ['b', 2000, 2000],
      ['c', 1000, 1000],
    ]);
  });

  it('幂等：已有 revenue event ⇒ 不再消耗额度/写佣金', async () => {
    const db = makeDb({
      bindings: { u1: { agent_id: 'a', phone_hash: hmacPhone('13900000000') } },
      agents: agents9060,
      quota: { u1: { inflow: 100, consumed: 0 } },
      revenue: [
        {
          id: 7,
          owner_id: 'u1',
          agent_id: 'a',
          source_op_id: 10,
          fee_amount: 1,
          base_amount: 1,
          quota_consumed: 1,
          top_rate_bp: 9000,
          expected_max_micro: 9000,
          chain_json: null,
          skipped_reason: null,
          ref_id: 'ROOM01',
        },
      ],
    });
    const { ledger } = makeLedger();
    await ledger.onApply(db.manager, ctx('entry_fee', -1));
    expect(db.commissions).toHaveLength(0);
    expect(db.quota.get('u1')).toEqual({ inflow_total: 100, consumed_total: 0 });
  });

  it('额度 source（recharge）只更新额度，不写 revenue/佣金', async () => {
    const db = makeDb({});
    const { ledger } = makeLedger();
    await ledger.onApply(db.manager, ctx('recharge', 1000));
    expect(db.quota.get('u1')).toEqual({ inflow_total: 1000, consumed_total: 0 });
    expect(db.revenue).toHaveLength(0);
    expect(db.commissions).toHaveLength(0);
  });

  it('admin_adjust 正数受单日上限（600）', async () => {
    const db = makeDb({
      settings: settingsRow({ quota_admin_adjust_daily_limit_coins: 600 }),
    });
    const { ledger } = makeLedger();
    await ledger.onApply(db.manager, ctx('admin_adjust', 1000));
    expect(db.quota.get('u1')).toEqual({ inflow_total: 600, consumed_total: 0 });
  });

  it('enabled=false：只读 settings，不读 op/不写', async () => {
    const db = makeDb({ settings: settingsRow({ enabled: 0 }) });
    const { ledger } = makeLedger();
    await ledger.onApply(db.manager, ctx('entry_fee', -1));
    expect(db.calls.some((s) => s.includes('FROM `currency_ops`'))).toBe(false);
    expect(db.revenue).toHaveLength(0);
  });

  it('effective_from 之前：不写', async () => {
    const db = makeDb({
      settings: settingsRow(),
      opCreatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const { ledger } = makeLedger();
    await ledger.onApply(db.manager, ctx('entry_fee', -1));
    expect(db.revenue).toHaveLength(0);
  });

  it('钩子抛错 ⇒ gap.record 被调用且原错误重抛', async () => {
    const db = makeDb({
      bindings: { u1: { agent_id: 'a', phone_hash: hmacPhone('13900000000') } },
      agents: {
        a: { phone: '1', rate_bp: 1000, status: 'active', parent_id: 'b' },
        b: { phone: '2', rate_bp: 1000, status: 'active', parent_id: 'c' },
        c: { phone: '3', rate_bp: 1000, status: 'active', parent_id: 'd' },
        d: { phone: '4', rate_bp: 1000, status: 'active', parent_id: 'e' },
        e: { phone: '5', rate_bp: 1000, status: 'active', parent_id: 'f' },
        f: { phone: '6', rate_bp: 1000, status: 'active', parent_id: null },
      },
      quota: { u1: { inflow: 100, consumed: 0 } },
    });
    const { ledger, gap } = makeLedger();
    await expect(ledger.onApply(db.manager, ctx('entry_fee', -1))).rejects.toThrow(/深度/);
    expect(gap.record).toHaveBeenCalledTimes(1);
  });
});
