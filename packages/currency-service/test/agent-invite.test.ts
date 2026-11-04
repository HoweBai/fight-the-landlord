import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AgentInviteService, normalizeInviteCode } from '../src/agent/agent-invite.service';

function fakeManager(opts: {
  resolveRow?: Record<string, unknown> | null;
  dupFirst?: boolean;
  revokeAffected?: number;
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
      if (sql.startsWith('UPDATE `agent_invite_codes`')) {
        return { affectedRows: opts.revokeAffected ?? 1 };
      }
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

  it('resolve：返回 codeStatus + agentStatus（不预先过滤 code status）；未知 null；code 归一', async () => {
    const { manager, calls } = fakeManager({
      resolveRow: { agent_id: 'ag_1', name: '代理甲', agent_status: 'active', code_status: 'used' },
    });
    const svc = new AgentInviteService({} as never);
    const r = await svc.resolve(manager, ' abcd2345 ');
    expect(r).toEqual({
      agentId: 'ag_1',
      agentName: '代理甲',
      agentStatus: 'active',
      codeStatus: 'used',
    });
    expect(calls[0]!.sql).not.toContain("c.status = 'active'");
    expect(calls[0]!.params[0]).toBe('ABCD2345');

    const miss = fakeManager({ resolveRow: null });
    expect(await svc.resolve(miss.manager, 'ZZZZZZZZ')).toBeNull();
  });

  it('rotate：先 revoke 全部 active，再插入新码；返回 {code, revoked}', async () => {
    const { manager, calls } = fakeManager();
    const svc = new AgentInviteService({} as never);
    const r = await svc.rotate(manager, 'ag_1');
    expect(r.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(r.revoked).toBe(1);
    const update = calls.find((c) => c.sql.startsWith('UPDATE `agent_invite_codes`'))!;
    expect(update.sql).toContain("SET `status` = 'revoked'");
    expect(update.sql).toContain("`status` = 'active'");
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO `agent_invite_codes`'))).toBe(true);
  });

  it('rotate：无 active 时 revoked=0，仍插入新码', async () => {
    const { manager } = fakeManager({ revokeAffected: 0 });
    const svc = new AgentInviteService({} as never);
    const r = await svc.rotate(manager, 'ag_1');
    expect(r.revoked).toBe(0);
    expect(r.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it('createMany：一次生成 N 枚，逐枚 createFor', async () => {
    const { manager } = fakeManager();
    const svc = new AgentInviteService({} as never);
    const spy = vi
      .spyOn(svc, 'createFor')
      .mockResolvedValueOnce('AAAAAAAA')
      .mockResolvedValueOnce('BBBBBBBB');
    await expect(svc.createMany(manager, 'ag_1', 2)).resolves.toEqual(['AAAAAAAA', 'BBBBBBBB']);
    expect(spy).toHaveBeenCalledTimes(2);
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

  it('activeCode：无行 ⇒ null；SQL 带 (created_at, code) 倒序兜底', async () => {
    let sql = '';
    const svc = new AgentInviteService({
      query: async (s: string) => {
        sql = s;
        return [];
      },
    } as never);
    expect(await svc.activeCode('ag_1')).toBeNull();
    expect(sql).toContain('ORDER BY `created_at` DESC, `code` DESC');
  });
});
