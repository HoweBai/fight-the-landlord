import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  ADMIN_BOOTSTRAP_COUNT_SQL,
  ADMIN_BOOTSTRAP_INSERT_SQL,
  AdminBootstrapService,
  BOOTSTRAP_ROLE,
  BOOTSTRAP_USERNAME,
} from '../src/admin/admin-bootstrap.service';
import { verifyPassword, type ScryptParams } from '../src/admin/admin-password';

/**
 * 首启引导（规格 §2.13 bootstrap；判据 C3）。
 *
 * 三态 + 两条纪律：
 *  - 空表 + env 非空 ⇒ 建 `admin`/`super_admin`（scrypt、`status='active'`）+ **日志逐字**；
 *  - 空表 + env 空（未设 / 空串）⇒ 只 warn 逐字、零写入；
 *  - 非空表 ⇒ 无动作（env 设了也不动——幂等）；
 *  - **短口令照建仅 warn**（不套口令策略——设计 F10a 防升级自锁）；
 *  - 唯一键冲突（并发）⇒ **捕获忽略**（不抛、也不打成功日志——插入没成功）。
 *
 * 日志断言按**原型 spy**（同 `admin-accounts.test.ts` 的 warn spy 形态）；假库只认真源码导出的
 * 两条 SQL 常量（实现改文案这里当场红）。scrypt 用小参注入（同 T2 单测口径）。
 */

const SMALL_SCRYPT: ScryptParams = { N: 4096, r: 8, p: 1, maxmem: 16 * 1024 * 1024, keylen: 32 };
const CREATED_LOG = "admin bootstrap: created super_admin 'admin' from ADMIN_PASSWORD";
const DISABLED_LOG = 'admin bootstrap: no accounts and no ADMIN_PASSWORD — admin surface disabled';
const SHORT_WARN_LOG = 'admin bootstrap: bootstrap password is shorter than the policy minimum (10)';

interface FakeBootstrapAccount {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  status: string;
}

class FakeBootstrapDb {
  accounts: FakeBootstrapAccount[] = [];
  queries: Array<{ sql: string; params: unknown[] }> = [];
  /** 置 true ⇒ INSERT 抛唯一键冲突（模拟并发首启）。 */
  conflictOnInsert = false;
  private nextId = 1;

  addAccount(username: string): void {
    this.accounts.push({
      id: this.nextId++,
      username,
      password_hash: 'seeded-placeholder-hash',
      role: 'viewer',
      status: 'active',
    });
  }

  readonly dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => this.exec(sql, params),
  };

  private async exec(sql: string, params: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params });
    if (sql === ADMIN_BOOTSTRAP_COUNT_SQL) {
      return [{ count: this.accounts.length }];
    }
    if (sql === ADMIN_BOOTSTRAP_INSERT_SQL) {
      if (this.conflictOnInsert) {
        const err = new Error("Duplicate entry 'admin' for key 'uk_admin_username'") as Error & {
          driverError: { code: string; errno: number };
        };
        err.driverError = { code: 'ER_DUP_ENTRY', errno: 1062 };
        throw err;
      }
      const [username, password_hash, role] = params as [string, string, string];
      const row: FakeBootstrapAccount = {
        id: this.nextId++,
        username,
        password_hash,
        role,
        status: 'active', // 建表缺省（SQL 不含 status 列）
      };
      this.accounts.push(row);
      return { insertId: row.id };
    }
    throw new Error(`FakeBootstrapDb: 未识别的 SQL：${sql}`);
  }
}

const makeService = (db: FakeBootstrapDb) =>
  new AdminBootstrapService(db.dataSource as unknown as DataSource, SMALL_SCRYPT);

function spyLogs() {
  return {
    log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  };
}

let spies: ReturnType<typeof spyLogs> | undefined;

afterEach(() => {
  spies?.log.mockRestore();
  spies?.warn.mockRestore();
  spies = undefined;
  delete process.env.ADMIN_PASSWORD;
});

describe('AdminBootstrapService.onApplicationBootstrap（§2.13；C3）', () => {
  it('SQL 常量钉：计数用 `SELECT COUNT(*) AS count FROM admin_accounts`；插入与 T2 建号同形', () => {
    expect(ADMIN_BOOTSTRAP_COUNT_SQL).toBe('SELECT COUNT(*) AS count FROM admin_accounts');
    expect(ADMIN_BOOTSTRAP_INSERT_SQL).toBe(
      'INSERT INTO admin_accounts (username, password_hash, role) VALUES (?, ?, ?)',
    );
    expect(BOOTSTRAP_USERNAME).toBe('admin');
    expect(BOOTSTRAP_ROLE).toBe('super_admin');
  });

  it('态一：空表 + env 非空 ⇒ 建 `admin`/`super_admin`（scrypt 落库、可验）+ 日志逐字', async () => {
    process.env.ADMIN_PASSWORD = 'bootstrap-password';
    spies = spyLogs();
    const db = new FakeBootstrapDb();

    await makeService(db).onApplicationBootstrap();

    expect(db.accounts).toHaveLength(1);
    expect(db.accounts[0]).toMatchObject({
      username: 'admin',
      role: 'super_admin',
      status: 'active',
    });
    await expect(verifyPassword('bootstrap-password', db.accounts[0]!.password_hash)).resolves.toBe(
      true,
    );
    expect(db.accounts[0]!.password_hash).not.toContain('bootstrap-password'); // 明文永不落库
    expect(spies.log.mock.calls.map((c) => c[0])).toEqual([CREATED_LOG]);
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it('态二：空表 + env 未设 ⇒ 零写入（只查了计数）+ warn 逐字', async () => {
    delete process.env.ADMIN_PASSWORD;
    spies = spyLogs();
    const db = new FakeBootstrapDb();

    await makeService(db).onApplicationBootstrap();

    expect(db.accounts).toEqual([]);
    expect(db.queries.map((q) => q.sql)).toEqual([ADMIN_BOOTSTRAP_COUNT_SQL]); // 没有 INSERT
    expect(spies.warn.mock.calls.map((c) => c[0])).toEqual([DISABLED_LOG]);
    expect(spies.log).not.toHaveBeenCalled();
  });

  it('态二′：空串 = 未设（同一纪律）⇒ 同样 warn、零写入——空串不得被当有效口令', async () => {
    process.env.ADMIN_PASSWORD = '';
    spies = spyLogs();
    const db = new FakeBootstrapDb();

    await makeService(db).onApplicationBootstrap();

    expect(db.accounts).toEqual([]);
    expect(spies.warn.mock.calls.map((c) => c[0])).toEqual([DISABLED_LOG]);
  });

  it('态三：非空表 ⇒ 无动作（env 设了也不动——幂等）', async () => {
    process.env.ADMIN_PASSWORD = 'bootstrap-password';
    spies = spyLogs();
    const db = new FakeBootstrapDb();
    db.addAccount('someone.else');

    await makeService(db).onApplicationBootstrap();

    expect(db.accounts).toHaveLength(1); // 没多没少
    expect(db.queries.map((q) => q.sql)).toEqual([ADMIN_BOOTSTRAP_COUNT_SQL]);
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it('幂等：连跑两次（空表起步）⇒ 只建一次；第二次零动作、零新增日志', async () => {
    process.env.ADMIN_PASSWORD = 'bootstrap-password';
    spies = spyLogs();
    const db = new FakeBootstrapDb();
    const svc = makeService(db);

    await svc.onApplicationBootstrap();
    await svc.onApplicationBootstrap();

    expect(db.accounts).toHaveLength(1);
    expect(spies.log.mock.calls.map((c) => c[0])).toEqual([CREATED_LOG]); // 恰一次
  });

  it('短口令（<10）⇒ **照建**（不套口令策略）+ 短口令 warn 逐字 + created 日志', async () => {
    process.env.ADMIN_PASSWORD = 'short'; // 5 位
    spies = spyLogs();
    const db = new FakeBootstrapDb();

    await makeService(db).onApplicationBootstrap();

    expect(db.accounts).toHaveLength(1); // 照建（F10a：不能升级自锁）
    await expect(verifyPassword('short', db.accounts[0]!.password_hash)).resolves.toBe(true);
    expect(spies.warn.mock.calls.map((c) => c[0])).toEqual([SHORT_WARN_LOG]);
    expect(spies.log.mock.calls.map((c) => c[0])).toEqual([CREATED_LOG]);
  });

  it('唯一键冲突（并发首启）⇒ 捕获忽略：不抛、不重复建、不打成功日志', async () => {
    process.env.ADMIN_PASSWORD = 'bootstrap-password';
    spies = spyLogs();
    const db = new FakeBootstrapDb();
    db.conflictOnInsert = true;

    await expect(makeService(db).onApplicationBootstrap()).resolves.toBeUndefined();

    expect(db.accounts).toEqual([]);
    expect(spies.log).not.toHaveBeenCalled(); // 插入没成功 ⇒ 不报「created」
  });
});
