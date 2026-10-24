/**
 * `ApplyService` 的**并发控制流**面 —— 货币片 T3 / §6.1 `apply.concurrency` 行。
 *
 * 🔴 **本文件不证明原子性**（照仓内先例教训「假 Redis 证不了原子性」的同族纪律）：假 DB
 * 仿真的是**事务契约**（提交/回滚的工作副本），不是 InnoDB 的锁与隔离级别。真并发的判据
 * （并行 N 扣减 ⇒ 终止余额 = 初值 − 成功笔数×单额、**全程无负**）由 **T10 slice-17 的
 * 并发 burst 组**在真栈上承载（C7 主载体）。
 *
 * 本文件钉的是**控制流分支**——并发下实现必须走对的那些路：
 *  ① 条件更新 0 行 ⇒ INSERT IGNORE 0（行已存在）⇒ ⚙️12 重查 ⇒ **重试恰一次**仍 0 ⇒ 14001（整批回滚）；
 *  ② ⚙️12 窄洞：对方首建**异型**（robot）⇒ 重查命中 ⇒ **10001**（不是 14001、更不是静默放过）；
 *  ③ 对方首建**同型** ⇒ 重查通过 ⇒ 重试成功（余额 = delta、首写类型不被改写）；
 *  ④ 并发撞 `uk_action_id`（胜者已提交）⇒ 事务回滚 ⇒ **新事务**读 ops ⇒ 同 hash ⇒ replayed；
 *  ⑤ 同④ 但 hash 不同 ⇒ 14002（响亮）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import {
  ErrCode,
  currencyApplyHash,
  type CurrencyApplyRequest,
  type CurrencyApplyResponse,
} from '@fight-the-landlord/protocol';
import { ApplyService } from '../src/apply/apply.service';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

const mkReq = (over: Partial<CurrencyApplyRequest> = {}): CurrencyApplyRequest => ({
  actionId: 'admin:race-1',
  source: 'admin_adjust',
  actor: 'admin',
  reason: '并发控制流',
  entries: [{ ownerId: 'u-race', delta: 5 }],
  ...over,
});

function kindOf(sql: string): string {
  if (sql.startsWith('INSERT INTO `currency_ops`')) return 'ops.insert';
  if (sql.startsWith('INSERT INTO `currency_flows`')) return 'flow.insert';
  if (sql.startsWith('INSERT IGNORE INTO `currency_accounts`')) return 'account.insertIgnore';
  if (sql.startsWith('UPDATE `currency_accounts`')) return 'balance.update';
  if (sql.startsWith('SELECT `owner_type`')) return 'ownerType.select';
  if (sql.startsWith('SELECT `balance`')) return 'balance.select';
  if (sql.startsWith('SELECT `id`, `request_hash`')) return 'ops.select';
  if (sql.startsWith('SELECT `owner_id`, `balance_after`')) return 'flows.byOp';
  return `unknown:${sql.slice(0, 60)}`;
}

describe('apply 并发控制流（假 DB；原子性判据在 T10 真栈）', () => {
  let timeline: string[];
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let service: ApplyService;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    timeline = [];
    db = new FakeCurrencyDb(timeline);
    redis = new FakeRedis(timeline);
    service = new ApplyService(db.dataSource as unknown as DataSource, redis as unknown as Redis);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('① 条件更新 0 行 ⇒ INSERT IGNORE 0 ⇒ ⚙️12 重查 ⇒ 重试**恰一次**仍 0 ⇒ 14001（整批回滚）', async () => {
    db.seedAccount('u-race', 'user', 3);
    const req = mkReq({ entries: [{ ownerId: 'u-race', delta: -10 }] });

    const res = (await service.apply(req)) as CurrencyApplyResponse;

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('期望 14001');
    expect(res.code).toBe(ErrCode.E_INSUFFICIENT_FUNDS);
    // 恰六条语句：重试**恰一次**（再循环/漏重试都当场红）
    expect(db.txLog[0]!.statements.map((s) => kindOf(s.sql))).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'ownerType.select',
      'balance.update',
    ]);
    // 整批回滚：ops/flows 零行、余额未动、缓存未写
    expect(db.txLog[0]!.committed).toBe(false);
    expect(db.ops).toHaveLength(0);
    expect(db.flows).toHaveLength(0);
    expect(db.accounts.get('u-race')).toEqual({ ownerType: 'user', balance: 3 });
    expect(redis.calls).toHaveLength(0);
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('14001'))).toBe(true);
  });

  it('② ⚙️12 窄洞：并发他人首建**异型** ⇒ 重查命中 ⇒ 10001（而非 14001/静默）', async () => {
    // 注入面：在 INSERT IGNORE 执行的**那一刻**种入对方（并发会话）的行 ——
    // 类型闸的 SELECT 发生在这之前（看到「行不存在」），正是 ⚙️12 要闭合的那个窗口。
    db.beforeStatement = (sql, _params, session) => {
      if (sql.startsWith('INSERT IGNORE INTO `currency_accounts`')) {
        session.accounts.set('u-race', { ownerType: 'robot', balance: 0 });
      }
    };

    const res = (await service.apply(mkReq({ entries: [{ ownerId: 'u-race', delta: 5 }] }))) as CurrencyApplyResponse;

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('期望 10001');
    expect(res.code).toBe(ErrCode.BAD_PARAM);
    expect(res.message).toContain('robot');
    expect(db.txLog[0]!.statements.map((s) => kindOf(s.sql))).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'ownerType.select', // ⚙️12 重查命中异型 ⇒ 当场 10001，**不**进入重试
    ]);
    expect(db.txLog[0]!.committed).toBe(false);
    // 响亮（owner_type_mismatch 是 §2.12 明列的 error 级）
    expect(
      errorSpy.mock.calls.some(
        (args) => String(args[0]).includes('10001') && String(args[0]).includes('u-race'),
      ),
    ).toBe(true);
  });

  it('③ 并发他人首建**同型** ⇒ 重查通过 ⇒ 重试成功（余额 = delta；首写类型不被改写）', async () => {
    db.beforeStatement = (sql, _params, session) => {
      if (sql.startsWith('INSERT IGNORE INTO `currency_accounts`')) {
        session.accounts.set('u-race', { ownerType: 'user', balance: 0 });
      }
    };

    const res = (await service.apply(mkReq({ entries: [{ ownerId: 'u-race', delta: 5 }] }))) as CurrencyApplyResponse;

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`期望成功，收到 ${res.code}:${res.message}`);
    // 重试把 delta 施加到对方首建的行上（不是 0、更不是把行改写成自己的）
    expect(res.data.entries).toEqual([{ ownerId: 'u-race', balanceAfter: 5 }]);
    expect(db.accounts.get('u-race')).toEqual({ ownerType: 'user', balance: 5 });
    expect(db.flows[0]).toMatchObject({ delta: 5, balanceAfter: 5 });
    expect(db.txLog[0]!.statements.map((s) => kindOf(s.sql))).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'ownerType.select', // ⚙️12 重查（同型通过）
      'balance.update', // 重试一次成功
      'balance.select',
      'flow.insert',
    ]);
    expect(db.txLog[0]!.committed).toBe(true);
  });

  it('④ 并发撞 uk_action_id（胜者已提交）⇒ 本事务回滚 ⇒ 新事务读 ⇒ 同 hash ⇒ replayed:true', async () => {
    const req = mkReq({ actionId: 'admin:race-replay', entries: [{ ownerId: 'u-a', delta: 5 }] });
    // 胜者（并发会话）已提交：ops + flows 都在库里
    db.seedCommittedOp(
      { actionId: 'admin:race-replay', requestHash: currencyApplyHash(req) },
      [{ ownerId: 'u-a', delta: 5, balanceAfter: 5 }],
    );

    const res = (await service.apply(req)) as CurrencyApplyResponse;

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`期望重放，收到 ${res.code}:${res.message}`);
    expect(res.data.replayed).toBe(true);
    expect(res.data.entries).toEqual([{ ownerId: 'u-a', balanceAfter: 5 }]);
    // 撞键事务回滚 + 重放事务只读提交
    expect(db.txLog).toHaveLength(2);
    expect(db.txLog[0]!.committed).toBe(false);
    expect(db.txLog[0]!.statements.map((s) => kindOf(s.sql))).toEqual(['ops.insert']);
    expect(db.txLog[1]!.committed).toBe(true);
    expect(db.txLog[1]!.statements.map((s) => kindOf(s.sql))).toEqual(['ops.select', 'flows.byOp']);
    // 行数不变、无二次入账
    expect(db.ops).toHaveLength(1);
    expect(db.flows).toHaveLength(1);
    expect(timeline).toEqual(['rollback', 'commit']);
  });

  it('⑤ 并发撞键但 hash 不同 ⇒ 14002（响亮 error；库零变化）', async () => {
    const req = mkReq({ actionId: 'admin:race-conflict', entries: [{ ownerId: 'u-a', delta: 5 }] });
    db.seedCommittedOp(
      { actionId: 'admin:race-conflict', requestHash: 'f'.repeat(64) },
      [{ ownerId: 'u-a', delta: 999, balanceAfter: 999 }],
    );

    const res = (await service.apply(req)) as CurrencyApplyResponse;

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('期望 14002');
    expect(res.code).toBe(ErrCode.E_ACTION_CONFLICT);
    expect(db.ops).toHaveLength(1);
    expect(db.flows).toHaveLength(1);
    expect(db.txLog[1]!.statements.map((s) => kindOf(s.sql))).toEqual(['ops.select']);
    expect(
      errorSpy.mock.calls.some(
        (args) => String(args[0]).includes('14002') && String(args[0]).includes('admin:race-conflict'),
      ),
    ).toBe(true);
  });
});
