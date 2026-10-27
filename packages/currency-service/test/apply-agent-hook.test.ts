import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import type { CurrencyApplyRequest } from '@fight-the-landlord/protocol';
import { ApplyService, isFatalTxError } from '../src/apply/apply.service';
import type { AgentLedgerService } from '../src/agent/agent-ledger.service';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

const mkReq = (over: Partial<CurrencyApplyRequest> = {}): CurrencyApplyRequest => ({
  actionId: 'agent:hook-1',
  source: 'admin_adjust',
  actor: 'admin',
  reason: 'hook test',
  entries: [{ ownerId: 'u-a', delta: 100 }],
  ...over,
});

describe('ApplyService × 代理钩子（保存点/故障分类）', () => {
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new FakeCurrencyDb([]);
    redis = new FakeRedis([]);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const kinds = (txIndex: number): string[] =>
    db.txLog[txIndex]!.statements.map((s) => {
      if (s.sql.startsWith('SAVEPOINT')) return 'savepoint';
      if (s.sql.startsWith('RELEASE SAVEPOINT')) return 'release';
      if (s.sql.startsWith('ROLLBACK TO SAVEPOINT')) return 'rollbackTo';
      return 'other';
    });

  it('非代理 source 不建保存点；代理 source 建/释放', async () => {
    const onApply = vi.fn(async () => undefined);
    const svc = new ApplyService(
      db.dataSource as unknown as DataSource,
      redis as unknown as Redis,
      { onApply } as unknown as AgentLedgerService,
    );

    await svc.apply(mkReq({ actionId: 'agent:hook-free', source: 'signup_grant', actor: undefined }));
    expect(onApply).toHaveBeenCalledTimes(0);
    expect(kinds(0)).not.toContain('savepoint');

    await svc.apply(mkReq({ actionId: 'agent:hook-adjust' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const k = kinds(1);
    expect(k.filter((x) => x === 'savepoint')).toHaveLength(1);
    expect(k.filter((x) => x === 'release')).toHaveLength(1);
    expect(k).not.toContain('rollbackTo');
  });

  it('钩子语句级失败 ⇒ 回滚保存点、主事务提交、apply 仍 ok、指标 +1', async () => {
    const onApply = vi.fn(async () => {
      throw new Error('boom');
    });
    const svc = new ApplyService(
      db.dataSource as unknown as DataSource,
      redis as unknown as Redis,
      { onApply } as unknown as AgentLedgerService,
    );

    const res = await svc.apply(mkReq({ actionId: 'agent:hook-soft' }));

    expect(res.ok).toBe(true);
    const k = kinds(0);
    expect(k).toContain('savepoint');
    expect(k).toContain('rollbackTo');
    expect(k.filter((x) => x === 'release')).toHaveLength(1); // 回滚路径的 RELEASE
    expect(errorSpy).toHaveBeenCalled();
  });

  it('caller effect 在保存点之前：钩子失败不回滚 caller 写入', async () => {
    const order: string[] = [];
    const onApply = vi.fn(async () => {
      order.push('hook');
      throw new Error('boom');
    });
    const svc = new ApplyService(
      db.dataSource as unknown as DataSource,
      redis as unknown as Redis,
      { onApply } as unknown as AgentLedgerService,
    );

    const res = await svc.applyWithEffect(mkReq({ actionId: 'agent:hook-effect' }), async () => {
      order.push('caller-effect');
    });

    expect(res.ok).toBe(true);
    expect(order).toEqual(['caller-effect', 'hook']);
  });

  it('钩子死锁（1213）⇒ 原样重抛、apply 失败（不提交空事务）', async () => {
    const onApply = vi.fn(async () => {
      throw Object.assign(new Error('deadlock'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });
    });
    const svc = new ApplyService(
      db.dataSource as unknown as DataSource,
      redis as unknown as Redis,
      { onApply } as unknown as AgentLedgerService,
    );

    await expect(svc.apply(mkReq({ actionId: 'agent:hook-deadlock' }))).rejects.toThrow(/deadlock/);
  });

  it('isFatalTxError：1213/1205/1305/连接错误为真；普通错为假', () => {
    for (const err of [
      { errno: 1213 },
      { errno: 1205 },
      { errno: 1305 },
      { code: 'ER_LOCK_DEADLOCK' },
      { code: 'ER_LOCK_WAIT_TIMEOUT' },
      { code: 'ER_SP_DOES_NOT_EXIST' },
      { code: 'PROTOCOL_CONNECTION_LOST' },
      { code: 'ECONNRESET' },
      { code: 'ETIMEDOUT' },
      { code: 'ER_QUERY_INTERRUPTED' },
    ]) {
      expect(isFatalTxError(err), JSON.stringify(err)).toBe(true);
    }
    for (const err of [new Error('boom'), { errno: 1146, code: 'ER_NO_SUCH_TABLE' }, null, 'x']) {
      expect(isFatalTxError(err), JSON.stringify(err)).toBe(false);
    }
  });
});
