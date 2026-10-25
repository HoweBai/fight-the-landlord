import { describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AgentBindingsService } from '../src/agent/agent-bindings.service';
import type { AgentInviteService } from '../src/agent/agent-invite.service';
import type { AgentSettingsService } from '../src/agent/agent-settings.service';
import { hmacPhone } from '../src/agent/agent.util';

interface BindRow {
  agent_id: string;
  phone_hash: string;
  phone_masked: string;
  source: string;
  bound_at: Date;
}

function makeDb(initial: Record<string, BindRow> = {}, agentStatus = 'active') {
  const bindings = new Map(Object.entries(initial));
  const history: Array<Record<string, unknown>> = [];
  const audit: Array<Record<string, unknown>> = [];
  const manager = {
    query: async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      if (sql.includes('FROM `agent_accounts` WHERE `id`')) {
        return [{ status: agentStatus }];
      }
      if (sql.includes('INSERT IGNORE INTO `agent_bindings`')) {
        const owner = String(p[0]);
        if (bindings.has(owner)) return { affectedRows: 0 };
        bindings.set(owner, {
          agent_id: String(p[1]),
          phone_hash: String(p[2]),
          phone_masked: String(p[3]),
          source: 'signup',
          bound_at: new Date('2026-10-26T00:00:00Z'),
        });
        return { affectedRows: 1 };
      }
      if (sql.startsWith('DELETE FROM `agent_bindings`')) {
        return { affectedRows: bindings.delete(String(p[0])) ? 1 : 0 };
      }
      if (sql.includes('FROM `agent_bindings` WHERE `owner_id`')) {
        const row = bindings.get(String(p[0]));
        return row === undefined ? [] : [{ ...row, agent_id: row.agent_id }];
      }
      if (sql.startsWith('UPDATE `agent_bindings` SET `agent_id` = ?')) {
        if (sql.includes('`phone_hash` = ?')) {
          // 单玩家改绑：params = [agentId, actor, phoneHash, phoneMasked, ownerId]
          const owner = String(p[4]);
          const row = bindings.get(owner);
          if (row === undefined) return { affectedRows: 0 };
          bindings.set(owner, {
            ...row,
            agent_id: String(p[0]),
            phone_hash: String(p[2]),
            phone_masked: String(p[3]),
            source: 'admin',
          });
          return { affectedRows: 1 };
        }
        // 批量改绑：params = [agentId, actor, ownerId]
        const owner = String(p[2]);
        const row = bindings.get(owner);
        if (row === undefined) return { affectedRows: 0 };
        bindings.set(owner, { ...row, agent_id: String(p[0]), source: 'admin' });
        return { affectedRows: 1 };
      }
      if (sql.startsWith('DELETE FROM `agent_bindings`')) {
        return { affectedRows: bindings.delete(String(p[0])) ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO `agent_binding_history`')) {        history.push({ owner: p[0], agent: p[1], action: p[2], actor: p[3], reason: p[4] });
        return undefined;
      }
      if (sql.includes('INSERT INTO `agent_admin_audit`')) {
        audit.push({ actor: p[0], action: p[1], target: p[3] });
        return undefined;
      }
      if (sql.includes('SELECT COUNT(*) AS `cnt` FROM `agent_bindings`')) {
        let n = 0;
        for (const r of bindings.values()) if (r.agent_id === String(p[0])) n += 1;
        return [{ cnt: n }];
      }
      if (sql.includes('SELECT `owner_id` FROM `agent_bindings` WHERE `agent_id`')) {
        const from = String(p[0]);
        const last = String(p[1]);
        return [...bindings.entries()]
          .filter(([owner, r]) => r.agent_id === from && owner > last)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .slice(0, 500)
          .map(([owner]) => ({ owner_id: owner }));
      }
      if (sql.includes('UPDATE `agent_bindings` SET `agent_id` = ?')) {
        return { affectedRows: 1 };
      }
      if (sql.includes('FROM `agent_bindings` WHERE `agent_id`')) {
        return [...bindings.entries()]
          .filter(([, r]) => r.agent_id === String(p[0]))
          .map(([owner, r]) => ({ owner_id: owner, bound_at: r.bound_at, source: r.source }));
      }
      throw new Error(`fake DB 未识别 SQL：${sql}`);
    },
  } as unknown as EntityManager;
  const dataSource = {
    transaction: async <T>(cb: (m: EntityManager) => Promise<T>) => cb(manager),
    query: (sql: string, params?: unknown[]) => manager.query(sql, params),
  };
  return { manager, dataSource, bindings, history, audit };
}

function makeService(
  db: ReturnType<typeof makeDb>,
  opts: { enabled?: boolean; inviteEnabled?: boolean; resolved?: unknown } = {},
) {
  const settings = {
    getOrDefault: vi.fn(async () => ({
      enabled: opts.enabled ?? true,
      effectiveFrom: new Date('2026-10-01T00:00:00Z'),
      defaultRateBp: 0,
      minSettlementYuan: 100,
      coinPerYuan: 100,
      quotaHoldDays: 0,
      quotaAdminAdjustDailyLimitCoins: 50000,
      adjustMaxYuanPerOp: 10000,
      adjustMaxYuanPerDay: 20000,
    })),
  } as unknown as AgentSettingsService;
  const config = { agentInviteEnabled: () => opts.inviteEnabled ?? true } as never;
  const invite = {
    resolve: vi.fn(async () =>
      opts.resolved === undefined
        ? { agentId: 'a', agentName: '代理甲', status: 'active' }
        : opts.resolved,
    ),
  } as unknown as AgentInviteService;
  const svc = new AgentBindingsService(
    db.dataSource as unknown as DataSource,
    settings,
    config,
    invite,
  );
  return { svc, invite };
}

describe('AgentBindingsService：注册绑定', () => {
  it('两个开关都开 ⇒ bound；写 history；phone_hash = hmac(trim(phone))', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    const res = await svc.bindFromSignup({ ownerId: 'u1', code: ' abcd2345 ', phone: ' 13800000000 ' });
    expect(res).toEqual({ status: 'bound' });
    expect(db.bindings.get('u1')!.agent_id).toBe('a');
    expect(db.bindings.get('u1')!.phone_hash).toBe(hmacPhone('13800000000'));
    expect(db.history).toEqual([{ owner: 'u1', agent: 'a', action: 'bind', actor: 'signup', reason: null }]);
  });

  it('settings 关闭 / 邀请码开关关闭 ⇒ ignored（不做任何写入）', async () => {
    for (const opts of [{ enabled: false }, { inviteEnabled: false }]) {
      const db = makeDb();
      const { svc, invite } = makeService(db, opts);
      await expect(
        svc.bindFromSignup({ ownerId: 'u1', code: 'ABCD2345', phone: '13800000000' }),
      ).resolves.toEqual({ status: 'ignored' });
      expect(db.bindings.size).toBe(0);
      expect(invite.resolve).not.toHaveBeenCalled();
    }
  });

  it('码无效 / 代理冻结 ⇒ AGENT_INVITE_INVALID', async () => {
    for (const resolved of [null, { agentId: 'a', agentName: 'A', status: 'frozen' }]) {
      const db = makeDb();
      const { svc } = makeService(db, { resolved });
      await expect(
        svc.bindFromSignup({ ownerId: 'u1', code: 'BAD', phone: '13800000000' }),
      ).rejects.toMatchObject({ code: ErrCode.AGENT_INVITE_INVALID });
      expect(db.bindings.size).toBe(0);
    }
  });

  it('已有绑定 ⇒ already_bound（首绑为准，不覆盖）', async () => {
    const db = makeDb({
      u1: { agent_id: 'old', phone_hash: 'x', phone_masked: '138****0000', source: 'signup', bound_at: new Date() },
    });
    const { svc } = makeService(db);
    await expect(
      svc.bindFromSignup({ ownerId: 'u1', code: 'ABCD2345', phone: '13800000000' }),
    ).resolves.toEqual({ status: 'already_bound' });
    expect(db.bindings.get('u1')!.agent_id).toBe('old');
  });
});

describe('AgentBindingsService：管理改绑/解绑/批量', () => {
  it('改绑：更新 agent + history + audit', async () => {
    const db = makeDb({
      u1: { agent_id: 'old', phone_hash: 'x', phone_masked: '138****0000', source: 'signup', bound_at: new Date() },
    });
    const { svc } = makeService(db);
    const res = await svc.rebind({ ownerId: 'u1', agentId: 'new', phone: '13800000001', actor: 'admin', reason: '纠错' });
    expect(res).toEqual({ action: 'rebind' });
    expect(db.bindings.get('u1')!.agent_id).toBe('new');
    expect(db.bindings.get('u1')!.phone_hash).toBe(hmacPhone('13800000001'));
    expect(db.history.some((h) => h.action === 'rebind')).toBe(true);
    expect(db.audit.some((a) => a.action === 'agent.binding.rebind')).toBe(true);
  });

  it('目标代理冻结 ⇒ 拒绝', async () => {
    const db = makeDb({}, 'frozen');
    const { svc } = makeService(db);
    await expect(
      svc.rebind({ ownerId: 'u1', agentId: 'new', phone: '13800000001', actor: 'admin', reason: 'x' }),
    ).rejects.toThrow(/冻结/);
  });

  it('解绑：删除 + history；无绑定 ⇒ 拒绝', async () => {
    const db = makeDb({
      u1: { agent_id: 'old', phone_hash: 'x', phone_masked: '138****0000', source: 'signup', bound_at: new Date() },
    });
    const { svc } = makeService(db);
    await svc.unbind({ ownerId: 'u1', actor: 'admin', reason: '离职' });
    expect(db.bindings.has('u1')).toBe(false);
    expect(db.history.some((h) => h.action === 'unbind')).toBe(true);
    await expect(svc.unbind({ ownerId: 'u1', actor: 'admin', reason: 'x' })).rejects.toThrow(/没有绑定/);
  });

  it('批量改绑：dryRun 返回人数；执行后搬移并写 history/audit', async () => {
    const db = makeDb({
      u1: { agent_id: 'from', phone_hash: 'x', phone_masked: '138****0000', source: 'signup', bound_at: new Date() },
      u2: { agent_id: 'from', phone_hash: 'y', phone_masked: '138****0001', source: 'signup', bound_at: new Date() },
    });
    const { svc } = makeService(db);
    await expect(
      svc.bulkRebind({ fromAgentId: 'from', toAgentId: 'to', dryRun: true, actor: 'admin', reason: 'r' }),
    ).resolves.toEqual({ moved: 2, dryRun: true });
    await expect(
      svc.bulkRebind({ fromAgentId: 'from', toAgentId: 'to', dryRun: false, actor: 'admin', reason: 'r' }),
    ).resolves.toEqual({ moved: 2, dryRun: false });
    expect([...db.bindings.values()].every((b) => b.agent_id === 'to')).toBe(true);
    expect(db.history.filter((h) => h.action === 'rebind')).toHaveLength(2);
    expect(db.audit.some((a) => a.action === 'agent.binding.bulk_rebind')).toBe(true);
  });

  it('批量改绑：源=目标 拒绝', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    await expect(
      svc.bulkRebind({ fromAgentId: 'a', toAgentId: 'a', dryRun: true, actor: 'admin', reason: 'r' }),
    ).rejects.toThrow(/不能相同/);
  });
});
