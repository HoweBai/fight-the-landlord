/**
 * 支付片 T9：**资金锁套件**（任务卡 Test: `locks.test.ts`；规格 §3.6 锁纪律 / §2.4 资金纪律）。
 *
 * 覆盖面（三块 + 一条真库发现的护栏）：
 *  ① `LOCK_INSERT_IGNORE_SQL` / `LOCK_SELECT_FOR_UPDATE_SQL` **全文钉**（§3.6 逐字形状）+
 *     `LOCK_MAX_ATTEMPTS`；
 *  ② `withUserLock` 形状：语句序 INSERT IGNORE → SELECT … FOR UPDATE → fn（fn 拿到的是
 *     **事务内** manager——资金写必须与锁同事务）· 返回值透传 · 同 key 复用（第二次
 *     INSERT IGNORE affected=0、锁行不重复建）· 不同 key 互不阻塞；
 *  ③ 串行化/异常释放：同 user 并发两申请 ⇒ 第二个**在前者事务结束前不进 fn**；fn 抛错 ⇒
 *     事务回滚（异常必释放）、原错误穿出、后续申请不受阻、**锁行留存**（物化的用意）。
 *
 *  🔴 **死锁重试（T9 真库双会话实证驱动，`t9-lock-demo.log`）**：锁行已存在（steady state）
 *  时，两个会话各自 `INSERT IGNORE`（S 锁，相容）后各自求 `FOR UPDATE`（X 升级）
 *  ⇒ InnoDB **死锁（1213）**、一方被回滚——真库确定性复现（见日志）。因此
 *  `withUserLock` 对「**获取阶段**（INSERT/FOR UPDATE，fn 尚未执行 ⇒ 无副作用）」的死锁
 *  做**有界重试**；fn 执行中出现的死锁**不重试**（副作用未知，交给上层）。
 *  对应三组判据：单次死锁 ⇒ 重试成功；恒死锁 ⇒ 3 次后抛；fn 内死锁 ⇒ 不重试。
 *
 * 夹具：**假 DataSource**（精确形状识别；`transaction()` 模拟「同 user 后到者在前者
 * 事务结束（finally 释放）后才拿到行锁」的等待链）。串行化的**真实**证据 = 真栈双会话
 * 探针（`t9-realstack.log`）——本文件钉控制流形状与重试边界。
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
// ⚠️ **值导入**：`DataSource` 同时是 DI token（service 构造参）——`import type` 会在运行期 undefined。
import { DataSource, type EntityManager } from 'typeorm';
import {
  LOCK_INSERT_IGNORE_SQL,
  LOCK_MAX_ATTEMPTS,
  LOCK_SELECT_FOR_UPDATE_SQL,
  isDeadlockError,
  UserLockService,
} from '../src/locks/user-lock.service';

/* ======================================================================== *
 * ① SQL 形状（§3.6 逐字）
 * ======================================================================== */
describe('① 锁 SQL 常量全文钉（规格 §3.6）', () => {
  it('INSERT IGNORE 建行（一人一行；命中 ⇒ 复用）', () => {
    expect(LOCK_INSERT_IGNORE_SQL).toBe(
      'INSERT IGNORE INTO `payment_user_locks` (`user_id`) VALUES (?)',
    );
  });

  it('SELECT … FOR UPDATE 行锁（事务内；锁的释放 = 事务边界）', () => {
    expect(LOCK_SELECT_FOR_UPDATE_SQL).toBe(
      'SELECT `user_id` FROM `payment_user_locks` WHERE `user_id` = ? FOR UPDATE',
    );
  });

  it('重试上限与死锁判别（1213 / ER_LOCK_DEADLOCK）', () => {
    expect(LOCK_MAX_ATTEMPTS).toBe(3);
    expect(isDeadlockError({ code: 'ER_LOCK_DEADLOCK' })).toBe(true);
    expect(isDeadlockError({ errno: 1213 })).toBe(true);
    expect(isDeadlockError(new Error('Deadlock found when trying to get lock; try restarting transaction'))).toBe(true);
    expect(isDeadlockError(new Error('connection lost'))).toBe(false);
    expect(isDeadlockError(null)).toBe(false);
  });
});

/* ======================================================================== *
 * 夹具：假 DataSource（等待链 + 死锁注入）
 * ======================================================================== */

const USER = 'user-t9-lock-0001';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const deadlockError = (): Error =>
  Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), {
    code: 'ER_LOCK_DEADLOCK',
    errno: 1213,
  });

/** 服务侧两条锁语句的自造 fn 语句（凡在事务内执行都记录进 statements）。 */
const FN_SQL = 'SELECT 1 AS `probe`';

class FakeLockDb {
  readonly lockRows = new Set<string>();
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];
  readonly txLog: Array<{ committed: boolean }> = [];
  txCount = 0;
  /** 注入点：第 N 次 transaction() 的 FOR UPDATE 抛什么（null = 正常）。 */
  forUpdateError: (attempt: number) => Error | null = () => null;

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  /** 同 user 的行锁等待链尾（模拟 InnoDB 行锁：前一个事务结束前，后到者阻塞）。 */
  private readonly tail = new Map<string, Promise<void>>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    this.txCount += 1;
    const attempt = this.txCount;
    const outcome = { committed: false };
    this.txLog.push(outcome);
    // 行锁等待链的放行句柄（FOR UPDATE 时武装；未武装 = noop——事务在锁步之前就抛了的形态）。
    let releaseWaiters: () => void = () => undefined;

    const manager = {
      query: async (sql: string, params: unknown[] = []) => {
        this.statements.push({ sql, params });
        const userId = String(params[0]);
        if (sql === LOCK_INSERT_IGNORE_SQL) {
          const existed = this.lockRows.has(userId);
          this.lockRows.add(userId);
          return { affectedRows: existed ? 0 : 1 };
        }
        if (sql === LOCK_SELECT_FOR_UPDATE_SQL) {
          const injected = this.forUpdateError(attempt);
          if (injected) throw injected;
          // 行锁等待：链在 tail 后（前者事务的 finally 放行）。
          const prev = this.tail.get(userId) ?? Promise.resolve();
          await prev;
          const completion = new Promise<void>((res) => {
            releaseWaiters = res;
          });
          this.tail.set(userId, completion);
          return this.lockRows.has(userId) ? [{ user_id: userId }] : [];
        }
        return undefined; // fn 的自造语句
      },
    } as unknown as EntityManager;

    try {
      const result = await fn(manager);
      outcome.committed = true;
      return result;
    } finally {
      // 事务边界 = 锁释放（提交或回滚都经这里；异常穿出由调用方接住）。
      releaseWaiters();
    }
  }
}

/* ======================================================================== *
 * ② withUserLock 形状
 * ======================================================================== */
describe('② withUserLock：形状与键语义', () => {
  it('语句序：INSERT IGNORE → SELECT … FOR UPDATE → fn（fn 经**事务内** manager 执行）；返回值透传', async () => {
    const db = new FakeLockDb();
    const svc = new UserLockService(db.dataSource);

    const result = await svc.withUserLock(USER, async (manager) => {
      await manager.query(FN_SQL);
      return 'payload-42';
    });

    expect(result).toBe('payload-42');
    expect(db.statements.map((s) => s.sql)).toEqual([
      LOCK_INSERT_IGNORE_SQL,
      LOCK_SELECT_FOR_UPDATE_SQL,
      FN_SQL,
    ]);
    expect(db.statements[0]!.params).toEqual([USER]);
    expect(db.statements[1]!.params).toEqual([USER]);
    expect(db.txLog).toEqual([{ committed: true }]);
  });

  it('同 key 复用：第二次申请 INSERT IGNORE affected=0（锁行不重复建）、两事务都提交', async () => {
    const db = new FakeLockDb();
    const svc = new UserLockService(db.dataSource);

    await svc.withUserLock(USER, async () => 'first');
    await svc.withUserLock(USER, async () => 'second');

    expect(db.lockRows.size).toBe(1); // 恰一行（一人一行的物化锁）
    expect(db.txLog.map((t) => t.committed)).toEqual([true, true]);
    // 两次 INSERT IGNORE：第一次建行、第二次命中复用（affected=0 —— 假 DB 按 existed 返回）
    expect(db.statements.filter((s) => s.sql === LOCK_INSERT_IGNORE_SQL)).toHaveLength(2);
  });

  it('不同 user 互不阻塞（键独立性：B 完成时 A 还持有自己的锁）', async () => {
    const db = new FakeLockDb();
    const svc = new UserLockService(db.dataSource);
    const entered: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((res) => {
      openGate = res;
    });

    const a = svc.withUserLock('user-A', async () => {
      entered.push('A:enter');
      await gate;
      entered.push('A:exit');
    });
    await sleep(5);
    await svc.withUserLock('user-B', async () => {
      entered.push('B');
    });
    expect(entered).toEqual(['A:enter', 'B']); // B 未被 A 键阻塞
    openGate();
    await a;
    expect(entered).toEqual(['A:enter', 'B', 'A:exit']);
  });
});

/* ======================================================================== *
 * ③ 串行化 / 异常释放 / 死锁重试
 * ======================================================================== */
describe('③ 串行化 · 异常释放 · 死锁重试（1213 边界）', () => {
  it('同 user 并发两申请 ⇒ 第二个在前者事务结束前**不进 fn**（串行化形状）', async () => {
    const db = new FakeLockDb();
    const svc = new UserLockService(db.dataSource);
    const events: string[] = [];

    const a = svc.withUserLock(USER, async () => {
      events.push('A:enter');
      await sleep(20);
      events.push('A:exit');
      return 'A';
    });
    await sleep(5); // 确保 A 先拿到锁
    const b = svc.withUserLock(USER, async () => {
      events.push('B:enter');
      events.push('B:exit');
      return 'B';
    });

    expect(await a).toBe('A');
    expect(await b).toBe('B');
    expect(events).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
  });

  it('fn 抛错 ⇒ 事务回滚（异常必释放）、原错误穿出、后续申请不受阻、**锁行留存**', async () => {
    const db = new FakeLockDb();
    const svc = new UserLockService(db.dataSource);

    await expect(
      svc.withUserLock(USER, async () => {
        throw new Error('业务校验拒绝');
      }),
    ).rejects.toThrow('业务校验拒绝');
    expect(db.txLog[0]!.committed).toBe(false);

    // 异常必释放：下一次同 user 申请照常进入并提交
    await expect(svc.withUserLock(USER, async () => 'ok')).resolves.toBe('ok');
    expect(db.txLog[1]!.committed).toBe(true);
    expect(db.lockRows.size).toBe(1); // 释放的是**锁**，不是行（物化锁的用意）
  });

  it('获取阶段死锁（1213）⇒ **有界重试**（fn 未执行 ⇒ 无副作用）；warn 留痕', async () => {
    const db = new FakeLockDb();
    db.forUpdateError = (attempt) => (attempt === 1 ? deadlockError() : null);
    const svc = new UserLockService(db.dataSource);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let observed = false;
    let fnCalls = 0;
    try {
      const result = await svc.withUserLock(USER, async () => {
        fnCalls += 1;
        return 'done';
      });
      expect(result).toBe('done');
      expect(fnCalls).toBe(1); // fn 恰执行一次（首次尝试死锁在 fn 之前）
      observed = warn.mock.calls.some((args) => String(args[0]).includes('ER_LOCK_DEADLOCK'));
    } finally {
      warn.mockRestore();
    }
    expect(db.txCount).toBe(2);
    expect(db.txLog.map((t) => t.committed)).toEqual([false, true]);
    expect(observed).toBe(true);
  });

  it('恒死锁 ⇒ 恰 3 次尝试后抛（有界，不是死循环）', async () => {
    const db = new FakeLockDb();
    db.forUpdateError = () => deadlockError();
    const svc = new UserLockService(db.dataSource);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(svc.withUserLock(USER, async () => 'never')).rejects.toMatchObject({
        code: 'ER_LOCK_DEADLOCK',
      });
    } finally {
      warn.mockRestore();
    }
    expect(db.txCount).toBe(LOCK_MAX_ATTEMPTS);
    expect(db.txLog.every((t) => t.committed === false)).toBe(true);
  });

  it('获取阶段**非死锁**错误 ⇒ 不重试、原样穿出（只对 1213 重试）', async () => {
    const db = new FakeLockDb();
    db.forUpdateError = () => Object.assign(new Error('表被删了'), { code: 'ER_NO_SUCH_TABLE' });
    const svc = new UserLockService(db.dataSource);

    await expect(svc.withUserLock(USER, async () => 'x')).rejects.toThrow('表被删了');
    expect(db.txCount).toBe(1);
  });

  it('fn **执行中**抛死锁 ⇒ **不重试**（边界：fn 已运行 ⇒ 副作用未知，交上层）', async () => {
    const db = new FakeLockDb();
    const svc = new UserLockService(db.dataSource);
    let fnCalls = 0;

    await expect(
      svc.withUserLock(USER, async () => {
        fnCalls += 1;
        throw deadlockError();
      }),
    ).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });

    expect(fnCalls).toBe(1); // 未被重放
    expect(db.txCount).toBe(1); // 未开第二个事务
    expect(db.txLog[0]!.committed).toBe(false);
  });
});
