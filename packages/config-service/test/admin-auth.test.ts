import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  ADMIN_ENABLED_SQL,
  ADMIN_FIND_ACCOUNT_SQL,
  ADMIN_TOUCH_LOGIN_SQL,
  ADMIN_TOKEN_TTL_SECONDS,
  AdminAuthService,
} from '../src/config/admin-auth.service';
import { LOGIN_EVENT_INSERT_SQL } from '../src/admin/login-events.service';
import { hashPassword, type ScryptParams } from '../src/admin/admin-password';
import { FakeAdminDb, makeService, seedDb, startHttpProbe, type HttpProbe } from './helpers/config-probe';

/**
 * ⚠️ 常数时间路径探针：`admin-password.ts` 用的是**具名导入** `{ timingSafeEqual }`
 * （与默认导入 `crypto` 不是同一 interop 面——`vi.spyOn(crypto, …)` 打不到它），
 * 所以按 vitest 的口径 mock 掉 `node:crypto` 这一整模块、其余原样透传（行为不变，只多记账）。
 */
const timingSafeEqualSpy = vi.hoisted(() => vi.fn());
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  timingSafeEqualSpy.mockImplementation((a: Buffer, b: Buffer) => actual.timingSafeEqual(a, b));
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

/**
 * 登录改版（规格 §2.3 处理序逐字 7 步 + §2.14 失败矩阵；判据 C4/C5/C6/C7 的单测半边）。
 *
 * 矩阵（HTTP 侧全部经**真 Nest 管线**，见 `helpers/config-probe.ts` 头注释）：
 *  - ① 空表（零账号）⇒ **404 借码 10001**「管理面未启用」——且**先于**形状校验（空表 ⇒ 一切皆 404）；
 *  - ② 形状非法（**上界 32**——⚙️19：与 `admin_login_events.username varchar(32)` 列宽对齐；
 *    归一扩长〔如 `İ`〕另有防线）⇒ **400 借码 10001**「参数非法」，**不落事件**（⚙️3）；
 *    登录**不跑用户名正则**（⚙️8）；
 *  - ④ 未知用户名 / ⑤ 错口令 ⇒ **逐字同款 401 10002**「用户名或口令错误」（防枚举），事件照落
 *    （④ `account_id` NULL、⑤ 回填——「查行命中后才回填」的判别力就在这对用例里）；
 *  - ⑥ disabled ⇒ **403 10003**「账号已停用」（⑤ verify 先于 ⑥ ⇒ 停用+错口令仍是 401）；
 *  - ⑦ 成功 ⇒ 200 `{token, expiresIn:7200, username, role}` + `last_login_at=NOW(3)` + 事件 success=1。
 *
 * ⚙️16 钉子：启用谓词 = **表非空**（不是 env）——`ADMIN_PASSWORD` 为空串、账号在库 ⇒ 照登 200；
 * 槽里的哈希用 scrypt **小参**预生成（验证侧从存储串解析 N/r/p，同 `admin-accounts.test.ts` 口径）。
 * 令牌 claims（C7 签发侧）：`{sub:String(id), username, role, aud:'ftl-admin', iat, exp}`。
 */

const PASSWORD = 'correct-horse-battery-staple';
const FROZEN_PASSWORD = 'frozen-account-password';
const SECRET = 'test-admin-jwt-secret';
const SMALL_SCRYPT: ScryptParams = { N: 4096, r: 8, p: 1, maxmem: 16 * 1024 * 1024, keylen: 32 };
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

const asDataSource = (db: FakeAdminDb) => db.dataSource as unknown as DataSource;

afterAll(() => {
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_JWT_SECRET;
});

describe('AdminAuthService（C4/C7 单测半边）', () => {
  it('SQL 常量钉：启用检查 = `SELECT 1 FROM admin_accounts LIMIT 1`（第①步字面）；last_login 更新 = `NOW(3)`（第⑦步字面）', () => {
    expect(ADMIN_ENABLED_SQL).toBe('SELECT 1 FROM admin_accounts LIMIT 1');
    expect(ADMIN_TOUCH_LOGIN_SQL).toBe('UPDATE admin_accounts SET last_login_at=NOW(3) WHERE id=?');
  });

  it('claims 签发：`{sub:String(id), username, role}` + `aud=ftl-admin`；TTL 7200；`sub` 是**字符串**不是数字', () => {
    process.env.ADMIN_JWT_SECRET = SECRET;
    const auth = new AdminAuthService(asDataSource(new FakeAdminDb()));

    const token = auth.signToken({ sub: '7', username: 'alice', role: 'finance' });
    const claims = auth.verifyToken(token);

    expect(claims.sub).toBe('7');
    expect(typeof claims.sub).toBe('string'); // 网关按 string 消费；String(id) 掉了就在这红
    expect(claims.username).toBe('alice');
    expect(claims.role).toBe('finance');
    expect(claims.aud).toBe('ftl-admin');
    expect(claims.exp! - claims.iat!).toBe(7200);
    expect(ADMIN_TOKEN_TTL_SECONDS).toBe(7200);

    // decode（不验签）看原始载荷：JSON 里 sub 也是字符串
    const decoded = new JwtService({ secret: SECRET }).decode<Record<string, unknown>>(token)!;
    expect(decoded.sub).toBe('7');
    expect(typeof decoded.sub).toBe('string');

    // 判别力：过期 ⇒ 抛；换密钥 ⇒ 抛；玩家 aud ⇒ 抛（既有三档保留）
    const expired = new JwtService({ secret: SECRET }).sign(
      { sub: '7', username: 'alice', role: 'finance' },
      { audience: 'ftl-admin', expiresIn: -10 },
    );
    expect(() => auth.verifyToken(expired)).toThrow();
    const foreign = new JwtService({ secret: 'someone-elses-secret' }).sign(
      { sub: '7', username: 'alice', role: 'finance' },
      { audience: 'ftl-admin', expiresIn: '2h' },
    );
    expect(() => auth.verifyToken(foreign)).toThrow();
    const playerAud = new JwtService({ secret: SECRET }).sign(
      { sub: '7', username: 'alice', role: 'finance' },
      { audience: 'ftl-client', expiresIn: '2h' },
    );
    expect(() => auth.verifyToken(playerAud)).toThrow();
  });

  it('口令校验走**库里的 scrypt 哈希**：对 ⇒ true；错 ⇒ false；损坏串 ⇒ false（不抛）', async () => {
    const auth = new AdminAuthService(asDataSource(new FakeAdminDb()));
    const stored = await hashPassword(PASSWORD, SMALL_SCRYPT);

    await expect(auth.verifyPassword(PASSWORD, stored)).resolves.toBe(true);
    await expect(auth.verifyPassword(PASSWORD.slice(0, -1) + 'X', stored)).resolves.toBe(false);
    await expect(auth.verifyPassword('short', stored)).resolves.toBe(false);
    await expect(auth.verifyPassword(PASSWORD, 's1$broken')).resolves.toBe(false);
    await expect(auth.verifyPassword(PASSWORD, '')).resolves.toBe(false);
  });

  it('常数时间路径（`timingSafeEqual`）真的被调用（不是 `===`）', async () => {
    const auth = new AdminAuthService(asDataSource(new FakeAdminDb()));
    const stored = await hashPassword(PASSWORD, SMALL_SCRYPT);
    timingSafeEqualSpy.mockClear();
    try {
      await expect(auth.verifyPassword(PASSWORD, stored)).resolves.toBe(true);
      expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    } finally {
      timingSafeEqualSpy.mockClear();
    }
  });

  it('启用谓词 = **表非空**（不是 env）：空表 ⇒ false；有账号 ⇒ true——`ADMIN_PASSWORD` 清空不影响', async () => {
    delete process.env.ADMIN_PASSWORD;

    const emptyDb = new FakeAdminDb();
    const empty = new AdminAuthService(asDataSource(emptyDb));
    await expect(empty.isEnabled()).resolves.toBe(false);
    expect(emptyDb.queries.map((q) => q.sql)).toEqual([ADMIN_ENABLED_SQL]); // 就是那一条查询

    const db = new FakeAdminDb();
    db.addAccount({ username: 'admin' });
    const enabled = new AdminAuthService(asDataSource(db));
    await expect(enabled.isEnabled()).resolves.toBe(true);
  });

  it('⑤ 密钥链的空串 = 未设（裁决 2026-10-01）：`ADMIN_JWT_SECRET` 为空串 ⇒ 回落 `JWT_SECRET`，带 claims 照签', () => {
    const fallback = 'fallback-from-jwt-secret';
    const prevAdmin = process.env.ADMIN_JWT_SECRET;
    process.env.ADMIN_JWT_SECRET = '';
    process.env.JWT_SECRET = fallback;
    try {
      const auth = new AdminAuthService(asDataSource(new FakeAdminDb()));
      const token = auth.signToken({ sub: '1', username: 'admin', role: 'super_admin' });
      const claims = new JwtService({ secret: fallback }).verify<Record<string, unknown>>(token, {
        audience: 'ftl-admin',
      });
      expect(claims.aud).toBe('ftl-admin');
      expect(claims.sub).toBe('1');
      expect(auth.verifyToken(token).username).toBe('admin');
    } finally {
      if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
      if (prevAdmin === undefined) delete process.env.ADMIN_JWT_SECRET;
      else process.env.ADMIN_JWT_SECRET = prevAdmin;
    }
  });
});

describe('POST /api/admin/login（真管线；§2.3 处理序逐字）', () => {
  let probe: HttpProbe; // 库里有 admin（super_admin）+ frozen（disabled）
  let emptyProbe: HttpProbe; // 零账号
  let db: FakeAdminDb;
  let publish: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.ADMIN_JWT_SECRET = SECRET;
    process.env.ADMIN_PASSWORD = ''; // ⚙️16：env 不再是开关——空串也照登（断言在成功用例）

    db = new FakeAdminDb();
    db.addAccount({
      username: 'admin',
      role: 'super_admin',
      password_hash: await hashPassword(PASSWORD, SMALL_SCRYPT),
    });
    db.addAccount({
      username: 'frozen',
      role: 'viewer',
      status: 'disabled',
      password_hash: await hashPassword(FROZEN_PASSWORD, SMALL_SCRYPT),
    });

    const a = makeService(seedDb());
    publish = a.publish;
    probe = await startHttpProbe(a.svc, db);

    emptyProbe = await startHttpProbe(makeService(seedDb()).svc); // 缺省 = 空 FakeAdminDb
  });

  afterAll(async () => {
    await probe.close();
    await emptyProbe.close();
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_JWT_SECRET;
  });

  beforeEach(() => {
    db.resetLogs();
  });

  const login = (username: unknown, password: unknown, headers?: Record<string, string>) =>
    probe.postJson('/api/admin/login', { username, password }, headers);

  it('① 空表（零账号）⇒ 404 借码 10001「管理面未启用」；且**先于**形状校验（空体也 404，不是 400）', async () => {
    const res = await emptyProbe.postJson('/api/admin/login', { username: 'admin', password: PASSWORD });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: ErrCode.BAD_PARAM, message: '管理面未启用', data: null });

    const malformed = await emptyProbe.postJson('/api/admin/login', {});
    expect(malformed.status).toBe(404); // 第①步先于第②步：空表 ⇒ 一切皆 404
    expect(malformed.body.message).toBe('管理面未启用');
  });

  it('② 形状 400「参数非法」全档（非串/空/超长）且**不落事件**（⚙️3）；上界 32 = 事件列宽（⚙️19）', async () => {
    const cases: Array<[string, unknown, unknown]> = [
      ['username 缺失', undefined, PASSWORD],
      ['username 非串', 123, PASSWORD],
      ['username 空串', '', PASSWORD],
      ['username 超 32', 'a'.repeat(33), PASSWORD],
      ['password 缺失', 'admin', undefined],
      ['password 非串', 'admin', 12345],
      ['password 空串', 'admin', ''],
      ['password 超 1024', 'admin', 'p'.repeat(1025)],
    ];
    for (const [label, username, password] of cases) {
      const res = await probe.postJson('/api/admin/login', { username, password });
      expect(res.status, label).toBe(400);
      expect(res.body, label).toEqual({ code: ErrCode.BAD_PARAM, message: '参数非法', data: null });
    }
    expect(db.events).toEqual([]); // 形状错不是凭据尝试——防灌行
  });

  it('⚙️19 边界：33 字符未知用户名 ⇒ 400「参数非法」、**无事件行、未查行**（防 `varchar(32)` 溢出 500 回归）', async () => {
    const res = await probe.postJson('/api/admin/login', {
      username: 'z'.repeat(33),
      password: PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: ErrCode.BAD_PARAM, message: '参数非法', data: null });
    expect(db.events).toEqual([]); // ← 本用例的核心：溢出路径不许走到落事件
    expect(db.queries.map((q) => q.sql)).toEqual([ADMIN_ENABLED_SQL]); // 只跑了启用检查
  });

  it('⚙️19 边界：32 字符未知用户名（**形状内上沿**）⇒ 401 且**有事件行**（形状内 miss 必落行，原样 32 字符）', async () => {
    const username = 'z'.repeat(32);

    const res = await probe.postJson('/api/admin/login', { username, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('用户名或口令错误');
    expect(db.events).toEqual([{ username, account_id: null, ip: null, success: 0 }]);
  });

  it('归一扩长防线：24×`İ`（原始 24 ≤ 32，`toLowerCase()` 后 48）⇒ 400 且无事件行（事件列永不见超长值）', async () => {
    const raw = 'İ'.repeat(24);
    expect(raw.length).toBe(24); // 形状检查放行的原值
    expect(raw.toLowerCase().length).toBe(48); // 判别力：这个膨胀真的发生（不是空喊）

    const res = await probe.postJson('/api/admin/login', { username: raw, password: PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: ErrCode.BAD_PARAM, message: '参数非法', data: null });
    expect(db.events).toEqual([]);
    expect(db.queries.map((q) => q.sql)).toEqual([ADMIN_ENABLED_SQL]); // 未查行、未落事件
  });

  it('②′ 登录**不跑用户名正则**（⚙️8）：形状合法但字符非法 ⇒ 不是 400，是查无此人 401（事件照落，用户名归一）', async () => {
    const res = await probe.postJson('/api/admin/login', { username: '管理员!', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('用户名或口令错误');
    expect(db.events).toEqual([{ username: '管理员!', account_id: null, ip: null, success: 0 }]);
  });

  it('④ 未知用户名 ⇒ 401 + 10002「用户名或口令错误」；事件落行（account_id NULL、success=0、用户名小写归一）', async () => {
    const res = await login('Nobody', PASSWORD);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      code: ErrCode.UNAUTHENTICATED,
      message: '用户名或口令错误',
      data: null,
    });
    expect(db.events).toEqual([{ username: 'nobody', account_id: null, ip: null, success: 0 }]);
    expect(db.queries.some((q) => q.sql === ADMIN_FIND_ACCOUNT_SQL)).toBe(true); // 查行发生在第④步
  });

  it('⑤ 错口令 ⇒ 与未知用户名**逐字同款** 401（防枚举）；事件 account_id 回填、last_login_at 不动', async () => {
    const res = await login('admin', 'wrong-password');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      code: ErrCode.UNAUTHENTICATED,
      message: '用户名或口令错误',
      data: null,
    });
    expect(db.events).toEqual([{ username: 'admin', account_id: 1, ip: null, success: 0 }]);
    expect(db.queries.some((q) => q.sql === ADMIN_TOUCH_LOGIN_SQL)).toBe(false); // 失败不更新
  });

  it('⑤′ 停用账号 + 错口令 ⇒ 401（不是 403——处理序 ⑤ verify 先于 ⑥ disabled）', async () => {
    const res = await login('frozen', 'wrong-password');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('用户名或口令错误');
    expect(db.events).toEqual([{ username: 'frozen', account_id: 2, ip: null, success: 0 }]);
  });

  it('⑥ 停用账号 + 对口令 ⇒ 403 + 10003「账号已停用」；事件落行', async () => {
    const res = await login('frozen', FROZEN_PASSWORD);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: ErrCode.FORBIDDEN, message: '账号已停用', data: null });
    expect(JSON.stringify(res.body)).not.toContain('token'); // 停用绝不签发
    expect(db.events).toEqual([{ username: 'frozen', account_id: 2, ip: null, success: 0 }]);
  });

  it('⑦ 成功 ⇒ 200 `{token, expiresIn:7200, username, role}`；claims 四要素；UPDATE → 事件 → 签发（逐字序）', async () => {
    const res = await login('Admin', PASSWORD); // 输入带大写 ⇒ 归一后入响应/claims

    expect(res.status).toBe(200); // `@HttpCode(200)`（不是 POST 缺省 201）
    expect(res.body.code).toBe(ErrCode.OK);
    expect(res.body.data.expiresIn).toBe(7200);
    expect(res.body.data.username).toBe('admin');
    expect(res.body.data.role).toBe('super_admin');
    expect(typeof res.body.data.token).toBe('string');

    const claims = probe.auth.verifyToken(res.body.data.token);
    expect(claims.sub).toBe('1');
    expect(typeof claims.sub).toBe('string');
    expect(claims.username).toBe('admin');
    expect(claims.role).toBe('super_admin');
    expect(claims.aud).toBe('ftl-admin');
    expect(claims.exp! - claims.iat!).toBe(7200);

    // 逐字序：① 启用检查 → ④ 查行 → ⑦ UPDATE last_login_at → 事件
    expect(db.queries.map((q) => q.sql)).toEqual([
      ADMIN_ENABLED_SQL,
      ADMIN_FIND_ACCOUNT_SQL,
      ADMIN_TOUCH_LOGIN_SQL,
      LOGIN_EVENT_INSERT_SQL,
    ]);
    expect(db.accounts[0]!.last_login_at).not.toBeNull();
    expect(db.events).toEqual([{ username: 'admin', account_id: 1, ip: null, success: 1 }]);
  });

  it('事件 `ip` 列 = `x-client-ip` 头：有值 ⇒ 落值；缺失 ⇒ NULL；超 64 ⇒ NULL（不伪造）；恰 64 ⇒ 照落', async () => {
    await probe.postJson(
      '/api/admin/login',
      { username: 'ghost', password: 'x' },
      { 'x-client-ip': '203.0.113.7' },
    );
    expect(db.events.at(-1)).toEqual({
      username: 'ghost',
      account_id: null,
      ip: '203.0.113.7',
      success: 0,
    });

    await probe.postJson('/api/admin/login', { username: 'ghost', password: 'x' });
    expect(db.events.at(-1)!.ip).toBeNull(); // 缺失 ⇒ NULL

    const long = 'a'.repeat(65);
    await probe.postJson(
      '/api/admin/login',
      { username: 'ghost', password: 'x' },
      { 'x-client-ip': long },
    );
    expect(db.events.at(-1)!.ip).toBeNull(); // 超 64 ⇒ NULL，不截断伪造

    const max = 'b'.repeat(64);
    await probe.postJson(
      '/api/admin/login',
      { username: 'ghost', password: 'x' },
      { 'x-client-ip': max },
    );
    expect(db.events.at(-1)!.ip).toBe(max); // 边界：64 是上限内
  });

  it('⚙️16 钉子：env 不再是开关——`ADMIN_PASSWORD` 为空串，账号在库 ⇒ 登录 200', async () => {
    expect(process.env.ADMIN_PASSWORD).toBe('');
    const res = await login('admin', PASSWORD);
    expect(res.status).toBe(200);
  });

  it('登录不吃 X-Admin（guard 豁免恰为这一条）：无头也能登；**错口令响应的文案来自 handler 而非 guard**', async () => {
    expect((await login('admin', PASSWORD)).status).toBe(200); // 无 X-Admin

    const wrong = await login('admin', 'nope');
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toBe('用户名或口令错误'); // ← 不是 guard 的 'admin header required'（假绿判别）
  });

  it('登录不写配置（判别力：publish 未被触发）', async () => {
    publish.mockClear();
    await login('admin', PASSWORD);

    expect(publish).not.toHaveBeenCalled();
  });

  it('失败分支不签令牌：`signToken` 一次都没被调用（C6 的「401 且不签」）', async () => {
    const spy = vi.spyOn(probe.auth, 'signToken');
    try {
      await login('nobody-here', PASSWORD);
      await login('admin', 'wrong-password');
      await login('frozen', FROZEN_PASSWORD);

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
