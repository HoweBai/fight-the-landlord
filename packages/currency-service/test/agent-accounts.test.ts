import { describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AgentAccountsService } from '../src/agent/agent-accounts.service';
import type { AgentInviteService } from '../src/agent/agent-invite.service';
import type { AgentSettingsService } from '../src/agent/agent-settings.service';

interface Row {
  id: string;
  name: string;
  phone: string;
  password_hash: string;
  parent_id: string | null;
  rate_bp: number;
  region: string | null;
  contact_name: string | null;
  payout_name: string | null;
  payout_account: string | null;
  payout_bank: string | null;
  status: string;
  must_change_password: number;
  token_version: number;
  created_at: Date;
}

function makeDb() {
  const accounts = new Map<string, Row>();
  const rates: Array<Record<string, unknown>> = [];
  const statuses: Array<Record<string, unknown>> = [];
  const audit: Array<Record<string, unknown>> = [];
  const manager = {
    query: async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      if (sql.includes('SELECT `id`, `parent_id`, `rate_bp`, `status` FROM `agent_accounts` FOR UPDATE')) {
        return [...accounts.values()].map((a) => ({
          id: a.id,
          parent_id: a.parent_id,
          rate_bp: a.rate_bp,
          status: a.status,
        }));
      }
      if (sql.startsWith('INSERT INTO `agent_accounts`')) {
        accounts.set(String(p[0]), {
          id: String(p[0]),
          name: String(p[1]),
          phone: String(p[2]),
          password_hash: String(p[3]),
          parent_id: p[4] === null ? null : String(p[4]),
          rate_bp: Number(p[5]),
          region: p[6] === null ? null : String(p[6]),
          contact_name: p[7] === null ? null : String(p[7]),
          payout_name: p[8] === null ? null : String(p[8]),
          payout_account: p[9] === null ? null : String(p[9]),
          payout_bank: p[10] === null ? null : String(p[10]),
          status: 'active',
          must_change_password: 1,
          token_version: 0,
          created_at: new Date('2026-10-26T00:00:00Z'),
        });
        return { affectedRows: 1 };
      }
      if (sql.includes('FROM `agent_accounts` WHERE `id` = ?')) {
        const a = accounts.get(String(p[0]));
        return a === undefined ? [] : [a];
      }
      if (sql.startsWith('UPDATE `agent_accounts` SET `name`')) {
        const a = accounts.get(String(p[8]));
        if (a !== undefined) {
          accounts.set(a.id, {
            ...a,
            name: String(p[0]),
            parent_id: p[1] === null ? null : String(p[1]),
            rate_bp: Number(p[2]),
            region: p[3] === null ? null : String(p[3]),
            contact_name: p[4] === null ? null : String(p[4]),
            payout_name: p[5] === null ? null : String(p[5]),
            payout_account: p[6] === null ? null : String(p[6]),
            payout_bank: p[7] === null ? null : String(p[7]),
          });
        }
        return { affectedRows: 1 };
      }
      if (sql.startsWith('UPDATE `agent_accounts` SET `status`')) {
        const a = accounts.get(String(p[2]));
        if (a !== undefined) {
          accounts.set(a.id, {
            ...a,
            status: String(p[0]),
            token_version: a.token_version + Number(p[1]),
          });
        }
        return { affectedRows: 1 };
      }
      if (sql.startsWith('UPDATE `agent_accounts` SET `password_hash`')) {
        const a = accounts.get(String(p[1]));
        if (a !== undefined) {
          accounts.set(a.id, {
            ...a,
            password_hash: String(p[0]),
            must_change_password: 1,
            token_version: a.token_version + 1,
          });
        }
        return { affectedRows: 1 };
      }
      if (sql.startsWith('UPDATE `agent_accounts` SET `payout_name`')) {
        const a = accounts.get(String(p[3]));
        if (a !== undefined) {
          accounts.set(a.id, {
            ...a,
            payout_name: p[0] === null ? null : String(p[0]),
            payout_account: p[1] === null ? null : String(p[1]),
            payout_bank: p[2] === null ? null : String(p[2]),
          });
        }
        return { affectedRows: 1 };
      }
      if (sql.includes('INSERT INTO `agent_rates`')) {
        rates.push({ agent: p[0], rate: p[1] });
        return undefined;
      }
      if (sql.includes('INSERT INTO `agent_status_history`')) {
        statuses.push({ agent: p[0], status: p[1] });
        return undefined;
      }
      if (sql.includes('INSERT INTO `agent_admin_audit`')) {
        audit.push({ actor: p[0], action: p[1], target: p[3] });
        return undefined;
      }
      if (sql.includes('COUNT(*) AS `cnt` FROM `agent_accounts`')) return [{ cnt: 0 }];
      if (sql.includes('COUNT(*) AS `cnt` FROM `agent_bindings`')) return [{ cnt: 0 }];
      if (sql.includes('FROM `agent_accounts` ORDER BY')) return [...accounts.values()];
      if (sql.includes('FROM `agent_admin_audit`')) return [];
      throw new Error(`fake accounts DB 未识别 SQL：${sql}`);
    },
  } as unknown as EntityManager;
  const dataSource = {
    transaction: async <T>(cb: (m: EntityManager) => Promise<T>) => cb(manager),
    query: (sql: string, params?: unknown[]) => manager.query(sql, params),
  };
  return { manager, dataSource, accounts, rates, statuses, audit };
}

function makeService(db: ReturnType<typeof makeDb>) {
  const settings = {
    getOrDefault: vi.fn(async () => ({ defaultRateBp: 5000 })),
  } as unknown as AgentSettingsService;
  const invite = {
    createFor: vi.fn(async () => 'CODE1234'),
    rotate: vi.fn(async () => 'NEWCODE1'),
  } as unknown as AgentInviteService;
  const svc = new AgentAccountsService(
    db.dataSource as unknown as DataSource,
    settings,
    invite,
  );
  return { svc, invite };
}

async function create(
  svc: AgentAccountsService,
  input: { name: string; phone: string; parentId?: string | null; rateBp?: number },
) {
  return svc.create({ ...input, password: 'pass-123' }, 'admin');
}

describe('AgentAccountsService：创建/树校验', () => {
  it('创建根代理：账号 + 比例历史 + 邀请码 + audit；初始密码不回落', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    const r = await create(svc, { name: '总代', phone: '13800000001', rateBp: 8000 });
    expect(r.account.rateBp).toBe(8000);
    expect(r.account.status).toBe('active');
    expect(r.initialPassword).toBeNull();
    expect(r.inviteCode).toBe('CODE1234');
    expect(db.rates).toEqual([{ agent: r.account.id, rate: 8000 }]);
    expect(db.audit.some((a) => a.action === 'agent.create')).toBe(true);
  });

  it('未给比例 ⇒ 取 settings 默认；未给密码 ⇒ 返回一次性初始密码', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    const r = await svc.create({ name: '默认', phone: '13800000002' }, 'admin');
    expect(r.account.rateBp).toBe(5000);
    expect(typeof r.initialPassword).toBe('string');
    expect(r.initialPassword!.length).toBe(12);
  });

  it('子代理比例 > 上级 ⇒ AGENT_RATE_INVALID', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    const root = await create(svc, { name: '根', phone: '13800000003', rateBp: 6000 });
    await expect(
      create(svc, { name: '子', phone: '13800000004', parentId: root.account.id, rateBp: 7000 }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_RATE_INVALID });
  });

  it('深度 > 5 ⇒ AGENT_RATE_INVALID', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    let parentId: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const r = await create(svc, {
        name: `L${i}`,
        phone: `1380000001${i}`,
        parentId,
        rateBp: 1000,
      });
      parentId = r.account.id;
    }
    await expect(
      create(svc, { name: 'L6', phone: '13800000019', parentId, rateBp: 1000 }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_RATE_INVALID });
  });
});

describe('AgentAccountsService：改比例/重挂/状态/密码', () => {
  it('改比例高于上级 / 低于下级 ⇒ 拒绝；合法改动写 rate history', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    const root = await create(svc, { name: '根', phone: '13800000101', rateBp: 8000 });
    const child = await create(svc, {
      name: '子',
      phone: '13800000102',
      parentId: root.account.id,
      rateBp: 6000,
    });
    await expect(
      svc.update(child.account.id, { rateBp: 9000 }, 'admin', '提比例'),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_RATE_INVALID });
    await expect(
      svc.update(root.account.id, { rateBp: 5000 }, 'admin', '降比例'),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_RATE_INVALID });

    const ok = await svc.update(child.account.id, { rateBp: 7000 }, 'admin', '提比例');
    expect(ok.rateBp).toBe(7000);
    expect(db.rates.some((r) => r.agent === child.account.id && r.rate === 7000)).toBe(true);
  });

  it('重挂成环（把自己挂到自己的下级）⇒ 拒绝', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    const root = await create(svc, { name: '根', phone: '13800000201', rateBp: 8000 });
    const child = await create(svc, {
      name: '子',
      phone: '13800000202',
      parentId: root.account.id,
      rateBp: 6000,
    });
    await expect(
      svc.update(root.account.id, { parentId: child.account.id }, 'admin', '成环'),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_RATE_INVALID });
  });

  it('冻结：状态 + token_version + history + audit；解冻不加版本', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    const root = await create(svc, { name: '根', phone: '13800000301', rateBp: 8000 });
    const frozen = await svc.setStatus(root.account.id, 'frozen', 'admin', '违规');
    expect(frozen.status).toBe('frozen');
    expect(db.accounts.get(root.account.id)!.token_version).toBe(1);
    expect(db.statuses).toEqual([{ agent: root.account.id, status: 'frozen' }]);

    await svc.setStatus(root.account.id, 'active', 'admin', '解冻');
    expect(db.accounts.get(root.account.id)!.token_version).toBe(1);
  });

  it('重置密码：返回一次性明文、写新 hash、must_change=1、token_version+1', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    const root = await create(svc, { name: '根', phone: '13800000401', rateBp: 8000 });
    const before = db.accounts.get(root.account.id)!.password_hash;
    const r = await svc.resetPassword(root.account.id, 'admin');
    expect(r.password).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const after = db.accounts.get(root.account.id)!;
    expect(after.password_hash).not.toBe(before);
    expect(after.must_change_password).toBe(1);
    expect(after.token_version).toBe(1);
  });

  it('轮换邀请码：委托 invite.rotate + audit', async () => {
    const db = makeDb();
    const { svc, invite } = makeService(db);
    const root = await create(svc, { name: '根', phone: '13800000501', rateBp: 8000 });
    const r = await svc.rotateInviteCode(root.account.id, 'admin');
    expect(r).toEqual({ code: 'NEWCODE1' });
    expect(invite.rotate).toHaveBeenCalled();
    expect(db.audit.some((a) => a.action === 'agent.invite.rotate')).toBe(true);
  });
});
