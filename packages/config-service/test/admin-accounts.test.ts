import 'reflect-metadata';
import {
  Logger,
  Module,
  ValidationPipe,
  type DynamicModule,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { ADMIN_HEADER } from '../src/config/admin.controller';
import { AccountsController, ADMIN_ACTOR_HEADER } from '../src/admin/accounts.controller';
import {
  ACCOUNTS_LIST_LIMIT,
  ADMIN_SUPER_LOCK_SQL,
  AdminAccountsService,
} from '../src/admin/admin-accounts.service';
import { verifyPassword, type ScryptParams } from '../src/admin/admin-password';

/**
 * 账号管理 REST（规格 §2.4；判据 C12/C13/C14）——`GET/POST/PATCH /api/admin/accounts[/:id]`。
 *
 * 形态：**真 Nest 管线**（真 controller + 真 XAdminGuard + 真异常过滤器 + globalPrefix `api`）
 * + 真 `AdminAccountsService` + 假 `DataSource`（内存表 + SQL 记录器）。状态码/信封不是手写的。
 *
 * 判据（逐条 = 规格 §2.4）：
 *  - CRUD 正反、唯一键冲突 409、id/username/password/role/status 校验 400 全档；
 *  - **闸 1**「任何自身角色变更一律拒」+ 停自己（改自己口令允许）；
 *  - **闸 2** 锁定读 SQL **全文相等**断言 + size==1 且目标 ∈ 集合 ⇒ 409（改前执行）；
 *  - **闸 3** 停用行仅改口令合法且 status 不变（不偷渡启用）；
 *  - 变更留痕四动作（create/role/disable/enable/password_reset）+ detail + actor，
 *    一次请求多字段 ⇒ 多行，且**与写入同事务**（假库记 txId）；
 *  - 列表无 `password_hash`、行序 id ASC、时间 epoch ms、⚙️10 防御上限 200。
 *
 * ⚠️ 假库不建模行锁/并发（同 `config-probe.ts` 夹具的取舍）：锁定读的判别力在"SQL 全文 + 触发
 * 条件 + size==1 判定"三处；**并发互降负例的载体是 slice-19**（规格 S7 已裁定，本件不承诺）。
 */

const SMALL_SCRYPT: ScryptParams = { N: 4096, r: 8, p: 1, maxmem: 16 * 1024 * 1024, keylen: 32 };

/** 常用 actor / 守卫头（X-Admin 由网关注入；本任务的测试直接注入头值——T5 才把网关接上）。 */
const ACTOR = 'root.admin';
const AUTH = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: ACTOR };

/* ------------------------------------------------------------------ *
 * 假 DataSource（内存表 + SQL 全文记录器 + 事务 txId）
 * ------------------------------------------------------------------ */

interface FakeAccountRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

interface FakeChangeRow {
  target_id: number;
  username: string;
  action: string;
  detail: string | null;
  actor: string;
}

interface RecordedQuery {
  sql: string;
  params: unknown[];
  /** 0 = 事务外；>0 = 某次 transaction() 调用（同号 = 同事务）。 */
  txId: number;
}

const TARGET_SELECT_PREFIX = 'SELECT id, username, role, status FROM admin_accounts WHERE id = ?';
const LIST_SELECT_PREFIX =
  'SELECT id, username, role, status, created_at, last_login_at FROM admin_accounts ORDER BY id ASC LIMIT 201';
const INSERT_ACCOUNT_PREFIX = 'INSERT INTO admin_accounts (username, password_hash, role) VALUES (?, ?, ?)';
const INSERT_CHANGE_PREFIX =
  'INSERT INTO admin_account_changes (target_id, username, action, detail, actor) VALUES (?, ?, ?, ?, ?)';
const UPDATE_PREFIX = 'UPDATE admin_accounts SET ';

class FakeAdminDb {
  accounts: FakeAccountRow[] = [];
  changes: FakeChangeRow[] = [];
  queries: RecordedQuery[] = [];
  private nextId = 1;
  private txSeq = 0;
  private currentTx = 0;

  /** 直插一行（测试造数；password_hash 缺省为占位串——只在断言"新哈希"的用例里改用真哈希）。 */
  addAccount(over: Partial<FakeAccountRow> & { username: string }): FakeAccountRow {
    const row: FakeAccountRow = {
      id: this.nextId++,
      password_hash: 'seeded-placeholder-hash',
      role: 'viewer',
      status: 'active',
      created_at: new Date('2026-10-05T00:00:00.000Z'),
      updated_at: new Date('2026-10-05T00:00:00.000Z'),
      last_login_at: null,
      ...over,
    };
    this.accounts.push(row);
    return row;
  }

  reset(): void {
    this.accounts = [];
    this.changes = [];
    this.queries = [];
    this.nextId = 1;
    this.txSeq = 0;
    this.currentTx = 0;
  }

  readonly manager = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => this.exec(sql, params),
  };

  readonly dataSource = {
    query: (sql: string, params?: unknown[]): Promise<unknown> => this.exec(sql, params ?? []),
    transaction: async <T,>(
      cb: (m: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>,
    ): Promise<T> => {
      const txId = ++this.txSeq;
      this.currentTx = txId;
      try {
        return await cb(this.manager);
      } finally {
        this.currentTx = 0;
      }
    },
  };

  private async exec(sql: string, params: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params, txId: this.currentTx });

    if (sql === ADMIN_SUPER_LOCK_SQL) {
      return this.accounts
        .filter((a) => a.role === 'super_admin' && a.status === 'active')
        .map((a) => ({ id: a.id, role: a.role, status: a.status }));
    }
    if (sql === TARGET_SELECT_PREFIX) {
      const row = this.accounts.find((a) => a.id === Number(params[0]));
      return row ? [{ ...row }] : [];
    }
    if (sql === LIST_SELECT_PREFIX) {
      return [...this.accounts].sort((a, b) => a.id - b.id).slice(0, 201).map((r) => ({ ...r }));
    }
    if (sql === INSERT_CHANGE_PREFIX) {
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
    if (sql === INSERT_ACCOUNT_PREFIX) {
      const [username, password_hash, role] = params as [string, string, string];
      if (this.accounts.some((a) => a.username === username)) {
        const err = new Error(`Duplicate entry '${username}' for key 'uk_admin_username'`) as Error & {
          driverError: { code: string; errno: number };
        };
        err.driverError = { code: 'ER_DUP_ENTRY', errno: 1062 };
        throw err;
      }
      const row: FakeAccountRow = {
        id: this.nextId++,
        username,
        password_hash,
        role,
        status: 'active',
        created_at: new Date('2026-10-05T01:00:00.000Z'),
        updated_at: new Date('2026-10-05T01:00:00.000Z'),
        last_login_at: null,
      };
      this.accounts.push(row);
      return { insertId: row.id };
    }
    if (sql.startsWith(UPDATE_PREFIX)) {
      const m = /^UPDATE admin_accounts SET (.+) WHERE id = \?$/.exec(sql);
      if (!m) throw new Error(`FakeAdminDb: UPDATE 形态不认识：${sql}`);
      const fields = m[1]!.split(', ').map((assignment) => assignment.split(' = ')[0]!);
      const id = Number(params[params.length - 1]);
      const row = this.accounts.find((a) => a.id === id);
      if (!row) return { affected: 0 };
      fields.forEach((field, i) => {
        (row as unknown as Record<string, unknown>)[field] = params[i];
      });
      return { affected: 1 };
    }
    throw new Error(`FakeAdminDb: 未识别的 SQL：${sql}`);
  }
}

/* ------------------------------------------------------------------ *
 * 真 Nest 管线的 HTTP 探针（GET/POST/PATCH；形态照 test/helpers/config-probe.ts）
 * ------------------------------------------------------------------ */

interface HttpResult<T = any> {
  status: number;
  body: T;
}

@Module({})
class AccountsProbeModule {
  static wiring(svc: AdminAccountsService): DynamicModule {
    return {
      module: AccountsProbeModule,
      controllers: [AccountsController],
      providers: [{ provide: AdminAccountsService, useValue: svc }],
    };
  }
}

interface Probe {
  get: (path: string, headers?: Record<string, string>) => Promise<HttpResult>;
  postJson: (path: string, body: unknown, headers?: Record<string, string>) => Promise<HttpResult>;
  patchJson: (path: string, body: unknown, headers?: Record<string, string>) => Promise<HttpResult>;
  close: () => Promise<void>;
}

async function startProbe(db: FakeAdminDb): Promise<Probe> {
  // 小参注入：生产默认参哈希 ~1s/次，会把本文件拖慢一个量级（规格 §2.1 单测口径）
  const svc = new AdminAccountsService(db.dataSource as unknown as DataSource, SMALL_SCRYPT);
  const app: INestApplication = await NestFactory.create(AccountsProbeModule.wiring(svc), {
    logger: false,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const request = async (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  };

  return {
    get: (path, headers) => request('GET', path, undefined, headers),
    postJson: (path, body, headers) => request('POST', path, body, headers),
    patchJson: (path, body, headers) => request('PATCH', path, body, headers),
    close: async () => {
      await app.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

const db = new FakeAdminDb();
let probe: Probe;

beforeAll(async () => {
  probe = await startProbe(db);
});
afterAll(async () => {
  await probe.close();
});
beforeEach(() => {
  db.reset();
});

describe('X-Admin fail-closed（新控制器同样在守卫之下）', () => {
  it('三个端点无 X-Admin ⇒ 401 + 10002，且碰不到 handler（假库零查询）', async () => {
    const get = await probe.get('/api/admin/accounts');
    expect(get.status).toBe(401);
    expect(get.body.code).toBe(ErrCode.UNAUTHENTICATED);
    expect(get.body.data).toBeNull();

    const post = await probe.postJson('/api/admin/accounts', {
      username: 'gate.test',
      password: 'gate-test-password',
      role: 'viewer',
    });
    expect(post.status).toBe(401);

    const patch = await probe.patchJson('/api/admin/accounts/1', { role: 'viewer' });
    expect(patch.status).toBe(401);

    expect(db.queries).toEqual([]);
  });
});

describe('POST /api/admin/accounts（建号；§2.4）', () => {
  it('正例：用户名小写归一出站、scrypt 落库（非明文）、status=active、同事务落 create 留痕', async () => {
    const res = await probe.postJson(
      '/api/admin/accounts',
      { username: 'Alice.Game', password: 'long-enough-pw', role: 'operator' },
      AUTH,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { id: 1, username: 'alice.game', role: 'operator', status: 'active' },
    });

    const row = db.accounts[0]!;
    expect(row.username).toBe('alice.game'); // 入库即小写（⚙️8）
    expect(row.role).toBe('operator');
    expect(row.status).toBe('active');
    expect(row.password_hash).not.toContain('long-enough-pw'); // 永不出明文
    await expect(verifyPassword('long-enough-pw', row.password_hash)).resolves.toBe(true);

    expect(db.changes).toHaveLength(1);
    expect(db.changes[0]).toMatchObject({
      target_id: 1,
      username: 'alice.game',
      action: 'create',
      actor: ACTOR,
    });
    expect(JSON.parse(db.changes[0]!.detail!)).toEqual({ role: 'operator' });

    // 同事务：账号 INSERT 与留痕 INSERT 共享 txId，且都在事务内（txId>0）
    const accountInsert = db.queries.find((q) => q.sql === INSERT_ACCOUNT_PREFIX)!;
    const changeInsert = db.queries.find((q) => q.sql === INSERT_CHANGE_PREFIX)!;
    expect(accountInsert.txId).toBeGreaterThan(0);
    expect(changeInsert.txId).toBe(accountInsert.txId);
  });

  it('用户名冲突 ⇒ 409 借 10001「用户名已存在」，不落新行、不留痕', async () => {
    db.addAccount({ username: 'dup.user' });

    const res = await probe.postJson(
      '/api/admin/accounts',
      { username: 'Dup.User', password: 'some-password-10', role: 'viewer' },
      AUTH,
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: ErrCode.BAD_PARAM, message: '用户名已存在', data: null });
    expect(db.accounts).toHaveLength(1);
    expect(db.changes).toEqual([]);
  });

  it('校验 400 全档：username（缺/非串/短长/非法字符）', async () => {
    const badUsernames: Array<[string, unknown]> = [
      ['缺失', undefined],
      ['非字符串', 123],
      ['短（2 位）', 'ab'],
      ['长（33 位）', 'a'.repeat(33)],
      ['前导点', '.abc'],
      ['含空格', 'bad name'],
      ['含非法字符', 'abc!'],
      ['非 ASCII', '管理员'],
    ];
    for (const [label, username] of badUsernames) {
      const res = await probe.postJson(
        '/api/admin/accounts',
        { username, password: 'good-password-10', role: 'viewer' },
        AUTH,
      );
      expect(res.status, label).toBe(400);
      expect(res.body.code, label).toBe(ErrCode.BAD_PARAM);
      expect(res.body.message, label).toBe('用户名格式不符：3–32 位小写字母/数字/._-');
    }
    expect(db.accounts).toEqual([]);
  });

  it('校验 400 全档：password（缺/非串/9 位/73 位）', async () => {
    const badPasswords: Array<[string, unknown]> = [
      ['缺失', undefined],
      ['非字符串', 12345678901],
      ['短（9 位）', 'a'.repeat(9)],
      ['长（73 位）', 'a'.repeat(73)],
    ];
    for (const [label, password] of badPasswords) {
      const res = await probe.postJson(
        '/api/admin/accounts',
        { username: 'valid.name', password, role: 'viewer' },
        AUTH,
      );
      expect(res.status, label).toBe(400);
      expect(res.body.message, label).toBe('口令长度须为 10–72 字符');
    }
    expect(db.accounts).toEqual([]);
  });

  it('校验 400 全档：role（缺/不在四值内/大写变体）', async () => {
    for (const role of [undefined, 'admin', 'superadmin', 'SUPER_ADMIN', 7]) {
      const res = await probe.postJson(
        '/api/admin/accounts',
        { username: 'valid.name', password: 'good-password-10', role },
        AUTH,
      );
      expect(res.status, JSON.stringify(role)).toBe(400);
      expect(res.body.code, JSON.stringify(role)).toBe(ErrCode.BAD_PARAM);
    }
    expect(db.accounts).toEqual([]);
  });

  it('actor 头缺失/非法 ⇒ 401 + 10002「管理身份缺失」（fail-closed，不回退）', async () => {
    const noActor = await probe.postJson(
      '/api/admin/accounts',
      { username: 'valid.name', password: 'good-password-10', role: 'viewer' },
      { [ADMIN_HEADER]: '1' },
    );
    expect(noActor.status).toBe(401);
    expect(noActor.body).toEqual({
      code: ErrCode.UNAUTHENTICATED,
      message: '管理身份缺失',
      data: null,
    });

    const badActor = await probe.postJson(
      '/api/admin/accounts',
      { username: 'valid.name', password: 'good-password-10', role: 'viewer' },
      { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'Has Space' },
    );
    expect(badActor.status).toBe(401);

    expect(db.accounts).toEqual([]);
  });
});

describe('GET /api/admin/accounts（列表；§2.4 / ⚙️10）', () => {
  it('行序 id ASC、时间 epoch ms、lastLoginAt 可 null、响应永无 password_hash', async () => {
    db.addAccount({ username: 'zzz.user', role: 'viewer' });
    db.addAccount({
      username: 'aaa.admin',
      role: 'super_admin',
      last_login_at: new Date('2026-10-05T08:30:00.000Z'),
    });
    db.addAccount({ username: 'mmm.fin', role: 'finance', status: 'disabled' });

    const res = await probe.get('/api/admin/accounts', { [ADMIN_HEADER]: '1' }); // 读面不需要 actor

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(ErrCode.OK);
    const accounts = res.body.data.accounts as Array<Record<string, unknown>>;
    expect(accounts.map((a) => a.username)).toEqual(['zzz.user', 'aaa.admin', 'mmm.fin']); // id ASC
    for (const a of accounts) {
      expect(Object.keys(a).sort()).toEqual([
        'createdAt',
        'id',
        'lastLoginAt',
        'role',
        'status',
        'username',
      ]);
      expect(typeof a.createdAt).toBe('number'); // epoch ms（⚙️1）
    }
    expect(accounts[0]!.lastLoginAt).toBeNull();
    expect(accounts[1]!.lastLoginAt).toBe(Date.parse('2026-10-05T08:30:00.000Z'));

    // password_hash 永不出站：键与值（占位串）都不得出现在响应原文里
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('seeded-placeholder-hash');
  });

  it('⚙️10 防御上限：>200 行 ⇒ 照出前 200 行（id ASC）并记日志', async () => {
    for (let i = 1; i <= 205; i += 1) db.addAccount({ username: `user.${String(i).padStart(3, '0')}` });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      const res = await probe.get('/api/admin/accounts', { [ADMIN_HEADER]: '1' });

      expect(res.status).toBe(200);
      const accounts = res.body.data.accounts as Array<{ id: number }>;
      expect(accounts).toHaveLength(ACCOUNTS_LIST_LIMIT); // 200，不是 205
      expect(accounts[0]!.id).toBe(1);
      expect(accounts[199]!.id).toBe(200);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('200'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('PATCH /api/admin/accounts/:id（更新；§2.4）', () => {
  it('正例：改角色 ⇒ role 留痕 {from,to}、UPDATE 与留痕同事务、非超管不触发锁定读', async () => {
    const target = db.addAccount({ username: 'target.user', role: 'viewer' });

    const res = await probe.patchJson(`/api/admin/accounts/${target.id}`, { role: 'finance' }, AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { id: target.id, username: 'target.user', role: 'finance', status: 'active' },
    });
    expect(db.accounts[0]!.role).toBe('finance');

    expect(db.changes).toHaveLength(1);
    expect(db.changes[0]).toMatchObject({ action: 'role', actor: ACTOR });
    expect(JSON.parse(db.changes[0]!.detail!)).toEqual({ from: 'viewer', to: 'finance' });

    const update = db.queries.find((q) => q.sql === 'UPDATE admin_accounts SET role = ? WHERE id = ?')!;
    const changeInsert = db.queries.find((q) => q.sql === INSERT_CHANGE_PREFIX)!;
    expect(update.txId).toBeGreaterThan(0);
    expect(changeInsert.txId).toBe(update.txId);
    expect(db.queries.some((q) => q.sql === ADMIN_SUPER_LOCK_SQL)).toBe(false); // 非「停用/降超管」
  });

  it('正例：停用 ⇒ disable 留痕；启用 ⇒ enable 留痕；同值重设 = 无操作（不落行）', async () => {
    const target = db.addAccount({ username: 'toggle.user', role: 'viewer' });

    const off = await probe.patchJson(`/api/admin/accounts/${target.id}`, { status: 'disabled' }, AUTH);
    expect(off.status).toBe(200);
    expect(off.body.data.status).toBe('disabled');
    expect(db.changes.map((c) => c.action)).toEqual(['disable']);
    expect(db.changes[0]!.detail).toBeNull();

    const on = await probe.patchJson(`/api/admin/accounts/${target.id}`, { status: 'active' }, AUTH);
    expect(on.status).toBe(200);
    expect(db.changes.map((c) => c.action)).toEqual(['disable', 'enable']);

    // 同值重设（无实际变更）：200 空转，无 UPDATE、无新留痕行
    const before = db.queries.length;
    const noop = await probe.patchJson(`/api/admin/accounts/${target.id}`, { status: 'active' }, AUTH);
    expect(noop.status).toBe(200);
    expect(db.changes).toHaveLength(2);
    expect(db.queries.slice(before).some((q) => q.sql.startsWith(UPDATE_PREFIX))).toBe(false);
  });

  it('正例：重置口令 ⇒ password_reset（detail null）、新哈希可验、角色状态不动', async () => {
    const target = db.addAccount({ username: 'pw.user', role: 'operator' });

    const res = await probe.patchJson(
      `/api/admin/accounts/${target.id}`,
      { password: 'brand-new-password' },
      AUTH,
    );

    expect(res.status).toBe(200);
    await expect(verifyPassword('brand-new-password', db.accounts[0]!.password_hash)).resolves.toBe(true);
    expect(db.accounts[0]!.role).toBe('operator');
    expect(db.changes).toEqual([
      { target_id: target.id, username: 'pw.user', action: 'password_reset', detail: null, actor: ACTOR },
    ]);
  });

  it('多字段一次变更 ⇒ 单条 UPDATE + 逐动作三行留痕（role→disable→password_reset 序）', async () => {
    const target = db.addAccount({ username: 'multi.user', role: 'viewer' });

    const res = await probe.patchJson(
      `/api/admin/accounts/${target.id}`,
      { role: 'finance', status: 'disabled', password: 'another-password' },
      AUTH,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: target.id,
      username: 'multi.user',
      role: 'finance',
      status: 'disabled',
    });
    expect(db.queries.filter((q) => q.sql.startsWith(UPDATE_PREFIX))).toEqual([
      {
        sql: 'UPDATE admin_accounts SET role = ?, status = ?, password_hash = ? WHERE id = ?',
        params: ['finance', 'disabled', db.accounts[0]!.password_hash, target.id],
        txId: expect.any(Number),
      },
    ]);
    expect(db.changes.map((c) => c.action)).toEqual(['role', 'disable', 'password_reset']);
    // 三行留痕与 UPDATE 同事务
    const updateTx = db.queries.find((q) => q.sql.startsWith(UPDATE_PREFIX))!.txId;
    for (const q of db.queries.filter((q) => q.sql === INSERT_CHANGE_PREFIX)) {
      expect(q.txId).toBe(updateTx);
    }
  });

  it(':id 非十进制整数 ⇒ 400「账号 ID 非法」（小数/负数/科学计数/超安全整数/空段）', async () => {
    for (const id of ['abc', '1.5', '-1', '1e3', '99999999999999999999', ' 1']) {
      const res = await probe.patchJson(`/api/admin/accounts/${encodeURIComponent(id)}`, { role: 'viewer' }, AUTH);
      expect(res.status, id).toBe(400);
      expect(res.body.message, id).toBe('账号 ID 非法');
    }
    expect(db.queries).toEqual([]); // 未碰库
  });

  it('行不存在 ⇒ 404 借 10001「账号不存在」', async () => {
    const res = await probe.patchJson('/api/admin/accounts/999', { role: 'viewer' }, AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: ErrCode.BAD_PARAM, message: '账号不存在', data: null });
    expect(db.changes).toEqual([]);
  });

  it('子集校验 400：role/status/password 非法值', async () => {
    const target = db.addAccount({ username: 'sub.user' });
    const badBodies: Array<[string, unknown]> = [
      ['role 非法', { role: 'admin' }],
      ['role 非串', { role: 7 }],
      ['status 非法', { status: 'enabled' }],
      ['status 非串', { status: true }],
      ['password 短', { password: 'a'.repeat(9) }],
      ['password 长', { password: 'a'.repeat(73) }],
      ['password 非串', { password: 12345678901 }],
    ];
    for (const [label, body] of badBodies) {
      const res = await probe.patchJson(`/api/admin/accounts/${target.id}`, body, AUTH);
      expect(res.status, label).toBe(400);
      expect(res.body.code, label).toBe(ErrCode.BAD_PARAM);
    }
    expect(db.changes).toEqual([]); // 400 一律不留痕
  });

  it('actor 头缺失 ⇒ 401（写面 fail-closed）', async () => {
    const target = db.addAccount({ username: 'guarded.user' });
    const res = await probe.patchJson(
      `/api/admin/accounts/${target.id}`,
      { role: 'finance' },
      { [ADMIN_HEADER]: '1' },
    );
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('管理身份缺失');
    expect(db.changes).toEqual([]);
  });
});

describe('自锁闸 1：不能停用/变更自己（任何方向）（§2.4-1；S5）', () => {
  it('停自己 ⇒ 409（即使另有超管在场），行不动、无留痕', async () => {
    const me = db.addAccount({ username: ACTOR, role: 'super_admin' });
    db.addAccount({ username: 'other.admin', role: 'super_admin' });

    const res = await probe.patchJson(`/api/admin/accounts/${me.id}`, { status: 'disabled' }, AUTH);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: ErrCode.BAD_PARAM,
      message: '不能停用或变更自己的角色',
      data: null,
    });
    expect(db.accounts.find((a) => a.id === me.id)!.status).toBe('active');
    expect(db.changes).toEqual([]);
  });

  it('改自己角色一律拒——降级、升级、横向（operator→finance）三个方向', async () => {
    const me = db.addAccount({ username: ACTOR, role: 'operator' });

    for (const role of ['viewer', 'super_admin', 'finance']) {
      const res = await probe.patchJson(`/api/admin/accounts/${me.id}`, { role }, AUTH);
      expect(res.status, role).toBe(409);
      expect(res.body.message, role).toBe('不能停用或变更自己的角色');
    }
    expect(db.accounts.find((a) => a.id === me.id)!.role).toBe('operator');
  });

  it('反向：改自己口令是允许的（闸 1 只拒停用/角色变更）；同值 role 字段不算变更', async () => {
    const me = db.addAccount({ username: ACTOR, role: 'operator' });

    const pw = await probe.patchJson(`/api/admin/accounts/${me.id}`, { password: 'my-new-password' }, AUTH);
    expect(pw.status).toBe(200);
    await expect(verifyPassword('my-new-password', db.accounts.find((a) => a.id === me.id)!.password_hash)).resolves.toBe(true);

    const same = await probe.patchJson(`/api/admin/accounts/${me.id}`, { role: 'operator' }, AUTH);
    expect(same.status).toBe(200); // 字段出现但 = 现值 ⇒ 无变更 ⇒ 放行
  });

  it('反向：他人（非自己）改我的角色/停用我 ⇒ 放行（闸 1 只看 username === actor）', async () => {
    db.addAccount({ username: ACTOR, role: 'viewer' });
    const victim = db.addAccount({ username: 'victim.user', role: 'viewer' });

    const res = await probe.patchJson(`/api/admin/accounts/${victim.id}`, { status: 'disabled' }, AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('disabled');
  });
});

describe('自锁闸 2：最后一名 active 超管（锁定读）（§2.4-2；S7）', () => {
  it('锁定读 SQL 全文逐字（单测按全文相等钉，照 reconcile 先例）', () => {
    expect(ADMIN_SUPER_LOCK_SQL).toBe(
      "SELECT id, role, status FROM admin_accounts WHERE role='super_admin' AND status='active' FOR UPDATE",
    );
  });

  it('size==1 且目标 ∈ 集合：停用最后一名超管 ⇒ 409，且锁定读在 UPDATE 之前', async () => {
    const boss = db.addAccount({ username: 'boss.super', role: 'super_admin' });
    db.addAccount({ username: 'ops.actor', role: 'viewer' });
    const opsAuth = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'ops.actor' };

    const res = await probe.patchJson(`/api/admin/accounts/${boss.id}`, { status: 'disabled' }, opsAuth);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: ErrCode.BAD_PARAM,
      message: '不能停用或降级最后一名超级管理员',
      data: null,
    });
    // 锁定读确实发生（全文相等，不是前缀/近似）+ 在改之前
    const lockIndex = db.queries.findIndex((q) => q.sql === ADMIN_SUPER_LOCK_SQL);
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(db.queries.some((q) => q.sql.startsWith(UPDATE_PREFIX))).toBe(false);
    expect(db.accounts.find((a) => a.id === boss.id)!.status).toBe('active');
    expect(db.changes).toEqual([]);
  });

  it('size==1 且目标 ∈ 集合：把最后一名超管降级出 super_admin ⇒ 409', async () => {
    const boss = db.addAccount({ username: 'boss.super', role: 'super_admin' });
    db.addAccount({ username: 'ops.actor', role: 'viewer' });
    const opsAuth = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'ops.actor' };

    const res = await probe.patchJson(`/api/admin/accounts/${boss.id}`, { role: 'finance' }, opsAuth);

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('不能停用或降级最后一名超级管理员');
    expect(db.accounts.find((a) => a.id === boss.id)!.role).toBe('super_admin');
  });

  it('size==1 但目标 ∉ 集合：停用普通账号不受影响（锁定读照跑、判定不拦）', async () => {
    db.addAccount({ username: ACTOR, role: 'super_admin' }); // 唯一 active 超管 = actor 自己
    const fin = db.addAccount({ username: 'fin.user', role: 'finance' });

    const res = await probe.patchJson(`/api/admin/accounts/${fin.id}`, { status: 'disabled' }, AUTH);

    expect(res.status).toBe(200);
    expect(db.queries.some((q) => q.sql === ADMIN_SUPER_LOCK_SQL)).toBe(true);
    expect(db.changes.map((c) => c.action)).toEqual(['disable']);
  });

  it('size==2 且目标 ∈ 集合：另一名超管执行降级 ⇒ 放行', async () => {
    db.addAccount({ username: 'second.super', role: 'super_admin' });
    const boss = db.addAccount({ username: 'boss.super', role: 'super_admin' });
    db.addAccount({ username: 'ops.actor', role: 'viewer' });
    const opsAuth = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'ops.actor' };

    const res = await probe.patchJson(`/api/admin/accounts/${boss.id}`, { role: 'viewer' }, opsAuth);

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('viewer');
    expect(db.changes.map((c) => c.action)).toEqual(['role']);
  });
});

describe('自锁闸 3：停用不偷渡（§2.4-3；S14）', () => {
  it('停用行「仅改口令」合法 ⇒ 200，且 status 保持 disabled（不隐式启用）', async () => {
    const frozen = db.addAccount({ username: 'frozen.user', role: 'viewer', status: 'disabled' });

    const res = await probe.patchJson(
      `/api/admin/accounts/${frozen.id}`,
      { password: 'fresh-password-10' },
      AUTH,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: frozen.id,
      username: 'frozen.user',
      role: 'viewer',
      status: 'disabled',
    });
    const row = db.accounts.find((a) => a.id === frozen.id)!;
    expect(row.status).toBe('disabled'); // 只有显式 status 字段才改状态
    await expect(verifyPassword('fresh-password-10', row.password_hash)).resolves.toBe(true);
    // 留痕只记 password_reset —— 没有 enable 行
    expect(db.changes.map((c) => c.action)).toEqual(['password_reset']);
  });
});
