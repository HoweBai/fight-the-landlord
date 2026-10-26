import { describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AgentSettlementService, computeItemsHash } from '../src/agent/agent-settlement.service';
import type { AgentSettingsService } from '../src/agent/agent-settings.service';

interface AgentRow {
  micro_carry: number;
  settled_watermark: number;
  pending_settlement_id: number | null;
  payout_name: string | null;
  payout_account: string | null;
  payout_bank: string | null;
}
interface EntryRow {
  id: number;
  agent_id: string;
  commission_micro: number;
}
interface Settlement {
  id: number;
  settlement_no: string;
  agent_id: string;
  client_request_id: string;
  status: string;
  from_entry_id: number;
  to_entry_id: number;
  total_micro: number;
  total_coins: number;
  items_count: number;
  carry_before: number;
  carry_after: number;
  coin_per_yuan: number;
  payout_json: string | null;
  min_yuan: number;
  items_hash: string;
  requested_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  paid_at: Date | null;
  paid_by: string | null;
  voucher_no: string | null;
  reject_reason: string | null;
}

function makeDb(opts: {
  agent?: Partial<AgentRow>;
  entries?: Array<{ id: number; micro: number }>;
  settings?: { coinPerYuan?: number; minYuan?: number };
} = {}) {
  const agent: AgentRow = {
    micro_carry: 0,
    settled_watermark: 0,
    pending_settlement_id: null,
    payout_name: '张三',
    payout_account: '6222000011112222',
    payout_bank: '招商银行',
    ...opts.agent,
  };
  const entries: EntryRow[] = (opts.entries ?? []).map((e) => ({
    id: e.id,
    agent_id: 'a',
    commission_micro: e.micro,
  }));
  const settlements = new Map<number, Settlement>();
  let nextId = 1;
  const settings = {
    coinPerYuan: opts.settings?.coinPerYuan ?? 100,
    minSettlementYuan: opts.settings?.minYuan ?? 1,
  };

  const findById = (id: number): Settlement | undefined => settlements.get(id);
  const manager = {
    query: async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      if (sql.includes('FROM `agent_accounts` WHERE `id` = ? FOR UPDATE')) {
        return [{ ...agent }];
      }
      if (sql.includes('FROM `agent_settlements` WHERE `agent_id` = ? AND `client_request_id` = ?')) {
        return [...settlements.values()].filter(
          (s) => s.agent_id === String(p[0]) && s.client_request_id === String(p[1]),
        );
      }
      if (sql.includes('FROM `agent_settlements` WHERE `id` = ?')) {
        const s = findById(Number(p[0]));
        return s === undefined ? [] : [s];
      }
      if (sql.includes('FROM `agent_settlements` WHERE `agent_id` = ? ORDER BY')) {
        return [...settlements.values()].filter((s) => s.agent_id === String(p[0]));
      }
      if (sql.includes('FROM `agent_settlements` WHERE (? IS NULL')) {
        return [...settlements.values()].filter(
          (s) => p[0] === null || s.status === String(p[0]),
        );
      }
      if (sql.includes('COALESCE(MAX(`id`), 0)')) {
        const ids = entries.filter((e) => e.agent_id === String(p[0])).map((e) => e.id);
        return [{ max_id: ids.length === 0 ? 0 : Math.max(...ids) }];
      }
      if (sql.includes('COALESCE(SUM(`commission_micro`), 0)')) {
        const rows = entries.filter(
          (e) => e.agent_id === String(p[0]) && e.id > Number(p[1]) && e.id <= Number(p[2]),
        );
        return [{ sum_micro: rows.reduce((s, e) => s + e.commission_micro, 0), cnt: rows.length }];
      }
      if (sql.includes('SELECT `id`, `commission_micro` FROM `agent_commission_entries`')) {
        return entries
          .filter((e) => e.agent_id === String(p[0]) && e.id > Number(p[1]) && e.id <= Number(p[2]))
          .sort((x, y) => x.id - y.id);
      }
      if (sql.startsWith('INSERT INTO `agent_settlements`')) {
        const id = nextId;
        nextId += 1;
        settlements.set(id, {
          id,
          settlement_no: String(p[0]),
          agent_id: String(p[1]),
          client_request_id: String(p[2]),
          status: 'pending',
          from_entry_id: Number(p[3]),
          to_entry_id: Number(p[4]),
          total_micro: Number(p[5]),
          total_coins: Number(p[6]),
          items_count: Number(p[7]),
          carry_before: Number(p[8]),
          carry_after: Number(p[9]),
          coin_per_yuan: Number(p[10]),
          payout_json: String(p[11]),
          min_yuan: Number(p[12]),
          items_hash: String(p[13]),
          requested_at: new Date('2026-10-26T00:00:00Z'),
          decided_at: null,
          decided_by: null,
          paid_at: null,
          paid_by: null,
          voucher_no: null,
          reject_reason: null,
        });
        return { insertId: id };
      }
      if (sql.startsWith('UPDATE `agent_settlements` SET `settlement_no`')) {
        const s = findById(Number(p[1]));
        if (s !== undefined) s.settlement_no = String(p[0]);
        return undefined;
      }
      if (sql.startsWith('UPDATE `agent_accounts` SET `pending_settlement_id`')) {
        agent.pending_settlement_id = p[0] === null ? null : Number(p[0]);
        return undefined;
      }
      if (sql.startsWith('UPDATE `agent_accounts` SET `settled_watermark`')) {
        agent.settled_watermark = Number(p[0]);
        agent.micro_carry = Number(p[1]);
        agent.pending_settlement_id = null;
        return undefined;
      }
      if (sql.startsWith("UPDATE `agent_settlements` SET `status` = 'paid'")) {
        const s = findById(Number(p[3]));
        if (s !== undefined) {
          s.status = 'paid';
          s.decided_by = String(p[0]);
          s.paid_by = String(p[1]);
          s.voucher_no = String(p[2]);
          s.paid_at = new Date();
        }
        return undefined;
      }
      if (sql.startsWith("UPDATE `agent_settlements` SET `status` = 'rejected'")) {
        const s = findById(Number(p[2]));
        if (s !== undefined) {
          s.status = 'rejected';
          s.decided_by = String(p[0]);
          s.reject_reason = String(p[1]);
        }
        return undefined;
      }
      if (sql.startsWith("UPDATE `agent_settlements` SET `status` = 'cancelled'")) {
        const s = findById(Number(p[1]));
        if (s !== undefined) s.status = 'cancelled';
        return undefined;
      }
      if (sql.includes('INSERT INTO `agent_admin_audit`')) return undefined;
      throw new Error(`fake settlement DB 未识别 SQL：${sql}`);
    },
  } as unknown as EntityManager;
  const dataSource = {
    transaction: async <T>(cb: (m: EntityManager) => Promise<T>) => cb(manager),
    query: (sql: string, params?: unknown[]) => manager.query(sql, params),
  };
  const settingsSvc = {
    get: vi.fn(async () => settings),
  } as unknown as AgentSettingsService;
  return { manager, dataSource, agent, entries, settlements, settingsSvc };
}

function makeService(db: ReturnType<typeof makeDb>) {
  return new AgentSettlementService(
    db.dataSource as unknown as DataSource,
    db.settingsSvc,
  );
}

describe('AgentSettlementService：申请/打款/驳回/撤回', () => {
  it('申请：水位 (0,2]、100 金币、hash；置 pending', async () => {
    const db = makeDb({ entries: [{ id: 1, micro: 600000 }, { id: 2, micro: 400000 }] });
    const svc = makeService(db);
    const s = await svc.create({ agentId: 'a', clientRequestId: 'req-1', actor: 'ag_a' });
    expect(s).toMatchObject({
      status: 'pending',
      fromEntryId: 0,
      toEntryId: 2,
      totalMicro: 1_000_000,
      totalCoins: 100,
      itemsCount: 2,
      carryBefore: 0,
      carryAfter: 0,
      coinPerYuan: 100,
      minYuan: 1,
    });
    expect(s.settlementNo).toMatch(/^AS\d{12}$/);
    expect(db.agent.pending_settlement_id).toBe(s.id);
    expect(s.itemsHash).toBe(
      computeItemsHash({
        agentId: 'a',
        fromEntryId: 0,
        toEntryId: 2,
        carryBefore: 0,
        totalMicro: 1_000_000,
        items: [
          { id: 1, micro: 600000 },
          { id: 2, micro: 400000 },
        ],
      }),
    );
  });

  it('carry 结转：carry 5000 + 5000 micro ⇒ 1 金币、carryAfter 0', async () => {
    const db = makeDb({
      agent: { micro_carry: 5000 },
      entries: [{ id: 1, micro: 5000 }],
      settings: { minYuan: 0 },
    });
    const svc = makeService(db);
    const s = await svc.create({ agentId: 'a', clientRequestId: 'req-1', actor: 'ag_a' });
    expect(s).toMatchObject({ carryBefore: 5000, totalCoins: 1, carryAfter: 0 });
  });

  it('无可结 / 未达最低额 ⇒ AGENT_SETTLEMENT_MIN', async () => {
    const empty = makeDb();
    await expect(
      makeService(empty).create({ agentId: 'a', clientRequestId: 'r', actor: 'ag_a' }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_SETTLEMENT_MIN });

    const tiny = makeDb({ entries: [{ id: 1, micro: 5000 }] });
    await expect(
      makeService(tiny).create({ agentId: 'a', clientRequestId: 'r', actor: 'ag_a' }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_SETTLEMENT_MIN });
  });

  it('pending 唯一；同 clientRequestId 重试返回原单（先于 pending 校验）', async () => {
    const db = makeDb({ entries: [{ id: 1, micro: 1_000_000 }] });
    const svc = makeService(db);
    const first = await svc.create({ agentId: 'a', clientRequestId: 'req-1', actor: 'ag_a' });
    await expect(
      svc.create({ agentId: 'a', clientRequestId: 'req-2', actor: 'ag_a' }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_SETTLEMENT_PENDING });
    await expect(
      svc.create({ agentId: 'a', clientRequestId: 'req-1', actor: 'ag_a' }),
    ).resolves.toMatchObject({ id: first.id, status: 'pending' });
  });

  it('缺少收款信息 ⇒ BAD_PARAM', async () => {
    const db = makeDb({
      agent: { payout_account: null },
      entries: [{ id: 1, micro: 1_000_000 }],
    });
    await expect(
      makeService(db).create({ agentId: 'a', clientRequestId: 'r', actor: 'ag_a' }),
    ).rejects.toThrow(/收款信息/);
  });

  it('打款：推进水位/carry、清 pending、paid + 凭证', async () => {
    const db = makeDb({ entries: [{ id: 1, micro: 600000 }, { id: 2, micro: 400000 }] });
    const svc = makeService(db);
    const s = await svc.create({ agentId: 'a', clientRequestId: 'r', actor: 'ag_a' });
    const paid = await svc.pay({ id: s.id, voucherNo: 'BANK-001', actor: 'finance' });
    expect(paid.status).toBe('paid');
    expect(paid.voucherNo).toBe('BANK-001');
    expect(db.agent.settled_watermark).toBe(2);
    expect(db.agent.pending_settlement_id).toBeNull();
  });

  it('打款时条目被改 ⇒ AGENT_SETTLEMENT_STATE（撤回重申请恢复）', async () => {
    const db = makeDb({ entries: [{ id: 1, micro: 1_000_000 }] });
    const svc = makeService(db);
    const s = await svc.create({ agentId: 'a', clientRequestId: 'r', actor: 'ag_a' });
    db.entries[0]!.commission_micro = 999_999;
    await expect(
      svc.pay({ id: s.id, voucherNo: 'BANK-001', actor: 'finance' }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_SETTLEMENT_STATE });
  });

  it('驳回：清 pending、状态 rejected、水位不动', async () => {
    const db = makeDb({ entries: [{ id: 1, micro: 1_000_000 }] });
    const svc = makeService(db);
    const s = await svc.create({ agentId: 'a', clientRequestId: 'r', actor: 'ag_a' });
    const rejected = await svc.reject({ id: s.id, reason: '信息有误', actor: 'finance' });
    expect(rejected.status).toBe('rejected');
    expect(db.agent.pending_settlement_id).toBeNull();
    expect(db.agent.settled_watermark).toBe(0);
  });

  it('代理撤回：只允许本人单；清 pending', async () => {
    const db = makeDb({ entries: [{ id: 1, micro: 1_000_000 }] });
    const svc = makeService(db);
    const s = await svc.create({ agentId: 'a', clientRequestId: 'r', actor: 'ag_a' });
    await expect(svc.cancel({ id: s.id, agentId: 'b', actor: 'ag_b' })).rejects.toThrow(/不存在/);
    const cancelled = await svc.cancel({ id: s.id, agentId: 'a', actor: 'ag_a' });
    expect(cancelled.status).toBe('cancelled');
    expect(db.agent.pending_settlement_id).toBeNull();
  });
});
