import { describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  AGENT_JWT_AUDIENCE,
  AGENT_JWT_SECRET_FALLBACK,
  AgentAuthService,
  agentJwtSecret,
} from '../src/agent/agent-auth.service';
import { hashPassword, verifyPassword } from '../src/agent/agent-password';

function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    incr: vi.fn(async (key: string) => {
      const n = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(n));
      return n;
    }),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  };
  return { redis, store };
}

async function fakeDataSource(passwordHash: string) {
  let row = {
    id: 'ag_1',
    name: '代理甲',
    phone: '13800000000',
    password_hash: passwordHash,
    rate_bp: 8000,
    status: 'active',
    must_change_password: 0,
    token_version: 3,
  };
  const dataSource = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      if (sql.includes('WHERE `phone` = ?')) return row.phone === String(p[0]) ? [row] : [];
      if (sql.includes('SELECT `id`, `password_hash`')) return [{ id: row.id, password_hash: row.password_hash }];
      if (sql.includes('SELECT `id`, `name`, `phone`')) return [row];
      return [];
    }),
    transaction: vi.fn(async (cb: (m: unknown) => Promise<unknown>) =>
      cb({
        query: async (sql: string, params?: unknown[]) => {
          const p = params ?? [];
          if (sql.startsWith('UPDATE `agent_accounts` SET `password_hash`')) {
            row = { ...row, password_hash: String(p[0]), must_change_password: 0, token_version: row.token_version + 1 };
            return undefined;
          }
          if (sql.includes('INSERT INTO `agent_admin_audit`')) return undefined;
          throw new Error(`fake tx 未识别 SQL：${sql}`);
        },
      }),
    ),
    getRow: () => row,
  };
  return dataSource;
}

describe('AgentAuthService：登录/JWT/失败计数/改密', () => {
  it('登录成功：JWT aud/typ/ver 正确；失败计数清零', async () => {
    const { redis, store } = fakeRedis();
    store.set('agent_login_fail:13800000000', '2');
    const ds = await fakeDataSource(await hashPassword('secret-1'));
    const svc = new AgentAuthService(ds as unknown as DataSource, redis as unknown as Redis);
    const res = await svc.login({ phone: ' 13800000000 ', password: 'secret-1' });
    expect(res.agent).toMatchObject({ id: 'ag_1', rateBp: 8000, status: 'active' });
    const payload = new JwtService({ secret: agentJwtSecret() }).verify(res.token, {
      audience: AGENT_JWT_AUDIENCE,
    }) as Record<string, unknown>;
    expect(payload).toMatchObject({ sub: 'ag_1', typ: 'agent-access', ver: 3 });
    expect(store.has('agent_login_fail:13800000000')).toBe(false);
  });

  it('密码错 ⇒ BAD_CREDENTIALS 且失败计数 +1；第 5 次前锁定', async () => {
    const { redis, store } = fakeRedis();
    const ds = await fakeDataSource(await hashPassword('right'));
    const svc = new AgentAuthService(ds as unknown as DataSource, redis as unknown as Redis);
    await expect(svc.login({ phone: '13800000000', password: 'wrong' })).rejects.toMatchObject({
      code: ErrCode.BAD_CREDENTIALS,
    });
    expect(store.get('agent_login_fail:13800000000')).toBe('1');

    store.set('agent_login_fail:13800000000', '5');
    await expect(svc.login({ phone: '13800000000', password: 'right' })).rejects.toMatchObject({
      code: ErrCode.RATE_LIMITED,
    });
  });

  it('冻结代理允许登录（只读+结算）', async () => {
    const { redis } = fakeRedis();
    const ds = await fakeDataSource(await hashPassword('secret'));
    const original = ds.query;
    (ds as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> }).query =
      vi.fn(async (sql: string, params?: unknown[]) => {
        const rows = (await original(sql, params)) as Array<Record<string, unknown>>;
        return rows.map((r) => ({ ...r, status: 'frozen' }));
      });
    const svc = new AgentAuthService(ds as unknown as DataSource, redis as unknown as Redis);
    const res = await svc.login({ phone: '13800000000', password: 'secret' });
    expect(res.agent.status).toBe('frozen');
  });

  it('Redis 读故障 ⇒ 10007 fail-closed', async () => {
    const redis = { get: vi.fn(async () => { throw new Error('down'); }) };
    const ds = await fakeDataSource(await hashPassword('secret'));
    const svc = new AgentAuthService(ds as unknown as DataSource, redis as unknown as Redis);
    await expect(svc.login({ phone: '13800000000', password: 'secret' })).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
  });

  it('改密：旧密码错 ⇒ BAD_CREDENTIALS；成功 ⇒ 新 hash + token_version+1', async () => {
    const { redis } = fakeRedis();
    const ds = await fakeDataSource(await hashPassword('old-pass'));
    const svc = new AgentAuthService(ds as unknown as DataSource, redis as unknown as Redis);
    await expect(
      svc.changePassword({ agentId: 'ag_1', oldPassword: 'bad', newPassword: 'new-pass' }),
    ).rejects.toMatchObject({ code: ErrCode.BAD_CREDENTIALS });
    await expect(
      svc.changePassword({ agentId: 'ag_1', oldPassword: 'old-pass', newPassword: 'new-pass' }),
    ).resolves.toEqual({ relogin: true });
    expect(ds.getRow().token_version).toBe(4);
    expect(await verifyPassword('new-pass', ds.getRow().password_hash)).toBe(true);
  });

  it('密钥链：空串回落 JWT_SECRET；都空回落兜底', () => {
    const saved = { a: process.env.AGENT_JWT_SECRET, j: process.env.JWT_SECRET };
    try {
      process.env.AGENT_JWT_SECRET = '';
      process.env.JWT_SECRET = 'shared';
      expect(agentJwtSecret()).toBe('shared');
      process.env.JWT_SECRET = '';
      expect(agentJwtSecret()).toBe(AGENT_JWT_SECRET_FALLBACK);
    } finally {
      if (saved.a === undefined) delete process.env.AGENT_JWT_SECRET;
      else process.env.AGENT_JWT_SECRET = saved.a;
      if (saved.j === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = saved.j;
    }
  });
});
