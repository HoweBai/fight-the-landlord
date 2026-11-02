import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AgentPortalService } from '../src/agent/agent-portal.service';
import type { AgentInviteService } from '../src/agent/agent-invite.service';
import type { AgentSettingsService } from '../src/agent/agent-settings.service';
import type { AgentSettlementService } from '../src/agent/agent-settlement.service';
import type { AgentUserClient } from '../src/agent/agent-user.client';

const AGENT_ROW = {
  id: 'ag_1',
  name: '代理甲',
  phone: '13800000000',
  rate_bp: 8000,
  status: 'active',
  region: '华东',
  contact_name: '张三',
  payout_name: '张三',
  payout_account: '6222000011112222',
  payout_bank: '招商银行',
  micro_carry: 5000,
  settled_watermark: 4,
};

function makeDb(opts: {
  agentRow?: Record<string, unknown>;
  agentStatus?: string;
  activeCount?: number;
  dailyCount?: number;
  inviteCodes?: Array<Record<string, unknown>>;
  unsettledMicro?: number;
  players?: Array<Record<string, unknown>>;
  revenue?: Array<Record<string, unknown>>;
  playerCommission?: Array<Record<string, unknown>>;
  quota?: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, unknown>>;
  commissions?: Array<Record<string, unknown>>;
} = {}) {
  const inviteCodes = opts.inviteCodes ?? [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    void params;
    // 递归 CTE 也包含 `FROM agent_accounts WHERE id = ?`，必须先于单行查询匹配。
    if (sql.includes('WITH RECURSIVE _sub')) return [];
    if (sql.includes('FROM `agent_accounts` WHERE `id` = ?')) {
      return [{ ...(opts.agentRow ?? AGENT_ROW), status: opts.agentStatus ?? 'active' }];
    }
    if (sql.includes('COUNT(*) AS `cnt` FROM `agent_invite_codes`')) {
      if (sql.includes('CURDATE()')) return [{ cnt: opts.dailyCount ?? 0 }];
      return [{ cnt: opts.activeCount ?? 0 }];
    }
    if (sql.includes('FROM `agent_invite_codes` WHERE `agent_id` = ? AND `code` = ?')) {
      const code = String(params?.[1] ?? '');
      return inviteCodes.filter((r) => String(r.code) === code);
    }
    if (sql.includes('FROM `agent_invite_codes`')) {
      return inviteCodes;
    }
    if (sql.includes('FROM `agent_bindings` WHERE `owner_id` IN')) return opts.bindings ?? [];
    if (sql.includes('COUNT(*) AS `cnt` FROM `agent_bindings`')) return [{ cnt: 2 }];
    if (sql.includes('COUNT(DISTINCT `owner_id`)')) return [{ cnt: 1 }];
    if (sql.includes('FROM `agent_bindings` WHERE `agent_id` = ?')) return opts.players ?? [];
    if (sql.includes('FROM `agent_revenue_events` WHERE `agent_id` = ? AND `owner_id` IN')) {
      return opts.revenue ?? [];
    }
    if (sql.includes('FROM `agent_commission_entries` WHERE `agent_id` = ? AND `level` = 0')) {
      return opts.playerCommission ?? [];
    }
    if (sql.includes('FROM `agent_player_quota` WHERE `owner_id` IN')) return opts.quota ?? [];
    if (sql.includes('FROM `agent_commission_entries` WHERE `agent_id` = ? ORDER BY')) {
      return opts.commissions ?? [];
    }
    if (sql.includes('SUM(`fee_amount`)') && sql.includes('FROM `agent_revenue_events`')) {
      return [{ fee: 100, base: 80 }];
    }
    if (sql.includes('SUM(`total_coins`)')) return [{ coins: 50 }];
    if (sql.includes('SUM(`commission_micro`)') && sql.includes('`level` > 0')) return [{ micro: 2000 }];
    if (sql.includes('SUM(`commission_micro`)') && sql.includes('`id` > ?')) {
      return [{ micro: opts.unsettledMicro ?? 6000 }];
    }
    if (sql.includes('SUM(`commission_micro`)')) return [{ micro: 9000 }];
    if (sql.includes('WITH RECURSIVE _sub')) return [];
    throw new Error(`fake portal DB 未识别 SQL：${sql.slice(0, 80)}`);
  });
  const dataSource = {
    query,
    transaction: async <T>(cb: (m: { query: typeof query }) => Promise<T>) => cb({ query }),
  };
  return dataSource;
}

function makeService(
  db: ReturnType<typeof makeDb>,
  nicknamesOk = true,
  opts: {
    inviteEnabled?: boolean;
    settingsEnabled?: boolean;
    required?: boolean;
    hasSnapshot?: boolean;
  } = {},
) {
  const invite = {
    activeCode: vi.fn(async () => 'CODE1234'),
    createMany: vi.fn(async (_m: unknown, _agentId: string, count: number) =>
      Array.from({ length: count }, (_, i) => `CODE${String(i).padStart(4, '0')}`),
    ),
  } as unknown as AgentInviteService;
  const settings = {
    getOrDefault: vi.fn(async () => ({ enabled: opts.settingsEnabled ?? true })),
  } as unknown as AgentSettingsService;
  const config = {
    hasSnapshot: () => opts.hasSnapshot ?? true,
    agentInviteEnabled: () => opts.inviteEnabled ?? true,
    agentInviteRequired: () => opts.required ?? false,
  } as never;
  const settlements = {} as unknown as AgentSettlementService;
  const users = {
    nicknames: vi.fn(async (ids: string[]) => {
      if (!nicknamesOk) throw new Error('user down');
      return ids.map((id) => ({ userId: id, nickname: id === 'u1' ? '小明' : null }));
    }),
  } as unknown as AgentUserClient;
  return new AgentPortalService(
    db as unknown as DataSource,
    invite,
    settings,
    config,
    settlements,
    users,
  );
}

describe('AgentPortalService：可见性/脱敏/级差隐藏', () => {
  it('profile：手机号与收款账号脱敏 + 邀请码状态 flags', async () => {
    const svc = makeService(makeDb({ activeCount: 3 }));
    const p = await svc.profile('ag_1');
    expect(p).toMatchObject({
      id: 'ag_1',
      name: '代理甲',
      phoneMasked: '138****0000',
      rateBp: 8000,
      inviteCode: 'CODE1234',
      inviteCodesActive: 3,
      inviteEnabled: true,
      settingsEnabled: true,
      required: false,
      payout: { name: '张三', accountMasked: '****2222', bank: '招商银行' },
    });
  });

  it('profile：required 需要 enabled && required && 快照可用；任一关闭 ⇒ false', async () => {
    expect((await makeService(makeDb(), true, { required: true }).profile('ag_1')).required).toBe(true);
    expect((await makeService(makeDb(), true, { required: true, inviteEnabled: false }).profile('ag_1')).required).toBe(false);
    expect((await makeService(makeDb(), true, { required: true, hasSnapshot: false }).profile('ag_1')).required).toBe(false);
    expect((await makeService(makeDb(), true, { required: true, settingsEnabled: false }).profile('ag_1')).settingsEnabled).toBe(false);
  });

  it('generate：冻结/功能关闭/count 非法/超日限拒绝；成功返回 N 枚', async () => {
    const frozen = makeDb({ agentStatus: 'frozen' });
    await expect(makeService(frozen).generateInviteCodes('ag_1', 5)).rejects.toMatchObject({
      code: ErrCode.AGENT_FROZEN,
    });

    await expect(
      makeService(makeDb(), true, { inviteEnabled: false }).generateInviteCodes('ag_1', 5),
    ).rejects.toMatchObject({ code: ErrCode.FORBIDDEN });

    const svc = makeService(makeDb());
    await expect(svc.generateInviteCodes('ag_1', 0)).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    await expect(svc.generateInviteCodes('ag_1', 51)).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });

    await expect(
      makeService(makeDb({ dailyCount: 196 })).generateInviteCodes('ag_1', 5),
    ).rejects.toMatchObject({ code: ErrCode.BAD_PARAM, message: '今日生成数量已达上限' });

    const ok = await makeService(makeDb({ dailyCount: 0 })).generateInviteCodes('ag_1', 3);
    expect(ok.codes).toEqual(['CODE0000', 'CODE0001', 'CODE0002']);
  });

  it('generate：代理模块关闭 ⇒ FORBIDDEN', async () => {
    await expect(
      makeService(makeDb(), true, { settingsEnabled: false }).generateInviteCodes('ag_1', 1),
    ).rejects.toMatchObject({ code: ErrCode.FORBIDDEN });
  });

  it('list：status/cursor/limit；nextCursor 按 (created_at, code)', async () => {
    const db = makeDb({
      inviteCodes: [
        { code: 'CODE0003', status: 'active', created_at: new Date('2026-11-03T00:00:03Z'), used_at: null },
        { code: 'CODE0002', status: 'used', created_at: new Date('2026-11-03T00:00:02Z'), used_at: new Date('2026-11-03T01:00:00Z') },
        { code: 'CODE0001', status: 'revoked', created_at: new Date('2026-11-03T00:00:01Z'), used_at: null },
      ],
    });
    const svc = makeService(db);
    const page = await svc.listInviteCodes('ag_1', undefined, undefined, 2);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[1]).toMatchObject({
      code: 'CODE0002',
      status: 'used',
      usedAt: new Date('2026-11-03T01:00:00Z'),
    });
    expect(page.nextCursor).toBe('CODE0002');
  });

  it('players：昵称/脱敏手机/局数/台费/剩余额度/佣金；昵称失败降级 null', async () => {
    const db = makeDb({
      players: [
        { owner_id: 'u1', phone_masked: '139****0001', bound_at: new Date('2026-10-01') },
        { owner_id: 'u2', phone_masked: '139****0002', bound_at: new Date('2026-10-02') },
      ],
      revenue: [{ owner_id: 'u1', cnt: 3, fee: 30, base: 20 }],
      playerCommission: [{ owner_id: 'u1', micro: 8000 }],
      quota: [{ owner_id: 'u1', inflow_total: 100, consumed_total: 50 }],
      bindings: [
        { owner_id: 'u1', phone_masked: '139****0001' },
        { owner_id: 'u2', phone_masked: '139****0002' },
      ],
    });
    const rows = await makeService(db).players('ag_1', 0, 20);
    expect(rows[0]).toMatchObject({
      ownerId: 'u1',
      nickname: '小明',
      phoneMasked: '139****0001',
      games: 3,
      feeAmount: 30,
      baseAmount: 20,
      remainingQuota: 50,
      commissionMicro: 8000,
    });
    expect(rows[1]).toMatchObject({ ownerId: 'u2', nickname: null, remainingQuota: 0 });

    const down = await makeService(db, false).players('ag_1', 0, 20);
    expect(down[0]!.nickname).toBeNull();
  });

  it('commissions：level 0 显示玩家；level>0 与 manual 隐藏身份；settled 按水位', async () => {
    const db = makeDb({
      commissions: [
        { id: 5, owner_id: 'u1', level: 0, rate_bp: 6000, paid_bp: 6000, commission_micro: 6000, kind: 'entry', reason: null, created_at: new Date() },
        { id: 4, owner_id: 'u1', level: 1, rate_bp: 8000, paid_bp: 2000, commission_micro: 2000, kind: 'entry', reason: null, created_at: new Date() },
        { id: 3, owner_id: null, level: 0, rate_bp: 0, paid_bp: 0, commission_micro: -1000, kind: 'manual', reason: '扣回', created_at: new Date() },
      ],
      bindings: [{ owner_id: 'u1', phone_masked: '139****0001' }],
    });
    const rows = await makeService(db).commissions('ag_1', 0, 20);
    expect(rows[0]).toMatchObject({
      level: 0,
      ownerId: 'u1',
      nickname: '小明',
      phoneMasked: '139****0001',
      settled: false,
    });
    expect(rows[1]).toMatchObject({ level: 1, ownerId: null, nickname: null, phoneMasked: null, settled: true });
    expect(rows[2]).toMatchObject({ level: 0, ownerId: null, kind: 'manual', settled: true });
  });

  it('overview：直接玩家/活跃/台费/佣金/未结/已付/级差/子树', async () => {
    const svc = makeService(makeDb());
    const o = await svc.overview('ag_1');
    expect(o).toMatchObject({
      directPlayers: 2,
      activePlayers30d: 1,
      grossFeeAmount: 100,
      baseAmount: 80,
      commissionMicro: 9000,
      unsettledMicro: 6000,
      carryMicro: 5000,
      unsettledCoins: 1,
      paidCoins: 50,
      overrideMicro: 2000,
      subtree: null,
    });
  });

  it('overview：负 carry + 未结 0 ⇒ unsettledCoins = 0（不显示 -1；r3 Minor #6）', async () => {
    const svc = makeService(
      makeDb({ agentRow: { ...AGENT_ROW, micro_carry: -5000 }, unsettledMicro: 0 }),
    );
    const o = await svc.overview('ag_1');
    expect(o.carryMicro).toBe(-5000);
    expect(o.unsettledCoins).toBe(0);
  });
});
