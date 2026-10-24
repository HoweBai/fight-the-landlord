import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACCOUNT_CHANGE_INSERT_SQL,
  ADMIN_RESET_INSERT_SQL,
  ADMIN_RESET_SELECT_SQL,
  ADMIN_RESET_UPDATE_SQL,
  ADMIN_RESET_USAGE,
  parseAdminResetArgv,
  randomAdminPassword,
  runAdminReset,
  type AdminResetDeps,
  type AdminResetQueryRunner,
} from '../src/admin-reset';
import { hashPassword, verifyPassword, type ScryptParams } from '../src/admin/admin-password';

/**
 * hatch CLI（规格 §2.13；判据「CLI 建/复位/随机口令/stdout 两行/exit」）。
 *
 * 形态：`runAdminReset(argv, deps)` 是被测函数（**纯编排 + 注入的库/哈希/随机/环境**），
 * `main()` 只做「接真 AppDataSource + 打两行 + 置 exitCode」（入口守卫按 argv[1] 判——
 * 照 `alert-relay/src/server.ts:233-243` 的既有形态，vitest 里 import 不会自跑）。
 *
 * 契约：**stdout 恰好两行**（`reset <username>: ok` + 口令来源三档之一；env 档**不回显值**）、
 * 失败 ⇒ stderr 用法 + exit 1 且**不碰库**；新建/复位与留痕**同事务**（假库记 txId）。
 * 口令优先序 = `--password` > `ADMIN_RESET_PASSWORD` > 随机（24 字符 base64url）。
 */

const SMALL_SCRYPT: ScryptParams = { N: 4096, r: 8, p: 1, maxmem: 16 * 1024 * 1024, keylen: 32 };
const RANDOM_PW = 'RandomPw-0123456789abcde'; // 恰 24 字符（生产档 `randomBytes(18).toString('base64url')` 的长度）

interface FakeCliAccountRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  status: string;
}

interface FakeCliChangeRow {
  target_id: number;
  username: string;
  action: string;
  detail: string | null;
  actor: string;
}

class FakeResetDb {
  accounts: FakeCliAccountRow[] = [];
  changes: FakeCliChangeRow[] = [];
  queries: Array<{ sql: string; params: unknown[]; txId: number }> = [];
  transactionFails = false;
  private nextId = 1;
  private txSeq = 0;
  private currentTx = 0;

  addAccount(over: Partial<FakeCliAccountRow> & { username: string }): FakeCliAccountRow {
    const row: FakeCliAccountRow = {
      id: this.nextId++,
      password_hash: 'seeded-placeholder-hash',
      role: 'viewer',
      status: 'active',
      ...over,
    };
    this.accounts.push(row);
    return row;
  }

  readonly manager = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => this.exec(sql, params),
  };

  readonly transaction: AdminResetDeps['transaction'] = async <T,>(
    cb: (manager: AdminResetQueryRunner) => Promise<T>,
  ): Promise<T> => {
    if (this.transactionFails) throw new Error('db down');
    const txId = ++this.txSeq;
    this.currentTx = txId;
    try {
      return await cb(this.manager);
    } finally {
      this.currentTx = 0;
    }
  };

  private async exec(sql: string, params: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params, txId: this.currentTx });
    if (sql === ADMIN_RESET_SELECT_SQL) {
      const row = this.accounts.find((a) => a.username === params[0]);
      return row ? [{ id: row.id, username: row.username }] : [];
    }
    if (sql === ADMIN_RESET_INSERT_SQL) {
      const [username, password_hash, role] = params as [string, string, string];
      if (this.accounts.some((a) => a.username === username)) throw new Error('duplicate');
      const row: FakeCliAccountRow = {
        id: this.nextId++,
        username,
        password_hash,
        role,
        status: 'active',
      };
      this.accounts.push(row);
      return { insertId: row.id };
    }
    if (sql === ADMIN_RESET_UPDATE_SQL) {
      const [password_hash, status, username] = params as [string, string, string];
      const row = this.accounts.find((a) => a.username === username);
      if (!row) return { affected: 0 };
      row.password_hash = password_hash;
      row.status = status;
      return { affected: 1 };
    }
    if (sql === ADMIN_ACCOUNT_CHANGE_INSERT_SQL) {
      const [target_id, username, action, detail, actor] = params as [
        number,
        string,
        string,
        string | null,
        string,
      ];
      this.changes.push({ target_id: Number(target_id), username, action, detail, actor });
      return { insertId: this.changes.length };
    }
    throw new Error(`FakeResetDb: 未识别的 SQL：${sql}`);
  }
}

const makeDeps = (db: FakeResetDb, over: Partial<AdminResetDeps> = {}): AdminResetDeps => ({
  transaction: db.transaction,
  hash: (plain) => hashPassword(plain, SMALL_SCRYPT),
  randomPassword: () => RANDOM_PW,
  envPassword: () => null,
  ...over,
});

describe('parseAdminResetArgv（命令行解析；node:util parseArgs）', () => {
  it('合法拼法；未知旗标 / 缺值 / 位置参数个数不对 ⇒ null（调用方打印用法）', () => {
    expect(parseAdminResetArgv(['alice'])).toEqual({
      username: 'alice',
      role: undefined,
      password: undefined,
    });
    expect(parseAdminResetArgv(['alice', '--role', 'finance', '--password', 'secret'])).toEqual({
      username: 'alice',
      role: 'finance',
      password: 'secret',
    });
    expect(parseAdminResetArgv([])).toBeNull();
    expect(parseAdminResetArgv(['a', 'b'])).toBeNull();
    expect(parseAdminResetArgv(['alice', '--nope'])).toBeNull();
    expect(parseAdminResetArgv(['alice', '--role'])).toBeNull(); // 缺值
  });
});

describe('runAdminReset（规格 §2.13 逐字）', () => {
  it('建号：不存在 ⇒ 按 --role 缺省 super_admin 建 + **同事务** create 留痕 actor=cli；stdout 恰好两行', async () => {
    const db = new FakeResetDb();

    const outcome = await runAdminReset(['Alice'], makeDeps(db));

    expect(outcome).toEqual({
      stdout: ['reset alice: ok', `new password: ${RANDOM_PW}`],
      stderr: [],
      exitCode: 0,
    });
    expect(db.accounts).toHaveLength(1);
    expect(db.accounts[0]).toMatchObject({ username: 'alice', role: 'super_admin', status: 'active' });
    await expect(verifyPassword(RANDOM_PW, db.accounts[0]!.password_hash)).resolves.toBe(true);
    expect(db.changes).toEqual([
      { target_id: 1, username: 'alice', action: 'create', detail: null, actor: 'cli' },
    ]);
    // 同事务：账号 INSERT 与留痕 INSERT 共享 txId，且都在事务内（txId>0）
    const insert = db.queries.find((q) => q.sql === ADMIN_RESET_INSERT_SQL)!;
    const change = db.queries.find((q) => q.sql === ADMIN_ACCOUNT_CHANGE_INSERT_SQL)!;
    expect(insert.txId).toBeGreaterThan(0);
    expect(change.txId).toBe(insert.txId);
  });

  it('建号：`--role` 指定角色生效；用户名大小写归一后落地', async () => {
    const db = new FakeResetDb();

    const outcome = await runAdminReset(['Bob.Smith', '--role', 'finance'], makeDeps(db));

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout[0]).toBe('reset bob.smith: ok');
    expect(db.accounts[0]).toMatchObject({ username: 'bob.smith', role: 'finance' });
  });

  it('复位：已存在 ⇒ 换哈希 + 强制 active（原本 disabled 也拉活）+ password_reset 留痕 actor=cli；角色不动', async () => {
    const db = new FakeResetDb();
    const target = db.addAccount({ username: 'carol', role: 'finance', status: 'disabled' });

    const outcome = await runAdminReset(
      ['carol', '--role', 'super_admin', '--password', 'brand-new-password'],
      makeDeps(db),
    );

    expect(outcome).toEqual({
      stdout: ['reset carol: ok', 'password: (from argument)'],
      stderr: [],
      exitCode: 0,
    });
    expect(db.accounts).toHaveLength(1); // 没新建
    expect(db.accounts[0]!.role).toBe('finance'); // --role 只对新建生效
    expect(db.accounts[0]!.status).toBe('active'); // 强制 active
    await expect(verifyPassword('brand-new-password', db.accounts[0]!.password_hash)).resolves.toBe(
      true,
    );
    expect(db.changes).toEqual([
      { target_id: target.id, username: 'carol', action: 'password_reset', detail: null, actor: 'cli' },
    ]);
    const update = db.queries.find((q) => q.sql === ADMIN_RESET_UPDATE_SQL)!;
    const change = db.queries.find((q) => q.sql === ADMIN_ACCOUNT_CHANGE_INSERT_SQL)!;
    expect(update.txId).toBeGreaterThan(0);
    expect(change.txId).toBe(update.txId);
  });

  it('env 档：ADMIN_RESET_PASSWORD 供口令 ⇒ 第 2 行逐字且**不回显值**', async () => {
    const db = new FakeResetDb();
    const envPw = 'env-secret-password';

    const outcome = await runAdminReset(['dave'], makeDeps(db, { envPassword: () => envPw }));

    expect(outcome.stdout).toEqual(['reset dave: ok', 'password: (from ADMIN_RESET_PASSWORD)']);
    expect(outcome.stdout.join('\n')).not.toContain(envPw); // 不回显
    await expect(verifyPassword(envPw, db.accounts[0]!.password_hash)).resolves.toBe(true);
  });

  it('优先序：`--password` > `ADMIN_RESET_PASSWORD` > 随机（env 在场仍取参数档）', async () => {
    const db = new FakeResetDb();

    const outcome = await runAdminReset(
      ['erin', '--password', 'from-arg-password'],
      makeDeps(db, { envPassword: () => 'env-password-here' }),
    );

    expect(outcome.stdout).toEqual(['reset erin: ok', 'password: (from argument)']);
    await expect(verifyPassword('from-arg-password', db.accounts[0]!.password_hash)).resolves.toBe(
      true,
    );
  });

  it('随机档：第 2 行 `new password: <pw>`；空串 env = 未设 ⇒ 落到随机（空串不被当有效口令）', async () => {
    const db = new FakeResetDb();

    const outcome = await runAdminReset(['frank'], makeDeps(db, { envPassword: () => '' }));

    expect(outcome.stdout).toEqual(['reset frank: ok', `new password: ${RANDOM_PW}`]);
  });

  it('随机口令生成器：randomBytes(18).toString(base64url) = 恰 24 字符、base64url 字符集', () => {
    const pw = randomAdminPassword();
    expect(pw).toHaveLength(24);
    expect(pw).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(randomAdminPassword()).not.toBe(pw); // 每次新取
  });

  it('用法失败（exit 1、stderr 用法、stdout 空、**不碰库**）：非法用户名 / 缺参 / 多参 / 未知旗标 / 缺值 / 非法角色', async () => {
    const cases: string[][] = [
      [],
      ['a'], // 太短（正则 3..32）
      ['Bad Name'], // 空白被正则拒
      ['ok.name', 'extra'], // 两个位置参数
      ['ok.name', '--nope'], // 未知旗标
      ['ok.name', '--role'], // 缺值
      ['ok.name', '--role', 'root'], // 角色不在四值内
    ];
    for (const argv of cases) {
      const db = new FakeResetDb();

      const outcome = await runAdminReset(argv, makeDeps(db));

      expect(outcome.exitCode, JSON.stringify(argv)).toBe(1);
      expect(outcome.stdout, JSON.stringify(argv)).toEqual([]);
      expect(outcome.stderr, JSON.stringify(argv)).toEqual([ADMIN_RESET_USAGE]);
      expect(db.queries, JSON.stringify(argv)).toEqual([]); // 用法错 ⇒ 零库操作
    }
  });

  it('DB 失败（transaction 抛）⇒ exit 1、stderr 带原因、stdout 空（CLI 契约只有 0/1 两档）', async () => {
    const db = new FakeResetDb();
    db.transactionFails = true;

    const outcome = await runAdminReset(['grace'], makeDeps(db));

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toEqual([]);
    expect(outcome.stderr.join('\n')).toContain('db down');
  });
});
