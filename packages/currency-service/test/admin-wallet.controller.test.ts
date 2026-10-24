/**
 * T5 管理 REST（规格 §2.6 / §6.1 http.controller 行）：`POST /api/admin/wallet/adjust` +
 * `GET /api/admin/wallet/accounts/:userId`。
 *
 * 判据（全列）：
 *  - `XAdminGuard` fail-closed：缺/伪造 `X-Admin` ⇒ 401/10002、**碰不到 handler**（零库变化）；
 *  - **③ T6 C24**：写端点（adjust）缺/非法 `X-Admin-Actor` ⇒ 401/10002「管理身份缺失」（零库变化）；
 *    读端点（accounts）不强求该头；adjust 的 `ops.actor` = 头值（不再回退字面量 `'admin'`）；
 *  - adjust 成功 ⇒ 200 `{balanceBefore, balanceAfter, opId}`；`actionId` 缺省 ⇒ `admin:<uuid>`；
 *    ops 留痕 source/actor/reason；
 *  - 同 id 同载荷重放 ⇒ **200** + 原值重建（同 opId、同 balanceBefore/After；**历史值**，
 *    后续 op 之后重放仍报首笔快照；不重复入账）；
 *  - 14001 ⇒ **409**；14002 ⇒ **409**；校验失败（delta/reason/userId/actionId）⇒ **400** 且零库操作；
 *  - accounts/:userId：**MySQL 直读**（缓存里塞坏值也不睬——绕过 Redis）、recentFlows ≤20 条
 *    `id DESC`（新→旧）、JOIN ops 取 source/reason、createdAt = epoch ms；未开户 ⇒ 200
 *    `{balance:0, recentFlows:[]}`（⚙️7）。
 *
 * HTTP 侧走真 Nest 管线（真 guard；状态码/信封是真的）。存储 = `FakeCurrencyDb`（apply 内核
 * 真跑）+ 直读面补丁：accounts 的两条 SQL 按**精确文字**识别（照 fake 的既有纪律——
 * 实现侧 SQL 一漂移用例当场红）。
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import { ApplyService } from '../src/apply/apply.service';
import { AdminWalletController } from '../src/admin/admin-wallet.controller';
import { XAdminGuard } from '../src/http/x-admin.guard';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';
import { startAdminProbe, type HttpProbe } from './helpers/http-probe';

/** accounts 端点的两条直读 SQL（**逐字**钉死；实现侧漂移 ⇒ 本文件当场红）。 */
const BALANCE_SQL = 'SELECT `balance` FROM `currency_accounts` WHERE `owner_id` = ?';
const RECENT_FLOWS_SQL =
  'SELECT f.`delta`, f.`balance_after`, f.`created_at`, o.`source`, o.`reason` ' +
  'FROM `currency_flows` f JOIN `currency_ops` o ON o.`id` = f.`op_id` ' +
  'WHERE f.`owner_id` = ? ORDER BY f.`id` DESC LIMIT 20';

/** 假驱动给 `created_at` 的确定性取值（mysql2 的 datetime(3) ⇒ JS `Date` 形态）。 */
const CREATED_AT_BASE_MS = 1_700_000_000_000;
const createdAtOf = (flowId: number) => CREATED_AT_BASE_MS + flowId * 1000;

/**
 * 直读面补丁：`ApplyService` 继续用 `FakeCurrencyDb` 的真事务面（`...db.dataSource`），
 * 只有**非事务直读**（accounts 端点）在这里按精确 SQL 分派。
 */
function makeAdminDs(db: FakeCurrencyDb) {
  const directReads: Array<{ sql: string; params: unknown[] }> = [];
  const dataSource = {
    ...db.dataSource,
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      directReads.push({ sql, params: [...params] });
      if (sql === BALANCE_SQL) {
        const account = db.accounts.get(params[0] as string);
        return Promise.resolve(account === undefined ? [] : [{ balance: account.balance }]);
      }
      if (sql === RECENT_FLOWS_SQL) {
        const ownerId = params[0] as string;
        const rows = db.flows
          .filter((flow) => flow.ownerId === ownerId)
          .sort((a, b) => b.id - a.id) // ORDER BY id DESC
          .slice(0, 20) // LIMIT 20
          .map((flow) => {
            const op = db.ops.find((row) => row.id === flow.opId);
            if (op === undefined) throw new Error(`假库不变量破坏：flow#${flow.id} 无对应 op#${flow.opId}`);
            return {
              delta: flow.delta,
              balance_after: flow.balanceAfter,
              created_at: new Date(createdAtOf(flow.id)),
              source: op.source,
              reason: op.reason,
            };
          });
        return Promise.resolve(rows);
      }
      return Promise.reject(new Error(`本替身未识别的直读 SQL：${sql}`));
    },
  } as unknown as DataSource;
  return { dataSource, directReads };
}

describe('管理 REST（T5；§2.6）：guard / adjust / accounts', () => {
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let apply: ApplyService;
  let probe: HttpProbe;
  let directReads: Array<{ sql: string; params: unknown[] }>;

  // ③ T6：写端点（adjust）强制 X-Admin-Actor（guard 从该头取 actor；缺失/非法 ⇒ 401）——
  // 全部既有 adjust 调用随本常量带上合法 actor；读面（accounts）不带也可（下方 C24 用例钉区分）。
  const AUTH = { 'x-admin': '1', 'x-admin-actor': 'admin' };
  const opIdOf = (actionId: string) => db.ops.find((op) => op.actionId === actionId)!.id;

  beforeAll(async () => {
    db = new FakeCurrencyDb();
    redis = new FakeRedis();
    const wired = makeAdminDs(db);
    directReads = wired.directReads;
    apply = new ApplyService(wired.dataSource, redis as unknown as Redis);
    probe = await startAdminProbe(apply, wired.dataSource);
  });
  afterAll(async () => {
    await probe.close();
  });

  it('注册面（T6 教训）+ guard 挂载：AppModule 含 AdminWalletController、类上有 XAdminGuard', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(AdminWalletController);
    const guards = Reflect.getMetadata('__guards__', AdminWalletController) as unknown[];
    expect(guards).toContain(XAdminGuard);
  });

  it('guard fail-closed：缺 / 伪造 X-Admin ⇒ 401/10002，且 handler 未被触到（零库变化）', async () => {
    db.seedAccount('user-g', 'user', 50);
    const accountBefore = { ...db.accounts.get('user-g')! };
    const opsBefore = db.ops.length;
    const forged: Array<Record<string, string>> = [
      {},
      { 'x-admin': '0' },
      { 'x-admin': 'true' },
      { 'x-admin': '' },
      { 'x-admin': '01' },
    ];

    for (const headers of forged) {
      const post = await probe.postJson(
        '/api/admin/wallet/adjust',
        { userId: 'user-g', delta: 10, reason: '偷发' },
        headers,
      );
      expect(post.status, JSON.stringify(headers)).toBe(401);
      expect(post.body).toEqual({
        code: ErrCode.UNAUTHENTICATED,
        message: 'admin header required',
        data: null,
      });

      const get = await probe.get('/api/admin/wallet/accounts/user-g', headers);
      expect(get.status, JSON.stringify(headers)).toBe(401);
    }

    expect(db.accounts.get('user-g')).toEqual(accountBefore); // 零变化
    expect(db.ops.length).toBe(opsBefore);
  });

  // ─── ③ T6 C24：写端点 actor fail-closed（X-Admin-Actor）────────────────────────

  it('C24 写端点 actor fail-closed：缺/非法 X-Admin-Actor ⇒ 401/10002「管理身份缺失」且零库变化', async () => {
    db.seedAccount('user-act', 'user', 50);
    const accountBefore = { ...db.accounts.get('user-act')! };
    const opsBefore = db.ops.length;
    const forged: Array<Record<string, string>> = [
      { 'x-admin': '1' }, // 缺失
      { 'x-admin': '1', 'x-admin-actor': '' },
      { 'x-admin': '1', 'x-admin-actor': 'ab' }, // 2 字 < 3
      { 'x-admin': '1', 'x-admin-actor': 'Admin' }, // 大写（正则拒）
      { 'x-admin': '1', 'x-admin-actor': 'admin!' }, // 字符集外
      { 'x-admin': '1', 'x-admin-actor': '.admin' }, // 首字符非法
      { 'x-admin': '1', 'x-admin-actor': 'a'.repeat(33) }, // 超 32
    ];

    for (const headers of forged) {
      const post = await probe.postJson(
        '/api/admin/wallet/adjust',
        { userId: 'user-act', delta: 10, reason: '偷发' },
        headers,
      );
      expect(post.status, JSON.stringify(headers)).toBe(401);
      expect(post.body, JSON.stringify(headers)).toEqual({
        code: ErrCode.UNAUTHENTICATED,
        message: '管理身份缺失',
        data: null,
      });
    }

    expect(db.accounts.get('user-act')).toEqual(accountBefore); // 零变化
    expect(db.ops.length).toBe(opsBefore);

    // 读端点**不强求**该头：只带 x-admin（无 actor / actor 非法）⇒ 200（§2.7「读端点不强求」）
    const readHeaders: Array<Record<string, string>> = [
      { 'x-admin': '1' },
      { 'x-admin': '1', 'x-admin-actor': 'BAD' },
    ];
    for (const headers of readHeaders) {
      const get = await probe.get('/api/admin/wallet/accounts/user-act', headers);
      expect(get.status, JSON.stringify(headers)).toBe(200);
    }
  });

  it('C24 actor 接线：adjust 以头值入账 ops.actor（不再回退字面量 \'admin\'）', async () => {
    const res = await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-actor2', delta: 7, reason: '第二账号', actionId: 'admin:t6-actor' },
      { 'x-admin': '1', 'x-admin-actor': 'finance.one' },
    );

    expect(res.status).toBe(200);
    expect(db.ops.find((op) => op.actionId === 'admin:t6-actor')).toMatchObject({
      actor: 'finance.one',
      source: 'admin_adjust',
      reason: '第二账号',
    });
  });

  it('adjust 成功 ⇒ 200 `{balanceBefore, balanceAfter, opId}`；ops 留痕 source/actor/reason 逐字', async () => {
    const res = await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-a1', delta: 100, reason: '活动补偿', actionId: 'admin:t5-a1' },
      AUTH,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { balanceBefore: 0, balanceAfter: 100, opId: opIdOf('admin:t5-a1') },
    });
    expect(db.accounts.get('user-a1')).toEqual({ ownerType: 'user', balance: 100 });
    expect(db.ops.find((op) => op.actionId === 'admin:t5-a1')).toMatchObject({
      source: 'admin_adjust',
      actor: 'admin',
      reason: '活动补偿',
      refId: null,
    });
    expect(
      db.flows
        .filter((flow) => flow.ownerId === 'user-a1')
        .map(({ delta, balanceAfter, ownerType }) => ({ delta, balanceAfter, ownerType })),
    ).toEqual([{ delta: 100, balanceAfter: 100, ownerType: 'user' }]);
  });

  it('adjust：`actionId` 缺省 ⇒ 生成 `admin:<uuid>`（形状逐字落到 ops）', async () => {
    const opsBefore = db.ops.length;

    const res = await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-a2', delta: 5, reason: '缺省 id' },
      AUTH,
    );

    expect(res.status).toBe(200);
    expect(db.ops.length).toBe(opsBefore + 1);
    const actionId = db.ops[db.ops.length - 1]!.actionId;
    expect(actionId).toMatch(
      /^admin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('边界：delta=1,000,000（上限内）与 reason=200 字（上限内）⇒ 200', async () => {
    const res = await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-max', delta: 1_000_000, reason: 'a'.repeat(200), actionId: 'admin:t5-max' },
      AUTH,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ balanceBefore: 0, balanceAfter: 1_000_000 });
  });

  it('同 id 同载荷重放 ⇒ **200** 原值重建（字节级同响应；不重复入账）', async () => {
    const body = { userId: 'user-r', delta: 200, reason: '重放用例', actionId: 'admin:t5-replay' };

    const first = await probe.postJson('/api/admin/wallet/adjust', body, AUTH);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({
      balanceBefore: 0,
      balanceAfter: 200,
      opId: opIdOf('admin:t5-replay'),
    });

    const opsAfterFirst = db.ops.length;
    const second = await probe.postJson('/api/admin/wallet/adjust', body, AUTH);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body); // 原值重建（opId 自 ops / balanceBefore 自 flows）
    expect(db.ops.length).toBe(opsAfterFirst); // 不新增 op
    expect(db.accounts.get('user-r')).toEqual({ ownerType: 'user', balance: 200 }); // 只入账一次
    expect(db.flows.filter((flow) => flow.ownerId === 'user-r')).toHaveLength(1);
  });

  it('重放报的是**历史快照**而非当前余额：后续 op 之后再重放首笔 ⇒ 仍报首笔的 After/Before', async () => {
    const body = { userId: 'user-r2', delta: 100, reason: '历史重放', actionId: 'admin:t5-hist' };

    const first = await probe.postJson('/api/admin/wallet/adjust', body, AUTH);
    expect(first.status).toBe(200);

    // 再打一笔（100 → 30）：重放若「按当前余额重建」会报 30/70 —— 那是错的实现
    const after = await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-r2', delta: -70, reason: '后续扣减', actionId: 'admin:t5-after' },
      AUTH,
    );
    expect(after.status).toBe(200);
    expect(after.body.data).toMatchObject({ balanceBefore: 100, balanceAfter: 30 });

    const replay = await probe.postJson('/api/admin/wallet/adjust', body, AUTH);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body); // 历史值（100/0），不是当前值（30/70）
    expect(db.accounts.get('user-r2')!.balance).toBe(30); // 事实余额未被重放改动
    expect(db.flows.filter((flow) => flow.ownerId === 'user-r2')).toHaveLength(2);
  });

  it('余额不足 ⇒ **409** + 14001（整批回滚：余额 / ops / flows 三面零变化）', async () => {
    db.seedAccount('user-low', 'user', 50);
    const opsBefore = db.ops.length;
    const flowsBefore = db.flows.length;

    const res = await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-low', delta: -100, reason: '扣不动', actionId: 'admin:t5-low' },
      AUTH,
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrCode.E_INSUFFICIENT_FUNDS);
    expect(res.body.message).toContain('余额不足');
    expect(db.accounts.get('user-low')!.balance).toBe(50);
    expect(db.ops.length).toBe(opsBefore); // 失败不落 op（事务整体回滚）
    expect(db.flows.length).toBe(flowsBefore);
  });

  it('同 id 异载荷 ⇒ **409** + 14002（「同 id 不同内容」不静默），余额不变', async () => {
    await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-c', delta: 10, reason: '冲突锚', actionId: 'admin:t5-conflict' },
      AUTH,
    );

    const res = await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-c', delta: 11, reason: '冲突锚', actionId: 'admin:t5-conflict' },
      AUTH,
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrCode.E_ACTION_CONFLICT);
    expect(db.accounts.get('user-c')!.balance).toBe(10);
  });

  it('校验失败 ⇒ **400**/10001 矩阵（delta / reason / userId / actionId）且**零库操作**', async () => {
    const cases: Array<{ name: string; body: Record<string, unknown> }> = [
      { name: 'delta=0', body: { userId: 'user-v', delta: 0, reason: 'x' } },
      { name: 'delta 超上限（1,000,001）', body: { userId: 'user-v', delta: 1_000_001, reason: 'x' } },
      { name: 'delta 非整数（2.5）', body: { userId: 'user-v', delta: 2.5, reason: 'x' } },
      { name: 'delta 缺失', body: { userId: 'user-v', reason: 'x' } },
      { name: 'reason 缺失', body: { userId: 'user-v', delta: 1 } },
      { name: 'reason 空串', body: { userId: 'user-v', delta: 1, reason: '' } },
      { name: 'reason 201 字（>200）', body: { userId: 'user-v', delta: 1, reason: 'a'.repeat(201) } },
      { name: 'userId 字符集外', body: { userId: 'bad id!', delta: 1, reason: 'x' } },
      { name: 'userId 缺失', body: { delta: 1, reason: 'x' } },
      { name: 'actionId 空串', body: { userId: 'user-v', delta: 1, reason: 'x', actionId: '' } },
    ];
    const opsBefore = db.ops.length;

    for (const c of cases) {
      const res = await probe.postJson('/api/admin/wallet/adjust', c.body, AUTH);
      expect(res.status, c.name).toBe(400);
      expect(res.body.code, c.name).toBe(ErrCode.BAD_PARAM);
      expect(typeof res.body.message, c.name).toBe('string');
      expect((res.body.message as string).length, c.name).toBeGreaterThan(0);
    }

    expect(db.ops.length).toBe(opsBefore); // 校验在**任何**库操作之前
    expect(db.accounts.has('user-v')).toBe(false); // 更没建行
  });

  it('accounts：未开户 ⇒ 200 `{balance:0, recentFlows:[]}`（⚙️7；只打余额一条直读）', async () => {
    const readsBefore = directReads.length;

    const res = await probe.get('/api/admin/wallet/accounts/user-none', AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: ErrCode.OK, data: { balance: 0, recentFlows: [] } });
    expect(directReads.slice(readsBefore)).toEqual([{ sql: BALANCE_SQL, params: ['user-none'] }]);
  });

  it('accounts：MySQL 直读余额 + recentFlows 新→旧、JOIN ops 取 source/reason、createdAt=epoch ms', async () => {
    // 三笔真 apply（两笔经 HTTP admin、一笔注册赠送直调同一内核）—— 三种留痕互异，JOIN 错则红
    await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-h', delta: 100, reason: '首充', actionId: 'admin:t5-h1' },
      AUTH,
    );
    await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-h', delta: -30, reason: '回扣', actionId: 'admin:t5-h2' },
      AUTH,
    );
    const signup = await apply.apply({
      actionId: 'signup:user-h',
      source: 'signup_grant',
      entries: [{ ownerId: 'user-h', delta: 7 }],
      refId: 'user-h',
    });
    expect(signup.ok).toBe(true);

    // 读源纪律：缓存里塞一个坏值（写穿窗口旧值的极端形态）⇒ 端点必须不睬它
    redis.store.set('currency:balance:user-h', '9999');

    const res = await probe.get('/api/admin/wallet/accounts/user-h', AUTH);

    expect(res.status).toBe(200);
    const data = res.body.data as {
      balance: number;
      recentFlows: Array<Record<string, unknown>>;
    };
    expect(data.balance).toBe(77); // 100 − 30 + 7；= MySQL 直读（不睬缓存里的 9999）
    expect(data.recentFlows.map((flow) => flow.delta)).toEqual([7, -30, 100]); // id DESC 新→旧
    expect(data.recentFlows.map((flow) => flow.source)).toEqual([
      'signup_grant',
      'admin_adjust',
      'admin_adjust',
    ]);
    expect(data.recentFlows.map((flow) => flow.reason)).toEqual([null, '回扣', '首充']); // reason 可 null
    expect(data.recentFlows.map((flow) => flow.balanceAfter)).toEqual([77, 70, 100]);

    const flowIds = db.flows
      .filter((flow) => flow.ownerId === 'user-h')
      .sort((a, b) => b.id - a.id)
      .map((flow) => flow.id);
    expect(data.recentFlows.map((flow) => flow.createdAt)).toEqual(flowIds.map(createdAtOf));
  });

  it('accounts：recentFlows 恰 ≤20 条（第 21+ 条被截掉；留下的是**最新**的 20）', async () => {
    db.seedAccount('user-many', 'user', 325);
    db.seedCommittedOp(
      { actionId: 'admin:t5-many', requestHash: 'h'.repeat(64) },
      Array.from({ length: 25 }, (_, i) => ({
        ownerId: 'user-many',
        delta: i + 1,
        balanceAfter: (i + 1) * 10,
      })),
    );

    const res = await probe.get('/api/admin/wallet/accounts/user-many', AUTH);

    expect(res.status).toBe(200);
    const recentFlows = (res.body.data as { recentFlows: Array<{ delta: number }> }).recentFlows;
    expect(recentFlows).toHaveLength(20);
    // 25 条里留下 id 最大（最新）的 20 条：delta 25..6（新→旧）
    expect(recentFlows.map((flow) => flow.delta)).toEqual(
      Array.from({ length: 20 }, (_, i) => 25 - i),
    );
  });

  // ─── ② 金币场 C26：ownerType 透传（规格 §7 / §9「种子通道」）─────────────────
  // 现端点的 entry 组装只透传 ownerId/delta；不透传 ownerType 会以 user 建池户，
  // 与 refill 载荷的 ownerType:'robot' 相撞（10001 类型闸）—— 下面三例把这个相撞面钉死。

  it('C26 缺省：body 不带 ownerType ⇒ 建 user 户（向后兼容；指纹与显式 \'user\' 逐字相同）', async () => {
    // 同一 userId、两个 actionId（不同 op）—— 载荷只差 ownerType 的书写形态：
    // 缺省 与 显式 'user' 的 request_hash 必须一致（不一致 ⇒ 同载荷不同形态会互相撞 14002）。
    const noType = await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-def', delta: 10, reason: '缺省类型', actionId: 'admin:t8-def' },
      AUTH,
    );
    const explicit = await probe.postJson(
      '/api/admin/wallet/adjust',
      { userId: 'user-def', ownerType: 'user', delta: 10, reason: '缺省类型', actionId: 'admin:t8-def2' },
      AUTH,
    );

    expect(noType.status).toBe(200);
    expect(explicit.status).toBe(200);
    expect(db.accounts.get('user-def')).toEqual({ ownerType: 'user', balance: 20 }); // 两笔都入账
    expect(db.flows.filter((flow) => flow.ownerId === 'user-def').map((flow) => flow.ownerType)).toEqual([
      'user',
      'user',
    ]);
    // 归一化值参与 request_hash（§2.3）：缺省 与 显式 'user' 的指纹必须一致。
    const hashOf = (actionId: string) => db.ops.find((op) => op.actionId === actionId)!.requestHash;
    expect(hashOf('admin:t8-def')).toBe(hashOf('admin:t8-def2'));
  });

  it('C26 robot 路径：ownerType=\'robot\' ⇒ robot 户（池种子 = 5 笔 × 1,000,000）；refill 载荷不撞类型闸', async () => {
    // 种子 runbook 形态：5 笔 × 1,000,000（单笔上限 1e6 —— 现档位下唯一可行的拆笔）
    for (let i = 0; i < 5; i += 1) {
      const res = await probe.postJson(
        '/api/admin/wallet/adjust',
        { userId: 'robot-pool', ownerType: 'robot', delta: 1_000_000, reason: `池种子 ${i + 1}/5`, actionId: `admin:t8-pool-${i}` },
        AUTH,
      );
      expect(res.status, `第 ${i + 1} 笔`).toBe(200);
    }

    expect(db.accounts.get('robot-pool')).toEqual({ ownerType: 'robot', balance: 5_000_000 });
    expect(
      new Set(db.flows.filter((flow) => flow.ownerId === 'robot-pool').map((flow) => flow.ownerType)),
      '池的流水类型面同为 robot（首写固化）',
    ).toEqual(new Set(['robot']));

    // 规格 §7 点名的相撞形态：不透传的实现以 user 建池户 ⇒ 这笔 refill 会 10001。
    const refill = await apply.apply({
      actionId: 'rr:bot-t8:12000:0',
      source: 'robot_pool',
      refId: 'bot-t8',
      entries: [
        { ownerId: 'robot-pool', ownerType: 'robot', delta: -12_000 },
        { ownerId: 'bot-t8', ownerType: 'robot', delta: 12_000 },
      ],
    });
    expect(refill.ok, JSON.stringify(refill)).toBe(true);
    expect(db.accounts.get('robot-pool')!.balance).toBe(5_000_000 - 12_000);
    expect(db.accounts.get('bot-t8')).toEqual({ ownerType: 'robot', balance: 12_000 });
  });

  it('ownerType 非法值（陌生串/空串/null/数字/大小写变体）⇒ 400/10001 且零库操作', async () => {
    const opsBefore = db.ops.length;

    for (const ownerType of ['admin', '', null, 123, 'ROBOT']) {
      const res = await probe.postJson(
        '/api/admin/wallet/adjust',
        { userId: 'user-t8-bad', ownerType, delta: 10, reason: 'x', actionId: `admin:t8-bad-${String(ownerType)}` },
        AUTH,
      );
      expect(res.status, `ownerType=${JSON.stringify(ownerType)}`).toBe(400);
      expect(res.body.code, `ownerType=${JSON.stringify(ownerType)}`).toBe(ErrCode.BAD_PARAM);
      expect(typeof res.body.message, `ownerType=${JSON.stringify(ownerType)}`).toBe('string');
    }

    expect(db.ops.length).toBe(opsBefore);
    expect(db.accounts.has('user-t8-bad')).toBe(false);
  });
});
