import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AgentInviteService, normalizeInviteCode } from '../src/agent/agent-invite.service';

function fakeManager(opts: {
  resolveRow?: Record<string, unknown> | null;
  dupFirst?: boolean;
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let inserts = 0;
  const manager = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes('JOIN `agent_accounts`')) {
        return opts.resolveRow === undefined || opts.resolveRow === null ? [] : [opts.resolveRow];
      }
      if (sql.startsWith('INSERT INTO `agent_invite_codes`')) {
        inserts += 1;
        if (opts.dupFirst === true && inserts === 1) {
          throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', errno: 1062 });
        }
        return { affectedRows: 1 };
      }
      if (sql.startsWith('UPDATE `agent_invite_codes`')) return { affectedRows: 1 };
      return undefined;
    },
  } as unknown as EntityManager;
  return { manager, calls };
}

describe('AgentInviteService', () => {
  it('码形：8 字符、去掉 I/O/0/1、大写', () => {
    const svc = new AgentInviteService({} as never);
    for (let i = 0; i < 50; i += 1) {
      expect(svc.generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    }
    expect(normalizeInviteCode('  abcd2345 ')).toBe('ABCD2345');
  });

  it('resolve：命中 active/冻结都返回（调用方判状态）；未知 null；code 归一', async () => {
    const { manager, calls } = fakeManager({
      resolveRow: { agent_id: 'ag_1', name: '代理甲', status: 'active' },
    });
    const svc = new AgentInviteService({} as never);
    const r = await svc.resolve(manager, ' abcd2345 ');
    expect(r).toEqual({ agentId: 'ag_1', agentName: '代理甲', status: 'active' });
    expect(calls[0]!.params[0]).toBe('ABCD2345');

    const miss = fakeManager({ resolveRow: null });
    expect(await svc.resolve(miss.manager, 'ZZZZZZZZ')).toBeNull();
  });

  it('rotate：先 revoke 旧 active，再插入新码（调用方负责锁 agent 行）', async () => {
    const { manager, calls } = fakeManager();
    const svc = new AgentInviteService({} as never);
    const code = await svc.rotate(manager, 'ag_1');
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(calls.some((c) => c.sql.startsWith('UPDATE `agent_invite_codes`'))).toBe(true);
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO `agent_invite_codes`'))).toBe(true);
  });

  it('createFor 撞码重试：第一次 dup、第二次成功', async () => {
    const { manager } = fakeManager({ dupFirst: true });
    const svc = new AgentInviteService({} as never);
    const spy = vi
      .spyOn(svc, 'generateCode')
      .mockReturnValueOnce('AAAAAAAA')
      .mockReturnValueOnce('BBBBBBBB');
    const code = await svc.createFor(manager, 'ag_1');
    expect(code).toBe('BBBBBBBB');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('activeCode：无行 ⇒ null', async () => {
    const svc = new AgentInviteService({ query: async () => [] } as never);
    expect(await svc.activeCode('ag_1')).toBeNull();
  });
});
