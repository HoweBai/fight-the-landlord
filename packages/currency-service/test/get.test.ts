/**
 * `GetService` 的行为面 —— 货币片 T4 / 规格 §2.4（get 契约）+ §6.1 get.service 行**全列**。
 *
 * ─── 覆盖（§6.1 get.service 行全列）──────────────────────────────────────
 *  批量 1..50（50 上界放行 / 51·空·非法 ⇒ 10001 且不触任何 IO）/ 与请求同序 /
 *  **允许重复**（唯一 ownerId 才回源）/ 缓存命中（即回、不回源不写）/ miss 回源写缓存 /
 *  `exists=false ⇒ balance:0` 且**不建行·不写缓存** / 缓存值损坏视同 miss 覆盖 /
 *  Redis 故障降级回源（warn + 结果不变）。
 *
 * ─── 夹具 ────────────────────────────────────────────────────────────────
 *  - **假 DB**（`helpers/fake-currency-db.ts`）：`dataSource.query` = 非事务直读面
 *    （只认余额单行读；`directQueries` 是「回源了吗 / 建行了吗」的判据）。
 *  - **假 Redis**：真存储 + 调用序记录 + 失败注入（`failKeys`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { ErrCode, type CurrencyGetResponse } from '@fight-the-landlord/protocol';
import { GetService } from '../src/apply/get.service';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

/** `currency:balance:<ownerId>`（⚙️4 逐字；与实现同面的字面量 —— 键名漂移会在这里现形）。 */
const KEY = (ownerId: string) => `currency:balance:${ownerId}`;

function expectOk(res: CurrencyGetResponse) {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(`期望成功，收到 ${res.code}:${res.message}`);
  return res.data;
}

function expectReject(res: CurrencyGetResponse, code: ErrCode): string {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('期望业务拒绝，收到成功');
  expect(res.code).toBe(code);
  expect(typeof res.message).toBe('string');
  expect(res.message.length).toBeGreaterThan(0);
  return res.message;
}

/** 直读语句短名：`balance.select` = 合法回源；其余形态（含 INSERT）自然现形为 `unknown:*`。 */
function kindOf(sql: string): string {
  if (sql.startsWith('SELECT `balance` FROM `currency_accounts`')) return 'balance.select';
  return `unknown:${sql.slice(0, 60)}`;
}

describe('§2.4 currency.get 读路径（缓存优先 / miss 回源写缓存 / 不建行）', () => {
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let service: GetService;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new FakeCurrencyDb();
    redis = new FakeRedis();
    service = new GetService(db.dataSource as unknown as DataSource, redis as unknown as Redis);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('缓存命中：即回缓存值（**不回源、不写**）—— 与库中值故意不同以示「缓存优先」', async () => {
    redis.store.set(KEY('u-1'), '700');
    db.seedAccount('u-1', 'user', 999);

    const res = expectOk(await service.get({ ownerIds: ['u-1'] }));

    expect(res.balances).toEqual([{ ownerId: 'u-1', balance: 700, exists: true }]);
    expect(db.directQueries).toEqual([]); // 未回源
    expect(redis.calls.map((c) => c.op)).toEqual(['get']); // 只读、未写
  });

  it('miss 回源 MySQL 并**写缓存**（读穿）：响应=库值、缓存被 SET 为十进制串', async () => {
    db.seedAccount('u-1', 'user', 250);

    const res = expectOk(await service.get({ ownerIds: ['u-1'] }));

    expect(res.balances).toEqual([{ ownerId: 'u-1', balance: 250, exists: true }]);
    expect(db.directQueries).toHaveLength(1);
    expect(kindOf(db.directQueries[0]!.sql)).toBe('balance.select');
    expect(db.directQueries[0]!.params).toEqual(['u-1']);
    expect(redis.store.get(KEY('u-1'))).toBe('250');
    expect(redis.calls.map((c) => c.op)).toEqual(['get', 'set']);
  });

  it('exists=false ⇒ balance:0 —— **不建行**（accounts 零新增）、**不写缓存**（写 0 会自造对账漂移）', async () => {
    const res = expectOk(await service.get({ ownerIds: ['ghost'] }));

    expect(res.balances).toEqual([{ ownerId: 'ghost', balance: 0, exists: false }]);
    expect(db.accounts.size).toBe(0); // 读路径绝不 INSERT
    expect(redis.store.size).toBe(0); // 缓存也不落 0（§2.12 检查 2 把「账户不存在而键在」算漂移）
    expect(redis.calls.map((c) => c.op)).toEqual(['get']);
    expect(db.directQueries.map((q) => kindOf(q.sql))).toEqual(['balance.select']); // 问过库、只是没有
  });

  it('与请求**同序一一对应** + **允许重复**：重复位由首次读穿写下的缓存接住（唯一 ownerId 才回源）', async () => {
    db.seedAccount('u-b', 'user', 30);
    db.seedAccount('u-a', 'user', 10);

    const res = expectOk(await service.get({ ownerIds: ['u-b', 'u-a', 'u-b'] }));

    expect(res.balances).toEqual([
      { ownerId: 'u-b', balance: 30, exists: true },
      { ownerId: 'u-a', balance: 10, exists: true },
      { ownerId: 'u-b', balance: 30, exists: true },
    ]);
    // 回源恰两次（每个唯一 ownerId 一次），顺序 = 首次出现序
    expect(db.directQueries.map((q) => q.params[0])).toEqual(['u-b', 'u-a']);
    expect(redis.calls.map((c) => `${c.op}:${c.key}`)).toEqual([
      `get:${KEY('u-b')}`,
      `set:${KEY('u-b')}`,
      `get:${KEY('u-a')}`,
      `set:${KEY('u-a')}`,
      `get:${KEY('u-b')}`, // 第三次 = 命中（未再回源）
    ]);
  });

  it('批量上界：50 个全放行（逐条回源、序不变）；51 个 ⇒ 10001', async () => {
    const ids50 = Array.from({ length: 50 }, (_, i) => `u-${String(i).padStart(2, '0')}`);
    for (const id of ids50) db.seedAccount(id, 'user', 1);

    const res = expectOk(await service.get({ ownerIds: ids50 }));
    expect(res.balances.map((b) => b.ownerId)).toEqual(ids50);
    expect(res.balances.every((b) => b.balance === 1 && b.exists)).toBe(true);
    expect(db.directQueries).toHaveLength(50);

    const ids51 = Array.from({ length: 51 }, (_, i) => `u-${i}`);
    const msg = expectReject(await service.get({ ownerIds: ids51 }), ErrCode.BAD_PARAM);
    expect(msg).toContain('1..50');
  });

  it('校验矩阵（空数组 / 缺字段 / 非法字符）⇒ 10001 中文原因，**不触** Redis 与库', async () => {
    expectReject(await service.get({ ownerIds: [] }), ErrCode.BAD_PARAM);
    expectReject(await service.get({}), ErrCode.BAD_PARAM);
    expectReject(await service.get({ ownerIds: ['bad id!'] }), ErrCode.BAD_PARAM);
    expectReject(await service.get({ ownerIds: [42] }), ErrCode.BAD_PARAM);

    expect(redis.calls).toEqual([]);
    expect(db.directQueries).toEqual([]);
    expect(warnSpy).toHaveBeenCalled(); // 拒绝有观测（与 apply 的校验拒绝同形）
  });

  it('缓存值损坏（非十进制整数串）⇒ 视同 miss：回源并以库值覆盖写回', async () => {
    redis.store.set(KEY('u-1'), 'not-a-number');
    db.seedAccount('u-1', 'user', 42);

    const res = expectOk(await service.get({ ownerIds: ['u-1'] }));

    expect(res.balances[0]).toEqual({ ownerId: 'u-1', balance: 42, exists: true });
    expect(redis.store.get(KEY('u-1'))).toBe('42');
  });

  it("宽松解析的三种「看似可解析」形态（'1e3' / '0x10' / ''）同样视同 miss（解析收紧为 /^-?\\d+$/ —— T4 审查 🟢-1）", async () => {
    // 判据：`Number` 会把三者分别读成 1000 / 16 / 0 —— 若解析没收紧，它们会**冒充命中**
    // （返回错误余额且不回源）。收紧后一律 null ⇒ 回源 + 覆盖写回，与库值一致。
    db.seedAccount('u-1', 'user', 42);
    for (const corrupt of ['1e3', '0x10', '']) {
      redis.store.set(KEY('u-1'), corrupt);
      const res = expectOk(await service.get({ ownerIds: ['u-1'] }));
      expect(res.balances[0], `形态 ${JSON.stringify(corrupt)} 必须视同 miss`).toEqual({
        ownerId: 'u-1',
        balance: 42,
        exists: true,
      });
      expect(redis.store.get(KEY('u-1'))).toBe('42'); // 回源后覆盖写回
    }
    expect(db.directQueries).toHaveLength(3); // 每一形态各回源一次（没有被当命中）
  });

  it('Redis 故障（读穿失败）⇒ 降级回源 MySQL：结果不变 + warn（写穿失败同样只降级不改变结果）', async () => {
    redis.failKeys.add(KEY('u-1')); // get 与 set 都失败（模拟 Redis 挂）
    db.seedAccount('u-1', 'user', 250);

    const res = expectOk(await service.get({ ownerIds: ['u-1'] }));

    expect(res.balances).toEqual([{ ownerId: 'u-1', balance: 250, exists: true }]);
    expect(db.directQueries).toHaveLength(1); // 降级 = 回源
    expect(warnSpy).toHaveBeenCalled();
  });
});
