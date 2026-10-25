/**
 * `ApplyService` 的行为面 —— 货币片 T3 / 规格 §2.3（判定算法逐字）+ §6.1 apply 行**全列**。
 *
 * ─── 夹具（两件）─────────────────────────────────────────────────────────
 *  - **假 DB**（`helpers/fake-currency-db.ts`）：仿真事务契约与三条 SQL 的真语义
 *    （条件更新 `balance + delta >= 0` / INSERT IGNORE 的回执 / 撞 uk_action_id 抛
 *    ER_DUP_ENTRY），**不是**按调用序返回剧本的桩 —— 承重语义（余额算术、回滚边界、
 *    控制流分叉）都在「库行为」这一层。**真并发原子性不由本文件证明**（C7 主载体 =
 *    T10 slice-17 burst；本文件只钉控制流，见 `apply.concurrency.test.ts` 文件头）。
 *  - **假 Redis**：真存储 + 调用记录 + 失败注入（写穿失败用例）。
 *
 * ─── 覆盖（§6.1 apply.service 行全列）────────────────────────────────────
 *  入账（建行）/ 扣账 / 重放（同 id 同 hash）/ 14002（同 id 异 hash，含 delta 与
 *  ownerType 两变体）/ 不足整批回滚（批内其他账户零变化 + 未开户负 delta 无零行残留）/
 *  ownerType 首写固化 + 异型 10001 / **⚙️14：快照步锁定读撞并发异型首写 ⇒ 10001 +
 *  整批回滚（POS 路径）；重查/快照的锁定读形态钉死；UPDATE 回执 >1 ⇒ 内部错响亮** / 批量同
 *  op_id 多行 flows + 响应 ownerId 升序 / balance_after 快照 / 校验矩阵全项（不触库）/
 *  写穿缓存成功与失败（warn + counter，逐条独立）/ commit 先于写穿 / 指标三桶语义（§2.12 表）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import {
  ErrCode,
  currencyApplyHash,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type CurrencyApplyResponse,
} from '@fight-the-landlord/protocol';
import { ApplyEffectRejectError, ApplyService } from '../src/apply/apply.service';
import {
  currencyApplyEntriesTotal,
  currencyApplyTotal,
  currencyReconcileCacheDriftTotal,
} from '../src/metrics/currency.metrics';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

/** 一次 apply 的默认载荷（admin_adjust 的必填边 actor/reason 给齐）。 */
const mkReq = (over: Partial<CurrencyApplyRequest> = {}): CurrencyApplyRequest => ({
  actionId: 'admin:t3-1',
  source: 'admin_adjust',
  actor: 'admin',
  reason: 'T3 单测',
  entries: [{ ownerId: 'u-a', delta: 100 }],
  ...over,
});

/** 语句短名（断言的是**控制流序列**；实现侧 SQL 漂移到识别不了会现形为 `unknown:*`）。 */
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

/** metric 读面（结构类型，不引 prom-client 的类型 —— 本包不直接依赖它）。 */
interface MetricLike {
  get(): Promise<{
    values: Array<{ value: number; labels: Partial<Record<string, string | number>> }>;
  }>;
}

async function counterValue(counter: MetricLike, labels?: Record<string, string>): Promise<number> {
  const { values } = await counter.get();
  return values
    .filter(
      (v) =>
        labels === undefined ||
        Object.entries(labels).every(([name, expected]) => String(v.labels[name]) === expected),
    )
    .reduce((sum, v) => sum + v.value, 0);
}

function expectOk(res: CurrencyApplyResponse): CurrencyApplyData {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(`期望成功，收到 ${res.code}:${res.message}`);
  return res.data;
}

function expectReject(res: CurrencyApplyResponse, code: ErrCode): string {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('期望业务拒绝，收到成功');
  expect(res.code).toBe(code);
  expect(typeof res.message).toBe('string');
  expect(res.message.length).toBeGreaterThan(0);
  return res.message;
}

describe('§2.3 apply 写路径内核（规格逐字）', () => {
  let timeline: string[];
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let service: ApplyService;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    timeline = [];
    db = new FakeCurrencyDb(timeline);
    redis = new FakeRedis(timeline);
    service = new ApplyService(db.dataSource as unknown as DataSource, redis as unknown as Redis);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  const sqlsOf = (txIndex: number): string[] =>
    db.txLog[txIndex]!.statements.map((statement) => statement.sql);
  const kindsOf = (txIndex: number): string[] => sqlsOf(txIndex).map(kindOf);

  it('入账建行：ops → 类型闸 → UPDATE(0) → INSERT IGNORE(1) → 重试 UPDATE(1) → 快照 → 流水；提交后写穿缓存', async () => {
    const req = mkReq({
      actionId: 'signup:u-1',
      source: 'signup_grant',
      actor: undefined,
      reason: undefined,
      refId: 'u-1',
      entries: [{ ownerId: 'u-1', delta: 250 }],
    });

    const data = expectOk(await service.apply(req));

    expect(data).toEqual({
      opId: 1,
      actionId: 'signup:u-1',
      entries: [{ ownerId: 'u-1', balanceAfter: 250 }],
      replayed: false,
    });
    // 建行 + 余额 + 首写类型固化
    expect(db.accounts.get('u-1')).toEqual({ ownerType: 'user', balance: 250 });
    // ops：指纹/来源/actor/reason/refId/traceId 逐字段（meta 未传 ⇒ trace_id = null）
    expect(db.ops).toHaveLength(1);
    expect(db.ops[0]).toMatchObject({
      actionId: 'signup:u-1',
      requestHash: currencyApplyHash(req),
      source: 'signup_grant',
      actor: null,
      reason: null,
      refId: 'u-1',
      traceId: null,
    });
    // 流水：与快照同值、opId 一致
    expect(db.flows).toHaveLength(1);
    expect(db.flows[0]).toMatchObject({
      opId: 1,
      ownerId: 'u-1',
      ownerType: 'user',
      delta: 250,
      balanceAfter: 250,
    });
    // 控制流序列（恰七条）：INSERT IGNORE 后**必须**有一次重试 UPDATE（首次 UPDATE 发生在行存在之前）
    expect(kindsOf(0)).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'balance.update',
      'balance.select',
      'flow.insert',
    ]);
    expect(db.txLog[0]!.committed).toBe(true);
    // 提交**之后**才写穿缓存；键/值照 §2.11（十进制字符串、无 TTL）
    expect(timeline).toEqual(['commit', 'set:currency:balance:u-1']);
    expect(redis.store.get('currency:balance:u-1')).toBe('250');
  });

  it('A2：gameType 落库（游戏来源缺席=doudizhu / 显式=pdk；非游戏来源=NULL）', async () => {
    const settleDefault = mkReq({
      actionId: 'settle:s-a:1',
      source: 'game_settle',
      actor: undefined,
      reason: undefined,
      refId: 's-a:1',
      entries: [{ ownerId: 'gt-a', delta: 10 }],
    });
    expectOk(await service.apply(settleDefault));
    expect(db.ops[0]!.gameType).toBe('doudizhu');

    const settlePdk = mkReq({
      actionId: 'settle:s-b:1',
      source: 'game_settle',
      gameType: 'paodekuai',
      actor: undefined,
      reason: undefined,
      refId: 's-b:1',
      entries: [{ ownerId: 'gt-b', delta: 10 }],
    });
    expectOk(await service.apply(settlePdk));
    expect(db.ops[1]!.gameType).toBe('paodekuai');

    const admin = mkReq({ actionId: 'admin:gt-c', entries: [{ ownerId: 'gt-c', delta: 10 }] });
    expectOk(await service.apply(admin));
    expect(db.ops[2]!.gameType).toBeNull();

    const signup = mkReq({
      actionId: 'signup:gt-d',
      source: 'signup_grant',
      actor: undefined,
      reason: undefined,
      refId: 'gt-d',
      entries: [{ ownerId: 'gt-d', delta: 10 }],
    });
    expectOk(await service.apply(signup));
    expect(db.ops[3]!.gameType).toBeNull();

    // card_counter 能力仅斗地主：room 不传 gameType ⇒ 来源归一 ddz（不是 NULL）
    db.seedAccount('gt-e', 'user', 10);
    const cardCounter = mkReq({
      actionId: 'cc:gt-e',
      source: 'card_counter',
      actor: undefined,
      reason: undefined,
      entries: [{ ownerId: 'gt-e', delta: -1 }],
    });
    expectOk(await service.apply(cardCounter));
    expect(db.ops[4]!.gameType).toBe('doudizhu');
  });

  it('A2：同 actionId 异 gameType ⇒ 重放（gameType 不入指纹），库内玩法取首写值', async () => {
    const first = mkReq({
      actionId: 'settle:gt-replay:1',
      source: 'game_settle',
      gameType: 'paodekuai',
      actor: undefined,
      reason: undefined,
      refId: 'gt-replay:1',
      entries: [{ ownerId: 'gt-r', delta: 10 }],
    });
    expectOk(await service.apply(first));
    expect(db.ops[0]!.gameType).toBe('paodekuai');

    const second = await service.apply({ ...first, gameType: 'doudizhu' });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected replay');
    expect(second.data.replayed).toBe(true);
    expect(db.ops).toHaveLength(1);
    expect(db.ops[0]!.gameType).toBe('paodekuai'); // 重放不更新归因
  });

  it('扣账：既有行条件更新一次命中；meta.traceId 落 ops.trace_id；余额 100 → 70', async () => {
    db.seedAccount('u-b', 'user', 100);
    const req = mkReq({
      actionId: 'admin:t3-debit',
      meta: { traceId: 'trace-abc' },
      entries: [{ ownerId: 'u-b', delta: -30 }],
    });

    const data = expectOk(await service.apply(req));

    expect(data.entries).toEqual([{ ownerId: 'u-b', balanceAfter: 70 }]);
    expect(db.accounts.get('u-b')).toEqual({ ownerType: 'user', balance: 70 });
    expect(db.flows[0]).toMatchObject({ delta: -30, balanceAfter: 70 });
    expect(db.ops[0]!.traceId).toBe('trace-abc');
    // 无 INSERT IGNORE 分支（行在且余额足够）
    expect(kindsOf(0)).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'balance.select',
      'flow.insert',
    ]);
    expect(redis.store.get('currency:balance:u-b')).toBe('70');
  });

  it('重放：同 actionId 同载荷 ⇒ replayed:true、opId/balanceAfter 与首发一致、ops/flows 行数不变、不写穿缓存', async () => {
    const req = mkReq({ actionId: 'admin:r1', entries: [{ ownerId: 'u-a', delta: 100 }] });
    const first = expectOk(await service.apply(req));
    const setCallsAfterFirst = redis.calls.filter((call) => call.op === 'set').length;

    const second = expectOk(await service.apply(req));

    expect(second).toEqual({ ...first, replayed: true });
    // 库零变化
    expect(db.ops).toHaveLength(1);
    expect(db.flows).toHaveLength(1);
    expect(db.accounts.get('u-a')).toEqual({ ownerType: 'user', balance: 100 });
    // 重放 = 撞键主事务（回滚，恰一条 ops.insert）+ 重放判定事务（只读，ops.select → flows.byOp）
    expect(db.txLog).toHaveLength(3);
    expect(db.txLog[0]!.committed).toBe(true);
    expect(db.txLog[1]!.committed).toBe(false);
    expect(kindsOf(1)).toEqual(['ops.insert']);
    expect(db.txLog[2]!.committed).toBe(true);
    expect(kindsOf(2)).toEqual(['ops.select', 'flows.byOp']);
    // 重放值 = 历史快照 ⇒ 不写穿缓存（写回会把缓存拽回旧值）
    expect(redis.calls.filter((call) => call.op === 'set')).toHaveLength(setCallsAfterFirst);
    // 三桶：这次是 replay（不是 ok）
    expect(await counterValue(currencyApplyTotal, { source: 'admin_adjust', result: 'replay' })).toBeGreaterThan(0);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes('replay'))).toBe(true);
  });

  it('⚙️13 重放重建排序：混合大小写 ownerId 下，重放响应仍按 hash/执行序（JS code-unit 升序）而非 DB collation 序', async () => {
    // JS code-unit 序：'B'(0x42) < 'a'(0x61) ⇒ 执行序 = ['B-upper', 'a-lower']；
    // MySQL utf8mb4_0900_ai_ci 折叠后 'a-lower' < 'b-upper' ⇒ DB 序**相反**（假 DB 照此模拟）。
    const req = mkReq({
      actionId: 'admin:case-order',
      entries: [
        { ownerId: 'a-lower', delta: 1 },
        { ownerId: 'B-upper', delta: 2 },
      ],
    });
    const first = expectOk(await service.apply(req));
    expect(first.entries.map((entry) => entry.ownerId)).toEqual(['B-upper', 'a-lower']);

    const second = expectOk(await service.apply(req));

    expect(second.replayed).toBe(true);
    // 若实现裸信 SQL 的 ORDER BY owner_id，这里会拿到 ['a-lower', 'B-upper'] ⇒ 当场红
    expect(second.entries.map((entry) => entry.ownerId)).toEqual(['B-upper', 'a-lower']);
    expect(second.entries).toEqual(first.entries);
  });

  it('14002：同 actionId 异载荷（delta 变 / ownerType 变均异 hash）⇒ 拒绝、库零变化、响亮 error 日志', async () => {
    const req = mkReq({ actionId: 'admin:c1', entries: [{ ownerId: 'u-a', delta: 5 }] });
    expectOk(await service.apply(req));
    const rejectBefore = await counterValue(currencyApplyTotal, { source: 'admin_adjust', result: 'reject' });

    const deltaVariant = await service.apply(mkReq({ actionId: 'admin:c1', entries: [{ ownerId: 'u-a', delta: 6 }] }));
    const ownerTypeVariant = await service.apply(
      mkReq({ actionId: 'admin:c1', entries: [{ ownerId: 'u-a', ownerType: 'robot', delta: 5 }] }),
    );

    for (const res of [deltaVariant, ownerTypeVariant]) {
      const message = expectReject(res, ErrCode.E_ACTION_CONFLICT);
      expect(message).toContain('admin:c1');
    }
    // 库零变化：ops/flows 还是首发那一套、余额未动
    expect(db.ops).toHaveLength(1);
    expect(db.flows).toHaveLength(1);
    expect(db.accounts.get('u-a')).toEqual({ ownerType: 'user', balance: 5 });
    // 每次拒绝 = 撞键主事务（回滚，ops.insert）+ 重放判定事务（只读，ops.select 即判）
    expect(kindsOf(1)).toEqual(['ops.insert']);
    expect(kindsOf(2)).toEqual(['ops.select']);
    expect(kindsOf(3)).toEqual(['ops.insert']);
    expect(kindsOf(4)).toEqual(['ops.select']);
    // 响亮（level=error，含 actionId 与错误码 14002）
    expect(
      errorSpy.mock.calls.some(
        (args) => String(args[0]).includes('14002') && String(args[0]).includes('admin:c1'),
      ),
    ).toBe(true);
    expect(await counterValue(currencyApplyTotal, { source: 'admin_adjust', result: 'reject' })).toBe(rejectBefore + 2);
  });

  it('不足整批回滚：批内其他账户零变化（已入账的那半也随事务回滚）', async () => {
    db.seedAccount('u-a', 'user', 100);
    db.seedAccount('u-b', 'user', 5);
    const req = mkReq({
      actionId: 'admin:rollback-1',
      entries: [
        { ownerId: 'u-a', delta: 10 },
        { ownerId: 'u-b', delta: -999 },
      ],
    });

    const message = expectReject(await service.apply(req), ErrCode.E_INSUFFICIENT_FUNDS);

    expect(message).toContain('u-b');
    // 整批回滚：u-a 的 +10 不落库、u-b 的 5 分未动、ops/flows 零行
    expect(db.accounts.get('u-a')).toEqual({ ownerType: 'user', balance: 100 });
    expect(db.accounts.get('u-b')).toEqual({ ownerType: 'user', balance: 5 });
    expect(db.ops).toHaveLength(0);
    expect(db.flows).toHaveLength(0);
    expect(db.txLog[0]!.committed).toBe(false);
    // 控制流：u-a 走完成功分支（含快照），u-b 走完整拒绝分支（UPDATE 0 ⇒ INSERT IGNORE 0 ⇒ ⚙️12 重查 ⇒ 重试 0 ⇒ 14001）
    expect(kindsOf(0)).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'balance.select',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'ownerType.select',
      'balance.update',
    ]);
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('14001'))).toBe(true);
    // 失败不写缓存
    expect(redis.calls.filter((call) => call.op === 'set')).toHaveLength(0);
  });

  it('不足整批回滚：未开户的负 delta ⇒ 14001 且 INSERT IGNORE 建的行随之回滚（无零行残留）', async () => {
    const req = mkReq({
      actionId: 'admin:rollback-2',
      entries: [{ ownerId: 'u-none', delta: -1 }],
    });

    expectReject(await service.apply(req), ErrCode.E_INSUFFICIENT_FUNDS);

    expect(db.accounts.has('u-none')).toBe(false);
    expect(db.ops).toHaveLength(0);
    expect(db.flows).toHaveLength(0);
    expect(kindsOf(0)).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'balance.update',
    ]);
  });

  it('ownerType 首写固化：robot 首建 ⇒ 账户行 owner_type=robot；异型（user）⇒ 10001 + 响亮日志、库零变化', async () => {
    const first = mkReq({ actionId: 'admin:bot-1', entries: [{ ownerId: 'bot-1', ownerType: 'robot', delta: 50 }] });
    expectOk(await service.apply(first));
    expect(db.accounts.get('bot-1')).toEqual({ ownerType: 'robot', balance: 50 });

    // 同 ownerId、缺省 ownerType（归一 'user'）⇒ 类型闸当场拒
    const second = await service.apply(
      mkReq({ actionId: 'admin:bot-2', entries: [{ ownerId: 'bot-1', delta: 1 }] }),
    );

    const message = expectReject(second, ErrCode.BAD_PARAM);
    expect(message).toContain('robot');
    // 首个事务已提交（1 行 ops）；第二个事务整体回滚（ops 不留行）
    expect(db.ops).toHaveLength(1);
    expect(db.flows).toHaveLength(1);
    expect(db.accounts.get('bot-1')).toEqual({ ownerType: 'robot', balance: 50 });
    expect(kindsOf(1)).toEqual(['ops.insert', 'ownerType.select']);
    expect(db.txLog[1]!.committed).toBe(false);
    // 「爽亮」error 级（§2.12：owner_type_mismatch 响亮）
    expect(
      errorSpy.mock.calls.some(
        (args) => String(args[0]).includes('10001') && String(args[0]).includes('ownerId=bot-1'),
      ),
    ).toBe(true);
  });

  it('⚙️14①：类型闸空 → 并发异型首写被条件 UPDATE（当前读）命中成功 → c 步锁定读断言异型 ⇒ 10001 + 整批回滚', async () => {
    // T3 审查真库双会话实证的 POS 路径：步 a 看到「行不存在」放行；并发事务此刻以
    // **异型**（robot）首写并提交；本事务的正 delta 条件 UPDATE（当前读）直接命中该行、
    // 成功收尾 ⇒ 到不了 ⚙️12 重查点。唯一拦得住的是 c 步**锁定读**上的 owner_type 断言。
    db.seedAccount('u-ok', 'user', 100); // 批内先成功的 entry（证「整批回滚」）
    const req = mkReq({
      actionId: 'admin:t14-pos',
      entries: [
        { ownerId: 'u-ok', delta: 10 },
        { ownerId: 'u-pos', delta: 5 },
      ],
    });
    // 注入面：u-pos 的条件 UPDATE 执行**之前**（类型闸已查过），对方会话提交 robot 首写
    db.beforeStatement = (sql, params, session) => {
      if (sql.startsWith('UPDATE `currency_accounts`') && params[1] === 'u-pos') {
        session.accounts.set('u-pos', { ownerType: 'robot', balance: 0 });
      }
    };

    const message = expectReject(await service.apply(req), ErrCode.BAD_PARAM);

    expect(message).toContain('u-pos');
    expect(message).toContain('robot');
    // 整批回滚：u-ok 的 +10 未落库、ops/flows 零行、注入行不在（scratch 随回滚丢弃）
    expect(db.accounts.get('u-ok')).toEqual({ ownerType: 'user', balance: 100 });
    expect(db.accounts.has('u-pos')).toBe(false);
    expect(db.ops).toHaveLength(0);
    expect(db.flows).toHaveLength(0);
    expect(db.txLog[0]!.committed).toBe(false);
    // 控制流：u-ok 走完（含锁定读快照）→ u-pos 类型闸空 → UPDATE 命中并发行成功（**无**
    // INSERT IGNORE —— 这正是 POS 路径）→ c 步锁定读读到异型 ⇒ 当场 10001
    expect(kindsOf(0)).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'balance.select',
      'ownerType.select',
      'balance.update',
      'balance.select',
    ]);
    // c 步必须是**锁定读**形态（⚙️14①）：普通 SELECT 在 RR 下读不到并发已提交行
    expect(sqlsOf(0)[6]).toBe(
      'SELECT `balance`, `owner_type` FROM `currency_accounts` WHERE `owner_id` = ? FOR UPDATE',
    );
    // 响亮（§2.12：owner_type_mismatch 是 error 级）
    expect(
      errorSpy.mock.calls.some(
        (args) => String(args[0]).includes('10001') && String(args[0]).includes('u-pos'),
      ),
    ).toBe(true);
    // 失败整批 ⇒ 不写缓存
    expect(redis.calls).toHaveLength(0);
  });

  it('⚙️14②：⚙️12 重查（INSERT IGNORE 0 行分支）为**锁定读**形态 —— 普通 SELECT 在 RR 下等于没查', async () => {
    db.seedAccount('u-lock', 'user', 3);
    const req = mkReq({ actionId: 'admin:t14-lock', entries: [{ ownerId: 'u-lock', delta: -10 }] });

    expectReject(await service.apply(req), ErrCode.E_INSUFFICIENT_FUNDS);

    const kinds = kindsOf(0);
    expect(kinds).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'ownerType.select', // 重查点（INSERT IGNORE 0 行之后）—— 形状见下
      'balance.update',
    ]);
    const recheckIndex = kinds.indexOf('ownerType.select', kinds.indexOf('account.insertIgnore'));
    expect(sqlsOf(0)[recheckIndex]).toBe(
      'SELECT `owner_type` FROM `currency_accounts` WHERE `owner_id` = ? FOR UPDATE',
    );
  });

  it('⚙️14③：条件 UPDATE 回执 > 1 行 ⇒ 内部错**响亮**（error 日志 + 系统级抛穿），不静默按成功', async () => {
    // 假 DB 的 UPDATE 只会回 0/1（唯一键下 > 1 不可达）⇒ 用最小桩注入畸形回执，
    // 验证收紧后的判读（`=== 1` 才成功；0/1 之外 ⇒ error 日志 + 抛，绝不按成功）。
    const stubDb = {
      transaction: (cb: (manager: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) =>
        cb({
          query: (sql: string) => {
            if (sql.startsWith('INSERT INTO `currency_ops`')) return Promise.resolve({ insertId: 1, affectedRows: 1 });
            if (sql.startsWith('SELECT `owner_type`')) return Promise.resolve([]); // 类型闸：行不存在 ⇒ 放行
            if (sql.startsWith('UPDATE `currency_accounts`')) return Promise.resolve({ affectedRows: 2 }); // 畸形
            return Promise.reject(new Error(`桩不该走到这：${sql}`));
          },
        }),
    } as unknown as DataSource;
    const stubService = new ApplyService(stubDb, redis as unknown as Redis);

    await expect(
      stubService.apply(mkReq({ actionId: 'admin:t14-rows', entries: [{ ownerId: 'u-stub', delta: 5 }] })),
    ).rejects.toThrow(/affectedRows=2/);
    // 响亮：error 日志（含 internal error 与读数）；不写缓存（系统级抛穿，不走信封）
    expect(
      errorSpy.mock.calls.some(
        (args) => String(args[0]).includes('internal error') && String(args[0]).includes('affectedRows=2'),
      ),
    ).toBe(true);
    expect(redis.calls).toHaveLength(0);
  });

  it('批量：同 op_id 多行 flows、响应与执行序均按 ownerId 升序（请求乱序送入）', async () => {
    const req = mkReq({
      actionId: 'admin:batch-1',
      entries: [
        { ownerId: 'u-c', delta: 1 },
        { ownerId: 'u-a', delta: 2 },
        { ownerId: 'u-b', delta: 3 },
      ],
    });

    const data = expectOk(await service.apply(req));

    // 响应升序（⚙️3）
    expect(data.entries.map((entry) => entry.ownerId)).toEqual(['u-a', 'u-b', 'u-c']);
    expect(data.entries).toEqual([
      { ownerId: 'u-a', balanceAfter: 2 },
      { ownerId: 'u-b', balanceAfter: 3 },
      { ownerId: 'u-c', balanceAfter: 1 },
    ]);
    // 执行序 = 类型闸出现序 = ownerId 升序
    expect(
      db.txLog[0]!.statements
        .filter((statement) => kindOf(statement.sql) === 'ownerType.select')
        .map((statement) => statement.params[0]),
    ).toEqual(['u-a', 'u-b', 'u-c']);
    // 同一 op_id、恰三行 flows
    expect(db.flows).toHaveLength(3);
    expect(new Set(db.flows.map((flow) => flow.opId))).toEqual(new Set([data.opId]));
    // 控制流：三个 entry 各自的五步走完，再统一写三条流水
    expect(kindsOf(0)).toEqual([
      'ops.insert',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'balance.update',
      'balance.select',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'balance.update',
      'balance.select',
      'ownerType.select',
      'balance.update',
      'account.insertIgnore',
      'balance.update',
      'balance.select',
      'flow.insert',
      'flow.insert',
      'flow.insert',
    ]);
  });

  it('balance_after 快照：第二次 apply 的快照读的是库当前值（100 → 60），不是请求侧的推算', async () => {
    expectOk(
      await service.apply(mkReq({ actionId: 'admin:s1', entries: [{ ownerId: 'u-a', delta: 100 }] })),
    );
    const second = expectOk(
      await service.apply(mkReq({ actionId: 'admin:s2', entries: [{ ownerId: 'u-a', delta: -40 }] })),
    );

    expect(second.entries).toEqual([{ ownerId: 'u-a', balanceAfter: 60 }]);
    expect(db.flows[1]).toMatchObject({ delta: -40, balanceAfter: 60 });
    expect(redis.store.get('currency:balance:u-a')).toBe('60');
  });

  it('写穿缓存失败：不回滚（权威值在 MySQL 与响应）、level=warn（cache_write_failed）+ counter、逐条独立继续', async () => {
    redis.failKeys.add('currency:balance:u-a');
    const driftBefore = await counterValue(currencyReconcileCacheDriftTotal);
    const req = mkReq({
      actionId: 'admin:cache-fail',
      entries: [
        { ownerId: 'u-a', delta: 10 },
        { ownerId: 'u-b', delta: 20 },
      ],
    });

    const data = expectOk(await service.apply(req));

    // 提交照旧 + 响应带权威值
    expect(db.txLog[0]!.committed).toBe(true);
    expect(db.ops).toHaveLength(1);
    expect(db.flows).toHaveLength(2);
    expect(data.entries).toEqual([
      { ownerId: 'u-a', balanceAfter: 10 },
      { ownerId: 'u-b', balanceAfter: 20 },
    ]);
    // warn + 单一计数器（§2.11：写穿失败与对账删除同一计数器）
    expect(
      warnSpy.mock.calls.some(
        (args) => String(args[0]).includes('cache_write_failed') && String(args[0]).includes('u-a'),
      ),
    ).toBe(true);
    expect(await counterValue(currencyReconcileCacheDriftTotal)).toBe(driftBefore + 1);
    // 逐条独立：u-a 失败不跳过 u-b
    expect(redis.store.has('currency:balance:u-a')).toBe(false);
    expect(redis.store.get('currency:balance:u-b')).toBe('20');
    expect(redis.calls.filter((call) => call.op === 'set')).toHaveLength(2);
  });

  it('指标语义（§2.12 表）：ok 计 entries；重放/拒绝只计 apply_total 的对应桶、不计 entries', async () => {
    const req = mkReq({
      actionId: 'admin:metrics-1',
      entries: [
        { ownerId: 'u-a', delta: 1 },
        { ownerId: 'u-b', delta: 2 },
      ],
    });

    const okBefore = await counterValue(currencyApplyTotal, { source: 'admin_adjust', result: 'ok' });
    const entriesBefore = await counterValue(currencyApplyEntriesTotal);
    expectOk(await service.apply(req));
    expect(await counterValue(currencyApplyTotal, { source: 'admin_adjust', result: 'ok' })).toBe(okBefore + 1);
    expect(await counterValue(currencyApplyEntriesTotal)).toBe(entriesBefore + 2);

    const replayBefore = await counterValue(currencyApplyTotal, { source: 'admin_adjust', result: 'replay' });
    expectOk(await service.apply(req)); // 同 id 同载荷 ⇒ replay
    expect(await counterValue(currencyApplyTotal, { source: 'admin_adjust', result: 'replay' })).toBe(replayBefore + 1);
    expect(await counterValue(currencyApplyEntriesTotal)).toBe(entriesBefore + 2);

    const rejectBefore = await counterValue(currencyApplyTotal, { source: 'admin_adjust', result: 'reject' });
    expectReject(
      await service.apply(mkReq({ actionId: 'admin:metrics-1', entries: [{ ownerId: 'u-a', delta: 999 }] })),
      ErrCode.E_ACTION_CONFLICT,
    ); // 同 id 异载荷 ⇒ reject
    expect(await counterValue(currencyApplyTotal, { source: 'admin_adjust', result: 'reject' })).toBe(rejectBefore + 1);
    expect(await counterValue(currencyApplyEntriesTotal)).toBe(entriesBefore + 2);
  });

  describe('校验矩阵（§2.3 字段表；全部 10001 且不触库）', () => {
    const validEntry = { ownerId: 'u-a', delta: 1 };
    const cases: Array<{ label: string; req: unknown; expectedSource: string }> = [
      {
        label: 'source 非 allowlist',
        req: { actionId: 'a-1', source: 'pay', entries: [validEntry] },
        expectedSource: 'invalid',
      },
      {
        label: 'delta = 0',
        req: { actionId: 'a-2', source: 'admin_adjust', actor: 'admin', reason: 'r', entries: [{ ownerId: 'u-a', delta: 0 }] },
        expectedSource: 'admin_adjust',
      },
      {
        label: '|delta| > 1,000,000',
        req: {
          actionId: 'a-3',
          source: 'admin_adjust',
          actor: 'admin',
          reason: 'r',
          entries: [{ ownerId: 'u-a', delta: 1_000_001 }],
        },
        expectedSource: 'admin_adjust',
      },
      {
        label: 'entries 为空',
        req: { actionId: 'a-4', source: 'admin_adjust', actor: 'admin', reason: 'r', entries: [] },
        expectedSource: 'admin_adjust',
      },
      {
        label: 'entries 21 条',
        req: {
          actionId: 'a-5',
          source: 'admin_adjust',
          actor: 'admin',
          reason: 'r',
          entries: Array.from({ length: 21 }, (_, i) => ({ ownerId: `u-${String(i).padStart(2, '0')}`, delta: 1 })),
        },
        expectedSource: 'admin_adjust',
      },
      {
        label: '重复 ownerId',
        req: {
          actionId: 'a-6',
          source: 'admin_adjust',
          actor: 'admin',
          reason: 'r',
          entries: [
            { ownerId: 'u-a', delta: 1 },
            { ownerId: 'u-a', delta: 2 },
          ],
        },
        expectedSource: 'admin_adjust',
      },
      {
        label: 'ownerId 超长（37 字符）',
        req: {
          actionId: 'a-7',
          source: 'admin_adjust',
          actor: 'admin',
          reason: 'r',
          entries: [{ ownerId: 'x'.repeat(37), delta: 1 }],
        },
        expectedSource: 'admin_adjust',
      },
      {
        label: 'ownerId 非法字符',
        req: {
          actionId: 'a-8',
          source: 'admin_adjust',
          actor: 'admin',
          reason: 'r',
          entries: [{ ownerId: 'u.a', delta: 1 }],
        },
        expectedSource: 'admin_adjust',
      },
      {
        label: 'actionId 为空',
        req: { actionId: '', source: 'admin_adjust', actor: 'admin', reason: 'r', entries: [validEntry] },
        expectedSource: 'admin_adjust',
      },
      {
        label: 'actionId 129 字符',
        req: {
          actionId: 'a'.repeat(129),
          source: 'admin_adjust',
          actor: 'admin',
          reason: 'r',
          entries: [validEntry],
        },
        expectedSource: 'admin_adjust',
      },
      {
        label: 'admin_adjust 缺 actor',
        req: { actionId: 'a-11', source: 'admin_adjust', reason: 'r', entries: [validEntry] },
        expectedSource: 'admin_adjust',
      },
      {
        label: 'admin_adjust 缺 reason',
        req: { actionId: 'a-12', source: 'admin_adjust', actor: 'admin', entries: [validEntry] },
        expectedSource: 'admin_adjust',
      },
      {
        label: 'ownerType 非法',
        req: {
          actionId: 'a-13',
          source: 'admin_adjust',
          actor: 'admin',
          reason: 'r',
          entries: [{ ownerId: 'u-a', ownerType: 'ghost', delta: 1 }],
        },
        expectedSource: 'admin_adjust',
      },
    ];

    it.each(cases)('$label ⇒ 10001（中文原因）+ 不触库 + 拒绝计数', async ({ req, expectedSource }) => {
      const before = await counterValue(currencyApplyTotal, { source: expectedSource, result: 'reject' });

      const res = await service.apply(req);

      expectReject(res, ErrCode.BAD_PARAM);
      // 校验先于任何库操作：没有事务、没有缓存调用
      expect(db.txLog).toHaveLength(0);
      expect(redis.calls).toHaveLength(0);
      expect(await counterValue(currencyApplyTotal, { source: expectedSource, result: 'reject' })).toBe(before + 1);
    });
  });

  it('结算销毁两列（本片）：burn 在场 ⇒ 落实值（0 也是实值）；缺席 ⇒ 两列 null', async () => {
    db.seedAccount('u-burn-a', 'user', 100);
    db.seedAccount('u-burn-b', 'user', 100);

    expectOk(
      await service.apply(
        mkReq({
          actionId: 'settle:s-1',
          source: 'game_settle',
          refId: 's-1',
          entries: [
            { ownerId: 'u-burn-a', delta: 12 },
            { ownerId: 'u-burn-b', delta: -25 },
          ],
          burn: { residue: 13, rake: 0 },
        }),
      ),
    );
    expect(db.ops[0]).toMatchObject({ burnedResidue: 13, burnedRake: 0 });

    expectOk(
      await service.apply(
        mkReq({
          actionId: 'settle:s-2',
          source: 'game_settle',
          refId: 's-2',
          entries: [
            { ownerId: 'u-burn-a', delta: 5 },
            { ownerId: 'u-burn-b', delta: -5 },
          ],
          burn: { residue: 0, rake: 0 },
        }),
      ),
    );
    expect(db.ops[1]).toMatchObject({ burnedResidue: 0, burnedRake: 0 }); // 0 ≠ null（D1）

    expectOk(
      await service.apply(
        mkReq({
          actionId: 'settle:s-3',
          source: 'game_settle',
          refId: 's-3',
          entries: [
            { ownerId: 'u-burn-a', delta: 5 },
            { ownerId: 'u-burn-b', delta: -5 },
          ],
        }),
      ),
    );
    expect(db.ops[2]).toMatchObject({ burnedResidue: null, burnedRake: null }); // 未记录
  });

  it('重放（本片）：同 id 同载荷（含 burn）⇒ replayed:true、两列不变、行数不变', async () => {
    db.seedAccount('u-burn-a', 'user', 100);
    db.seedAccount('u-burn-b', 'user', 100);
    const req = mkReq({
      actionId: 'settle:r-1',
      source: 'game_settle',
      refId: 'r-1',
      entries: [
        { ownerId: 'u-burn-a', delta: 7 },
        { ownerId: 'u-burn-b', delta: -7 },
      ],
      burn: { residue: 0, rake: 0 },
    });
    const first = expectOk(await service.apply(req));
    const replay = expectOk(await service.apply(req));

    expect(replay.replayed).toBe(true);
    expect(replay.opId).toBe(first.opId);
    expect(db.ops).toHaveLength(1);
    expect(db.ops[0]).toMatchObject({ burnedResidue: 0, burnedRake: 0 });
  });

  it('不变量不符 ⇒ {ok:false, 10001}（中文原因）且零库操作（校验先于一切库步）', async () => {
    db.seedAccount('u-burn-a', 'user', 100);
    db.seedAccount('u-burn-b', 'user', 100);
    const res = await service.apply(
      mkReq({
        actionId: 'settle:x-1',
        source: 'game_settle',
        refId: 'x-1',
        entries: [
          { ownerId: 'u-burn-a', delta: 5 },
          { ownerId: 'u-burn-b', delta: -5 },
        ],
        burn: { residue: 3, rake: 0 },
      }),
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable: 上一行已断言');
    expect(res.code).toBe(ErrCode.BAD_PARAM);
    expect(res.message).toContain('burn 与分录金额不符');
    expect(db.ops).toHaveLength(0);
    expect(db.txLog).toHaveLength(0);
  });

  it('响应零变更（D5）：CurrencyApplyData 恰四键、无 burn', async () => {
    db.seedAccount('u-burn-a', 'user', 100);
    db.seedAccount('u-burn-b', 'user', 100);
    const data = expectOk(
      await service.apply(
        mkReq({
          actionId: 'settle:d-1',
          source: 'game_settle',
          refId: 'd-1',
          entries: [
            { ownerId: 'u-burn-a', delta: 6 },
            { ownerId: 'u-burn-b', delta: -6 },
          ],
          burn: { residue: 0, rake: 0 },
        }),
      ),
    );
    expect(Object.keys(data).sort()).toEqual(['actionId', 'entries', 'opId', 'replayed']);
  });
});

describe('applyWithEffect（记牌器收费片：同事务钩子）', () => {
  let timeline: string[];
  let db: FakeCurrencyDb;
  let service: ApplyService;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    timeline = [];
    db = new FakeCurrencyDb(timeline);
    service = new ApplyService(
      db.dataSource as unknown as DataSource,
      new FakeRedis(timeline) as unknown as Redis,
    );
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('apply ≡ applyWithEffect(noop)：同载荷同结果（同一内核）', async () => {
    const req = mkReq({ actionId: 'effect:noop', entries: [{ ownerId: 'u-eff-1', delta: 100 }] });
    const direct = expectOk(await service.apply(req));
    const db2 = new FakeCurrencyDb([]);
    const service2 = new ApplyService(
      db2.dataSource as unknown as DataSource,
      new FakeRedis([]) as unknown as Redis,
    );
    const withEffect = expectOk(await service2.applyWithEffect(req, async () => undefined));
    expect(withEffect).toMatchObject({
      actionId: direct.actionId,
      entries: direct.entries,
      replayed: false,
    });
    expect(db.ops).toHaveLength(1);
    expect(db2.ops).toHaveLength(1);
  });

  it('effect 在 flows 之后、commit 之前（同一事务；effect 内看不到已提交的 ops）', async () => {
    let effectRan = false;
    const res = await service.applyWithEffect(
      mkReq({ actionId: 'effect:order', entries: [{ ownerId: 'u-eff-2', delta: 50 }] }),
      async (manager) => {
        effectRan = true;
        expect(typeof manager.query).toBe('function');
        // 事务尚未提交：已提交视图里还没有本 op（提交后才可见）。
        expect(db.ops).toHaveLength(0);
      },
    );
    expectOk(res);
    expect(effectRan).toBe(true);
    expect(db.ops).toHaveLength(1);
  });

  it('effect 业务拒绝 14008 ⇒ {ok:false} 信封 + 整批回滚（账户/ops/flows 全无）', async () => {
    const res = await service.applyWithEffect(
      mkReq({ actionId: 'effect:reject', entries: [{ ownerId: 'u-eff-3', delta: 100 }] }),
      async () => {
        throw new ApplyEffectRejectError(ErrCode.E_CARD_COUNTER_UNAVAILABLE, '记牌器未开放');
      },
    );
    expectReject(res, ErrCode.E_CARD_COUNTER_UNAVAILABLE);
    expect(db.ops).toHaveLength(0);
    expect(db.flows).toHaveLength(0);
    expect(db.accounts.size).toBe(0);
  });

  it('重放（同 id 同 hash）不执行 effect', async () => {
    const req = mkReq({ actionId: 'effect:replay', entries: [{ ownerId: 'u-eff-4', delta: 10 }] });
    expectOk(await service.apply(req));
    let effectCalls = 0;
    const res = await service.applyWithEffect(req, async () => {
      effectCalls += 1;
    });
    const data = expectOk(res);
    expect(data.replayed).toBe(true);
    expect(effectCalls).toBe(0);
  });

  it('非 uk_action_id 的 1062 不得进 replay：抛系统错且无残留', async () => {
    const err = new Error(
      "Duplicate entry 'x' for key 'card_counter_purchases.uk_cc_purchase_action'",
    ) as Error & { code?: string; errno?: number };
    err.code = 'ER_DUP_ENTRY';
    err.errno = 1062;

    await expect(
      service.applyWithEffect(
        mkReq({ actionId: 'effect:other-dup', entries: [{ ownerId: 'u-eff-5', delta: 100 }] }),
        async () => {
          throw err;
        },
      ),
    ).rejects.toThrow(/uk_cc_purchase_action/);
    expect(db.ops).toHaveLength(0);
    expect(db.flows).toHaveLength(0);
    expect(db.accounts.size).toBe(0);
  });
});
