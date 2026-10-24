/**
 * 冲正（③ T7；规格 §2.8 + ⚙️6 + §2.14）——`POST /api/admin/wallet/reverse` 全链。
 *
 * 判据（全列；C20 的 currency-service 半边）：
 *  - 正例：多账户**一次 apply**（单事务、恰一行 ops、两条 flow 插入——不是逐户循环 apply）；
 *    `actor` = 网关注入头、`refId` = 原 `action_id`、`entries` = 原 op 全部 flows 取负
 *    （ownerId/ownerType 从 flow 取）；ops 留痕 source=`admin_reverse`、reason=body；
 *  - 14001 原子拒：任一账户余额不足 ⇒ 409 精确文案 + **整批回滚**（含批内已成功的账户）；
 *  - ⚙️6 重复语义：同操作者**且**同原因 ⇒ 载荷指纹相同 ⇒ 重放 200 + `replayed:true`
 *    （同 opId、不新增 op、不二次冲正）；**异原因 / 异操作者同原因**（指纹含 actor 维）⇒
 *    同 actionId 异指纹 ⇒ 409/14002「该操作已冲正」；
 *  - 非 `admin_adjust` ⇒ 409 借 10001「该操作不可冲正」（signup 等来源；冲正 op 自身亦不可再冲）；
 *  - 不存在 ⇒ 404 借 10001「操作不存在」（且**读完 op 即短路**——flows 不读）；
 *  - body 预闸：`opId` 正整数 / `reason` 1..200 ⇒ 400 借 10001 且**未碰库**；200 字上界内含；
 *  - 写端点 guard：缺 `X-Admin` ⇒ 401；缺/非法 `X-Admin-Actor` ⇒ 401「管理身份缺失」（零查询）；
 *  - reversed 旗翻转：冲正落 `admin:reverse:<opId>` op 行 ⇒ 经 T6 详情路由的 EXISTS 实测翻 true。
 *
 * 形态：**真 Nest 管线**（真 `AdminFinanceController` + 真 `XAdminGuard` + 真 `ReverseService`/
 * `ApplyService`/`FinanceQueryService` + globalPrefix `api`）+ `FakeCurrencyDb`（apply 内核真跑）
 * + 直读面补丁：两条 reverse SQL 按**精确文字**识别（独立副本——实现侧漂移一个字符就红）；
 * T6 详情 SQL 的独立副本供 reversed 旗用例（走真详情路由）。
 */
import 'reflect-metadata';
import { Module, ValidationPipe, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import { AdminFinanceController } from '../src/admin/admin-finance.controller';
import { FinanceQueryService } from '../src/admin/finance-query.service';
import { ReverseService } from '../src/admin/reverse.service';
import { ApplyService } from '../src/apply/apply.service';
import { ReconcileService } from '../src/reconcile/reconcile.service';
import { XAdminGuard } from '../src/http/x-admin.guard';
import { FakeCurrencyDb, FakeRedis, type FakeOpRow } from './helpers/fake-currency-db';

const AUTH = { 'x-admin': '1', 'x-admin-actor': 'finance.one' };

/* ------------------------------------------------------------------ *
 * SQL 独立副本（实现侧漂移一个字符 ⇒ 本文件当场红）
 * ------------------------------------------------------------------ */

/** §2.8 步骤 1：查 op（findOp 的全文）。 */
const REVERSE_OP_SQL = 'SELECT `action_id`, `source` FROM `currency_ops` WHERE `id` = ?';
/** §2.8 步骤 2：原 op 全部 flows（取负入 entries 的读面）。 */
const REVERSE_FLOWS_SQL = 'SELECT `owner_id`, `owner_type`, `delta` FROM `currency_flows` WHERE `op_id` = ?';
/** T6 详情 SQL（`admin-finance.test.ts` 同文的独立副本；reversed 旗用例走真详情路由）。 */
const T6_DETAIL_SQL =
  'SELECT f.id AS flowId, f.op_id AS opId, o.action_id AS actionId, o.source, o.actor, o.reason, ' +
  'o.ref_id AS refId, o.trace_id AS traceId, o.burned_residue AS burnedResidue, o.burned_rake AS burnedRake, f.owner_id AS ownerId, f.owner_type AS ownerType, ' +
  'f.delta, f.balance_after AS balanceAfter, f.created_at AS createdAt, ' +
  'u.phone, u.nickname, ' +
  "EXISTS(SELECT 1 FROM currency_ops r WHERE r.action_id = CONCAT('admin:reverse:', o.id)) AS reversed " +
  'FROM currency_flows f ' +
  'JOIN currency_ops o ON o.id = f.op_id ' +
  'LEFT JOIN users u ON u.id = f.owner_id' +
  ' WHERE f.op_id = ? ORDER BY f.id';

/** 假驱动给 `created_at` 的确定性取值（mysql2 的 datetime(3) ⇒ JS Date 形态）。 */
const FLOW_CREATED_AT_MS = 1_700_000_000_000;

/* ------------------------------------------------------------------ *
 * 直读面补丁（照 `admin-wallet.controller.test.ts` 的 makeAdminDs 先例）：
 * ApplyService 用 FakeCurrencyDb 的真事务面（**动态**委托到当前 ctx.db——beforeEach
 * 每用例换库）；非事务直读（reverse 两读 + T6 详情读）在此按精确 SQL 分派。
 * ------------------------------------------------------------------ */

function makeReverseDs(
  ctx: { db: FakeCurrencyDb },
  directReads: Array<{ sql: string; params: unknown[] }>,
): DataSource {
  return {
    // transaction 每次调用**动态**取当前 ctx.db（beforeEach 换库也生效——不能 spread 快照）。
    transaction: ((cb: (manager: unknown) => Promise<unknown>) =>
      ctx.db.dataSource.transaction(cb)) as unknown,
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      const db = ctx.db;
      directReads.push({ sql, params: [...params] });
      if (sql === REVERSE_OP_SQL) {
        const op = db.ops.find((o) => o.id === Number(params[0]));
        return Promise.resolve(
          op === undefined ? [] : [{ action_id: op.actionId, source: op.source }],
        );
      }
      if (sql === REVERSE_FLOWS_SQL) {
        const opId = Number(params[0]);
        return Promise.resolve(
          db.flows
            .filter((f) => f.opId === opId)
            .map((f) => ({ owner_id: f.ownerId, owner_type: f.ownerType, delta: f.delta })),
        );
      }
      if (sql === T6_DETAIL_SQL) {
        const opId = Number(params[0]);
        return Promise.resolve(
          db.flows
            .filter((f) => f.opId === opId)
            .sort((a, b) => a.id - b.id) // ORDER BY f.id（升序）
            .map((f) => {
              const op = db.ops.find((o) => o.id === f.opId);
              if (op === undefined) {
                throw new Error(`假库不变量破坏：flow#${f.id} 无对应 op#${f.opId}`);
              }
              return {
                flowId: f.id,
                opId: f.opId,
                actionId: op.actionId,
                source: op.source,
                actor: op.actor,
                reason: op.reason,
                refId: op.refId,
                traceId: op.traceId,
                burnedResidue: op.burnedResidue,
                burnedRake: op.burnedRake,
                ownerId: f.ownerId,
                ownerType: f.ownerType,
                delta: f.delta,
                balanceAfter: f.balanceAfter,
                createdAt: new Date(FLOW_CREATED_AT_MS),
                phone: null,
                nickname: null,
                // T6 的 EXISTS 旗（MySQL TINYINT ⇒ 0/1）
                reversed: db.ops.some((r) => r.actionId === `admin:reverse:${op.id}`) ? 1 : 0,
              };
            }),
        );
      }
      return Promise.reject(new Error(`本文件替身未识别的直读 SQL：${sql}`));
    },
  } as unknown as DataSource;
}

/* ------------------------------------------------------------------ *
 * 真 Nest 管线的 HTTP 探针（挂 AdminFinanceController 三依赖）
 * ------------------------------------------------------------------ */

@Module({})
class ReverseProbeModule {}

interface HttpResult {
  status: number;
  body: any;
}

interface ReverseProbe {
  get: (path: string, headers?: Record<string, string>) => Promise<HttpResult>;
  postJson: (path: string, body: unknown, headers?: Record<string, string>) => Promise<HttpResult>;
  close: () => Promise<void>;
}

async function startProbe(ds: DataSource, apply: ApplyService): Promise<ReverseProbe> {
  const module: DynamicModule = {
    module: ReverseProbeModule,
    controllers: [AdminFinanceController],
    providers: [
      { provide: ApplyService, useValue: apply },
      { provide: ReverseService, useValue: new ReverseService(ds) },
      { provide: FinanceQueryService, useValue: new FinanceQueryService(ds) },
      // ③ T8：控制器构造再增 reconcile 两路由依赖（本文件不触对账面）——占位空对象仅供容器解析。
      { provide: ReconcileService, useValue: {} as ReconcileService },
    ],
  };
  const app: INestApplication = await NestFactory.create(module, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const request = async (
    method: 'GET' | 'POST',
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
    close: async () => {
      await app.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 每用例换一份假库（FakeCurrencyDb 无 reset）；ds 经 ctx 读**当前** db。 */
const ctx: { db: FakeCurrencyDb } = { db: new FakeCurrencyDb() };
const directReads: Array<{ sql: string; params: unknown[] }> = [];
let apply: ApplyService;
let probe: ReverseProbe;

const SEED_ACTOR = 'seed.admin';

/** 经**真** apply 内核种一笔 admin_adjust（返回原 opId）。 */
async function seedAdjust(
  actionId: string,
  entries: Array<{ ownerId: string; delta: number }>,
): Promise<number> {
  const res = await apply.apply({
    actionId,
    source: 'admin_adjust',
    actor: SEED_ACTOR,
    reason: '种子调账',
    entries,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  const op: FakeOpRow | undefined = ctx.db.ops.find((o) => o.actionId === actionId);
  expect(op, `种子 op ${actionId} 未落库`).toBeDefined();
  return op!.id;
}

beforeAll(async () => {
  const ds = makeReverseDs(ctx, directReads);
  apply = new ApplyService(ds, new FakeRedis() as unknown as Redis);
  probe = await startProbe(ds, apply);
});
afterAll(async () => {
  await probe.close();
});
beforeEach(() => {
  ctx.db = new FakeCurrencyDb();
  directReads.length = 0;
});

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('POST /api/admin/wallet/reverse（§2.8 正例）', () => {
  it('多账户一次 apply：actor=头 / refId=原 action_id / entries=原 flows 取负；留痕与单事务逐字', async () => {
    const origOpId = await seedAdjust('admin:t7-seed', [
      { ownerId: 'rev-a', delta: 100 },
      { ownerId: 'rev-b', delta: 250 },
    ]);
    const txBefore = ctx.db.txLog.length;

    const res = await probe.postJson(
      '/api/admin/wallet/reverse',
      { opId: origOpId, reason: '误发，冲回' },
      AUTH,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const revOp = ctx.db.ops.find((o) => o.actionId === `admin:reverse:${origOpId}`);
    expect(revOp).toBeDefined();
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: {
        opId: revOp!.id,
        actionId: `admin:reverse:${origOpId}`,
        replayed: false,
        entries: [
          { ownerId: 'rev-a', balanceAfter: 0 },
          { ownerId: 'rev-b', balanceAfter: 0 },
        ],
      },
    });
    // ops 留痕（§2.8 步骤 3：source/actor/reason/refId）
    expect(revOp).toMatchObject({
      source: 'admin_reverse',
      actor: 'finance.one',
      reason: '误发，冲回',
      refId: 'admin:t7-seed',
      traceId: null,
    });
    // 余额回零 + 反向流水（ownerType 从原 flow 带回）
    expect(ctx.db.accounts.get('rev-a')).toEqual({ ownerType: 'user', balance: 0 });
    expect(ctx.db.accounts.get('rev-b')).toEqual({ ownerType: 'user', balance: 0 });
    expect(
      ctx.db.flows.filter((f) => f.ownerId === 'rev-a').map((f) => ({ delta: f.delta, ownerType: f.ownerType })),
    ).toEqual([
      { delta: 100, ownerType: 'user' },
      { delta: -100, ownerType: 'user' },
    ]);
    // 两账户**一次 apply**（单事务 = txLog 恰 +1；恰一行 ops；两条 flow —— 非逐户循环 apply）
    expect(ctx.db.txLog.length).toBe(txBefore + 1);
    const tx = ctx.db.txLog[txBefore]!;
    expect(tx.committed).toBe(true);
    expect(tx.statements.filter((s) => s.sql.startsWith('INSERT INTO `currency_ops`'))).toHaveLength(1);
    expect(tx.statements.filter((s) => s.sql.startsWith('INSERT INTO `currency_flows`'))).toHaveLength(2);
  });

  it('14001 原子拒：任一账户不足 ⇒ 409 精确文案 + 整批回滚（含批内已「成功」的账户）', async () => {
    const origOpId = await seedAdjust('admin:t7-low', [
      { ownerId: 'rev-e', delta: 100 },
      { ownerId: 'rev-f', delta: 100 },
    ]);
    // 花掉 rev-f 一部分（60）：余额 40 < 100 ⇒ 冲正必 14001
    const drain = await apply.apply({
      actionId: 'spend:t7',
      source: 'game_settle',
      entries: [{ ownerId: 'rev-f', delta: -60 }],
      refId: 'room-t7',
    });
    expect(drain.ok).toBe(true);
    const opsBefore = ctx.db.ops.length;
    const flowsBefore = ctx.db.flows.length;

    const res = await probe.postJson(
      '/api/admin/wallet/reverse',
      { opId: origOpId, reason: '整笔回冲' },
      AUTH,
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: ErrCode.E_INSUFFICIENT_FUNDS,
      message: '余额不足，无法整笔冲正（可能已部分花费）——可改用手工扣减',
      data: null,
    });
    // 整批回滚：rev-e 那笔「本可成功」的扣减也被丢弃（执行序 rev-e 在前）
    expect(ctx.db.accounts.get('rev-e')!.balance).toBe(100);
    expect(ctx.db.accounts.get('rev-f')!.balance).toBe(40);
    expect(ctx.db.ops.length).toBe(opsBefore);
    expect(ctx.db.flows.length).toBe(flowsBefore);
    expect(ctx.db.ops.some((o) => o.actionId === `admin:reverse:${origOpId}`)).toBe(false);
    expect(ctx.db.txLog.at(-1)!.committed).toBe(false); // 事务整体回滚
  });
});

describe('POST /api/admin/wallet/reverse（⚙️6 重复语义）', () => {
  it('同操作者同原因 ⇒ 重放 200 replayed:true（同 opId、不新增 op、不二次冲正）', async () => {
    const origOpId = await seedAdjust('admin:t7-replay', [{ ownerId: 'rev-g', delta: 50 }]);
    const body = { opId: origOpId, reason: '重复点击' };

    const first = await probe.postJson('/api/admin/wallet/reverse', body, AUTH);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      actionId: `admin:reverse:${origOpId}`,
      replayed: false,
      entries: [{ ownerId: 'rev-g', balanceAfter: 0 }],
    });
    const opsAfterFirst = ctx.db.ops.length;

    const second = await probe.postJson('/api/admin/wallet/reverse', body, AUTH);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      code: ErrCode.OK,
      data: { ...first.body.data, replayed: true },
    });
    expect(ctx.db.ops.length).toBe(opsAfterFirst); // 不新增 op
    expect(ctx.db.accounts.get('rev-g')!.balance).toBe(0); // 不二次冲正
    expect(ctx.db.flows.filter((f) => f.ownerId === 'rev-g')).toHaveLength(2);
  });

  it('异原因（同操作者）与异操作者（同原因）⇒ 409/14002「该操作已冲正」（指纹含 actor 维）', async () => {
    const origOpId = await seedAdjust('admin:t7-conflict', [{ ownerId: 'rev-h', delta: 30 }]);
    const first = await probe.postJson(
      '/api/admin/wallet/reverse',
      { opId: origOpId, reason: '首冲原因' },
      AUTH,
    );
    expect(first.status).toBe(200);
    const opsAfterFirst = ctx.db.ops.length;

    const diffReason = await probe.postJson(
      '/api/admin/wallet/reverse',
      { opId: origOpId, reason: '换了理由' },
      AUTH,
    );
    expect(diffReason.status).toBe(409);
    expect(diffReason.body).toEqual({
      code: ErrCode.E_ACTION_CONFLICT,
      message: '该操作已冲正',
      data: null,
    });

    const diffActor = await probe.postJson(
      '/api/admin/wallet/reverse',
      { opId: origOpId, reason: '首冲原因' },
      { 'x-admin': '1', 'x-admin-actor': 'finance.two' },
    );
    expect(diffActor.status).toBe(409);
    expect(diffActor.body).toEqual({
      code: ErrCode.E_ACTION_CONFLICT,
      message: '该操作已冲正',
      data: null,
    });

    expect(ctx.db.ops.length).toBe(opsAfterFirst);
    expect(ctx.db.accounts.get('rev-h')!.balance).toBe(0);
  });
});

describe('POST /api/admin/wallet/reverse（404 / 409 不可冲正 / 400 预闸）', () => {
  it('非 admin_adjust ⇒ 409 借 10001「该操作不可冲正」（signup 来源；冲正 op 自身也不可再冲）', async () => {
    const signup = await apply.apply({
      actionId: 'signup:t7',
      source: 'signup_grant',
      entries: [{ ownerId: 'rev-i', delta: 9 }],
      refId: 'rev-i',
    });
    expect(signup.ok).toBe(true);
    const signupOpId = ctx.db.ops.find((o) => o.actionId === 'signup:t7')!.id;
    const opsBefore = ctx.db.ops.length;

    const res = await probe.postJson('/api/admin/wallet/reverse', { opId: signupOpId, reason: '尝试' }, AUTH);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: ErrCode.BAD_PARAM, message: '该操作不可冲正', data: null });
    expect(ctx.db.ops.length).toBe(opsBefore);
    expect(ctx.db.ops.some((o) => o.actionId === `admin:reverse:${signupOpId}`)).toBe(false);

    // 冲正 op 自身（source=admin_reverse）⇒ 同样 409「该操作不可冲正」（该 op 的冲正锚不存在，
    // 走到的是**来源闸**而非 14002——语义与「已冲正」不同，逐字钉住）
    const origOpId = await seedAdjust('admin:t7-noadj', [{ ownerId: 'rev-j', delta: 20 }]);
    const ok = await probe.postJson('/api/admin/wallet/reverse', { opId: origOpId, reason: '先冲一笔' }, AUTH);
    expect(ok.status).toBe(200);
    const reverseOpId = ctx.db.ops.find((o) => o.actionId === `admin:reverse:${origOpId}`)!.id;
    const opsAfterFirst = ctx.db.ops.length;

    const again = await probe.postJson('/api/admin/wallet/reverse', { opId: reverseOpId, reason: '再冲' }, AUTH);

    expect(again.status).toBe(409);
    expect(again.body).toEqual({ code: ErrCode.BAD_PARAM, message: '该操作不可冲正', data: null });
    expect(ctx.db.ops.length).toBe(opsAfterFirst);
    expect(ctx.db.accounts.get('rev-j')!.balance).toBe(0);
  });

  it('op 不存在 ⇒ 404 借 10001「操作不存在」；只读 op、flows 不读（零写）', async () => {
    const res = await probe.postJson('/api/admin/wallet/reverse', { opId: 999, reason: '不存在' }, AUTH);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: ErrCode.BAD_PARAM, message: '操作不存在', data: null });
    expect(directReads).toEqual([{ sql: REVERSE_OP_SQL, params: [999] }]);
    expect(ctx.db.ops).toEqual([]);
    expect(ctx.db.flows).toEqual([]);
  });

  it('body 预闸：opId 正整数 / reason 1..200 ⇒ 400 借 10001 且**未碰库**；200 字上界内含', async () => {
    const reasonMsg = (v: unknown) => `reason 必须是 1..200 字符的非空字符串（收到 ${JSON.stringify(v)}）`;
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ reason: 'x' }, 'opId 非法：须为正整数', 'opId 缺失'],
      [{ opId: 0, reason: 'x' }, 'opId 非法：须为正整数', 'opId=0'],
      [{ opId: -1, reason: 'x' }, 'opId 非法：须为正整数', 'opId 负'],
      [{ opId: 1.5, reason: 'x' }, 'opId 非法：须为正整数', 'opId 小数'],
      [{ opId: '5', reason: 'x' }, 'opId 非法：须为正整数', 'opId 字符串'],
      [{ opId: 2 ** 53, reason: 'x' }, 'opId 非法：须为正整数', 'opId 超安全整数'],
      [{ opId: null, reason: 'x' }, 'opId 非法：须为正整数', 'opId null'],
      [{ opId: 1 }, reasonMsg(undefined), 'reason 缺失'],
      [{ opId: 1, reason: '' }, reasonMsg(''), 'reason 空串'],
      [{ opId: 1, reason: 123 }, reasonMsg(123), 'reason 非字符串'],
      [{ opId: 1, reason: 'a'.repeat(201) }, reasonMsg('a'.repeat(201)), 'reason 201 字（>200）'],
    ];

    for (const [body, message, label] of cases) {
      const res = await probe.postJson('/api/admin/wallet/reverse', body, AUTH);
      expect(res.status, label).toBe(400);
      expect(res.body, label).toEqual({ code: ErrCode.BAD_PARAM, message, data: null });
    }
    expect(directReads).toEqual([]); // 校验先于**任何**库操作
    expect(ctx.db.ops).toEqual([]);

    // 上界内含：reason=200 字 ⇒ 200（预闸 1..200 闭区间上端）
    const origOpId = await seedAdjust('admin:t7-max', [{ ownerId: 'rev-m', delta: 1 }]);
    const maxOk = await probe.postJson(
      '/api/admin/wallet/reverse',
      { opId: origOpId, reason: 'a'.repeat(200) },
      AUTH,
    );
    expect(maxOk.status).toBe(200);
  });
});

describe('POST /api/admin/wallet/reverse（guard / 注册面 / reversed 旗）', () => {
  it('写端点 guard：缺 X-Admin ⇒ 401；缺/非法 actor ⇒ 401「管理身份缺失」（零查询、零写）', async () => {
    const origOpId = await seedAdjust('admin:t7-guard', [{ ownerId: 'rev-k', delta: 10 }]);
    const readsBefore = directReads.length;
    const opsBefore = ctx.db.ops.length;

    const forgedAdmin: Array<Record<string, string>> = [{}, { 'x-admin': '0' }, { 'x-admin': '' }];
    for (const headers of forgedAdmin) {
      const res = await probe.postJson('/api/admin/wallet/reverse', { opId: origOpId, reason: '偷冲' }, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.body, JSON.stringify(headers)).toEqual({
        code: ErrCode.UNAUTHENTICATED,
        message: 'admin header required',
        data: null,
      });
    }
    const forgedActor: Array<Record<string, string>> = [
      { 'x-admin': '1' },
      { 'x-admin': '1', 'x-admin-actor': 'BAD' },
    ];
    for (const headers of forgedActor) {
      const res = await probe.postJson('/api/admin/wallet/reverse', { opId: origOpId, reason: '偷冲' }, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.body, JSON.stringify(headers)).toEqual({
        code: ErrCode.UNAUTHENTICATED,
        message: '管理身份缺失',
        data: null,
      });
    }

    expect(directReads.length).toBe(readsBefore); // handler 未触到
    expect(ctx.db.ops.length).toBe(opsBefore);
  });

  it('注册面（T6 教训）：AppModule providers 含 ReverseService；控制器类挂 XAdminGuard', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(ReverseService);
    const guards = Reflect.getMetadata('__guards__', AdminFinanceController) as unknown[];
    expect(guards).toContain(XAdminGuard);
  });

  it('reversed 旗翻转：冲正落 `admin:reverse:<opId>` op 行 ⇒ T6 详情路由 EXISTS 旗实测翻 true', async () => {
    const origOpId = await seedAdjust('admin:t7-flag', [{ ownerId: 'rev-l', delta: 15 }]);

    const before = await probe.get(`/api/admin/wallet/ops/${origOpId}`, { 'x-admin': '1' });
    expect(before.status).toBe(200);
    expect(before.body.data.rows.map((r: any) => r.reversed)).toEqual([false]);

    const rev = await probe.postJson('/api/admin/wallet/reverse', { opId: origOpId, reason: '旗用例' }, AUTH);
    expect(rev.status).toBe(200);

    const after = await probe.get(`/api/admin/wallet/ops/${origOpId}`, { 'x-admin': '1' });
    expect(after.status).toBe(200);
    expect(after.body.data.rows.map((r: any) => r.reversed)).toEqual([true]);
  });
});
