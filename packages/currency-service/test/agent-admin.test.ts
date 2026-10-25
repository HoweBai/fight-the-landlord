import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { AgentAdminController } from '../src/agent/agent-admin.controller';
import type { AdminRequest } from '../src/http/x-admin.guard';

const req: AdminRequest = { headers: {}, method: 'POST', adminActor: 'admin1' };

async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (err) {
    return err instanceof HttpException ? err.getStatus() : -1;
  }
}

function makeController() {
  const accounts = {
    list: vi.fn(async () => ({ rows: [], total: 0 })),
    create: vi.fn(async () => ({ account: { id: 'ag_1' }, initialPassword: 'p', inviteCode: 'CODE1234' })),
    tree: vi.fn(async () => []),
    auditList: vi.fn(async () => []),
    get: vi.fn(async () => ({ account: { id: 'ag_1' }, children: 0, bindings: 0 })),
    update: vi.fn(async () => ({ id: 'ag_1' })),
    setStatus: vi.fn(async () => ({ id: 'ag_1', status: 'frozen' })),
    resetPassword: vi.fn(async () => ({ password: 'newpass1234' })),
    rotateInviteCode: vi.fn(async () => ({ code: 'NEWCODE1' })),
    updatePayout: vi.fn(async () => ({ id: 'ag_1' })),
  };
  const bindings = {
    rebind: vi.fn(async () => ({ action: 'rebind' })),
    unbind: vi.fn(async () => undefined),
    listByAgent: vi.fn(async () => []),
    bulkRebind: vi.fn(async () => ({ moved: 2, dryRun: false })),
  };
  const settings = {
    getOrDefault: vi.fn(async () => ({ enabled: false })),
    update: vi.fn(async () => ({ enabled: true })),
  };
  const settlements = {
    listQueue: vi.fn(async () => []),
    getById: vi.fn(async () => ({ id: 1, agentId: 'ag_1' })),
    lines: vi.fn(async () => []),
    pay: vi.fn(async () => ({ id: 1, status: 'paid' })),
    reject: vi.fn(async () => ({ id: 1, status: 'rejected' })),
  };
  const adjustments = {
    create: vi.fn(async () => ({ id: 1, status: 'pending' })),
    list: vi.fn(async () => []),
    approve: vi.fn(async () => ({ id: 1, status: 'approved' })),
    reject: vi.fn(async () => ({ id: 1, status: 'rejected' })),
  };
  const users = {
    profile: vi.fn(
      async (): Promise<{ userId: string; nickname: string | null; phone: string | null }> => ({
        userId: 'u1',
        nickname: '小明',
        phone: '13800000000',
      }),
    ),
  };
  const reconcile = { summary: vi.fn(async () => ({ entryFeeTotal: 0 })) };
  const ctl = new AgentAdminController(
    accounts as never,
    bindings as never,
    settings as never,
    settlements as never,
    adjustments as never,
    users as never,
    reconcile as never,
  );
  return { ctl, accounts, bindings, settings, settlements, adjustments, users, reconcile };
}

describe('AgentAdminController', () => {
  it('列表 status 非法 ⇒ 400；合法值透传', async () => {
    const { ctl, accounts } = makeController();
    expect(await statusOf(() => ctl.listAgents({ status: 'paused' }))).toBe(400);
    await ctl.listAgents({ status: 'frozen', page: '1', pageSize: '10' });
    expect(accounts.list).toHaveBeenCalledWith({ status: 'frozen', q: undefined, page: 1, pageSize: 10 });
  });

  it('创建代理：解析 body、actor；rateBp 字符串转数字', async () => {
    const { ctl, accounts } = makeController();
    const res = await ctl.createAgent(req, {
      name: ' 总代 ',
      phone: '13800000001',
      rateBp: '8000',
      parentId: null,
    });
    expect(res.data).toMatchObject({ account: { id: 'ag_1' }, inviteCode: 'CODE1234' });
    expect(accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: '总代', phone: '13800000001', rateBp: 8000, parentId: null }),
      'admin1',
    );
  });

  it('设置更新：boolean/非负整数校验；actor + reason', async () => {
    const { ctl, settings } = makeController();
    expect(await statusOf(() => ctl.updateSettings(req, { enabled: 'true' }))).toBe(400);
    expect(await statusOf(() => ctl.updateSettings(req, { defaultRateBp: -1 }))).toBe(400);
    await ctl.updateSettings(req, { enabled: true, defaultRateBp: 5000, reason: '上线' });
    expect(settings.update).toHaveBeenCalledWith(
      { enabled: true, defaultRateBp: 5000 },
      'admin1',
      '上线',
    );
  });

  it('绑定：服务端取玩家手机号；缺手机号 ⇒ 400', async () => {
    const { ctl, bindings, users } = makeController();
    await ctl.bind(req, { ownerId: 'u1', agentId: 'ag_1', reason: '补绑' });
    expect(bindings.rebind).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'u1', agentId: 'ag_1', phone: '13800000000', actor: 'admin1' }),
    );

    users.profile.mockResolvedValueOnce({ userId: 'u2', nickname: null, phone: null });
    expect(await statusOf(() => ctl.bind(req, { ownerId: 'u2', agentId: 'ag_1' }))).toBe(400);
  });

  it('结算打款：凭证必填；合法透传 actor', async () => {
    const { ctl, settlements } = makeController();
    expect(await statusOf(() => ctl.paySettlement(req, '1', {}))).toBe(400);
    await ctl.paySettlement(req, '1', { voucherNo: 'BANK-1', remark: '已转' });
    expect(settlements.pay).toHaveBeenCalledWith({
      id: 1,
      voucherNo: 'BANK-1',
      actor: 'admin1',
      reason: '已转',
    });
  });

  it('调账：deltaCoins 必须整数；requestedBy = actor', async () => {
    const { ctl, adjustments } = makeController();
    expect(await statusOf(() => ctl.createAdjustment(req, 'ag_1', { deltaCoins: 1.5 }))).toBe(400);
    await ctl.createAdjustment(req, 'ag_1', { deltaCoins: -5, reason: '扣回' });
    expect(adjustments.create).toHaveBeenCalledWith({
      agentId: 'ag_1',
      deltaCoins: -5,
      reason: '扣回',
      requestedBy: 'admin1',
    });
  });

  it('对账：非法日期 ⇒ 400；默认近 7 天', async () => {
    const { ctl, reconcile } = makeController();
    expect(await statusOf(() => ctl.reconciliation({ from: 'not-a-date' }))).toBe(400);
    await ctl.reconciliation({});
    expect(reconcile.summary).toHaveBeenCalledTimes(1);
  });

  it('批量改绑：dryRun 透传；上限常量传入', async () => {
    const { ctl, bindings } = makeController();
    await ctl.bulkRebind(req, 'from', { toAgentId: 'to', dryRun: true, reason: '合并' });
    expect(bindings.bulkRebind).toHaveBeenCalledWith(
      expect.objectContaining({ fromAgentId: 'from', toAgentId: 'to', dryRun: true, actor: 'admin1' }),
    );
  });
});
