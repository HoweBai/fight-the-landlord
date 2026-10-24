/**
 * `CurrencyRpcController` 的行为面 —— 货币片 T4（规格 §2.3 响应段 / §2.4 / 计划 T4 Step 3）。
 *
 * ─── 判据（三条，与 `config.rpc.test.ts` 同族）──────────────────────────
 *  ① 两条 pattern 名**逐字**来自 `RPC_PATTERNS`（不是手写字面量 —— R70：pattern 写错时
 *     替身不会失败，只有真拓扑才拒）；
 *  ② `currency.apply` 是 T3 内核信封的**直透**（含业务拒绝 14002 与重放 `replayed:true`
 *     —— 控制器不改写任何字段）；`currency.get` 直通 `GetService`（同序一一对应）；
 *  ③ 🔴 系统级故障 ⇒ `{ok:false,code:10007}` 信封、**不抛**（Nest 的 `RpcException` 到客户端
 *     只剩字符串 message，5 位数字码会丢 —— R220 存在的理由）。
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyRequest,
  type CurrencyGetResponse,
} from '@fight-the-landlord/protocol';
import type { CurrencyEntryFeeSkipRequest } from '@fight-the-landlord/protocol';
import { ApplyService } from '../src/apply/apply.service';
import { GetService } from '../src/apply/get.service';
import { CurrencyRpcController } from '../src/rpc/currency.rpc.controller';
import { EntryFeeSkipService } from '../src/skip/entry-fee-skip.service';
import { CardCounterConsumeService } from '../src/card-counter/consume.service';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

/** Nest 内部的 pattern 元数据键（`@nestjs/microservices/constants` 的 `PATTERN_METADATA`）。 */
const PATTERN_METADATA = 'microservices:pattern';

describe('CurrencyRpcController（货币片 T4：apply 直透 / get 直通 / 系统错映射 10007）', () => {
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let ctrl: CurrencyRpcController;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new FakeCurrencyDb();
    redis = new FakeRedis();
    const apply = new ApplyService(db.dataSource as unknown as DataSource, redis as unknown as Redis);
    const get = new GetService(db.dataSource as unknown as DataSource, redis as unknown as Redis);
    ctrl = new CurrencyRpcController(
      apply,
      get,
      new EntryFeeSkipService(db.dataSource as unknown as DataSource),
      new CardCounterConsumeService(db.dataSource as unknown as DataSource),
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

  const mkApplyDto = (): CurrencyApplyRequest => ({
    actionId: 'admin:t4-1',
    source: 'admin_adjust',
    actor: 'admin',
    reason: 'T4 单测',
    entries: [{ ownerId: 'u-1', delta: 100 }],
  });

  it('① 两条 pattern 名逐字来自 RPC_PATTERNS（不是手写字面量）', () => {
    const applyPatterns = Reflect.getMetadata(
      PATTERN_METADATA,
      CurrencyRpcController.prototype.apply,
    ) as string[] | undefined;
    const getPatterns = Reflect.getMetadata(
      PATTERN_METADATA,
      CurrencyRpcController.prototype.get,
    ) as string[] | undefined;

    // 正对照（R115）：元数据真的读到了，否则下面两条是空测
    expect(applyPatterns, '`microservices:pattern` 没读到 —— 元数据键写错或 Nest 升版变了').toBeDefined();
    expect(getPatterns).toBeDefined();
    expect(applyPatterns).toEqual([RPC_PATTERNS.currencyApply]);
    expect(getPatterns).toEqual([RPC_PATTERNS.currencyGet]);
    expect(RPC_PATTERNS.currencyApply).toBe('currency.apply');
    expect(RPC_PATTERNS.currencyGet).toBe('currency.get');

    const skipPatterns = Reflect.getMetadata(
      PATTERN_METADATA,
      CurrencyRpcController.prototype.entryFeeSkip,
    ) as string[] | undefined;
    expect(skipPatterns).toBeDefined();
    expect(skipPatterns).toEqual([RPC_PATTERNS.currencyEntryFeeSkip]);
    expect(RPC_PATTERNS.currencyEntryFeeSkip).toBe('currency.entryFeeSkip');

    const consumePatterns = Reflect.getMetadata(
      PATTERN_METADATA,
      CurrencyRpcController.prototype.cardCounterConsume,
    ) as string[] | undefined;
    expect(consumePatterns).toBeDefined();
    expect(consumePatterns).toEqual([RPC_PATTERNS.currencyCardCounterConsume]);
    expect(RPC_PATTERNS.currencyCardCounterConsume).toBe('currency.cardCounterConsume');
  });

  it('② currency.apply 直透 T3 信封：同 actionId 重放 ⇒ replayed:true 与首发同 opId/同 balanceAfter（未重复入账）', async () => {
    const dto = mkApplyDto();

    const first = await ctrl.apply(dto);
    expect(first).toEqual({
      ok: true,
      data: { opId: 1, actionId: 'admin:t4-1', entries: [{ ownerId: 'u-1', balanceAfter: 100 }], replayed: false },
    });

    const second = await ctrl.apply(dto); // 同 id 同载荷 ⇒ 重放路径（信封**直透**，replayed 不被吞）
    expect(second).toEqual({
      ok: true,
      data: { opId: 1, actionId: 'admin:t4-1', entries: [{ ownerId: 'u-1', balanceAfter: 100 }], replayed: true },
    });
    expect(db.accounts.get('u-1')).toEqual({ ownerType: 'user', balance: 100 }); // 只入账一次
  });

  it('③ currency.apply 业务拒绝直透信封（同 id 异载荷 ⇒ 14002，不抛）', async () => {
    await ctrl.apply(mkApplyDto());

    const res = await ctrl.apply({ ...mkApplyDto(), entries: [{ ownerId: 'u-1', delta: 999 }] });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.code).toBe(ErrCode.E_ACTION_CONFLICT);
    expect(res.message.length).toBeGreaterThan(0);
  });

  it('④ currency.apply 系统级故障 ⇒ `{ok:false,10007}` 信封、**不抛**（码要跨过 RPC 边界）', async () => {
    const doomed = {
      apply: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as ApplyService;
    const ctrl2 = new CurrencyRpcController(
      doomed,
      {} as GetService,
      {} as EntryFeeSkipService,
      {} as CardCounterConsumeService,
    );

    await expect(ctrl2.apply(mkApplyDto())).resolves.toEqual({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: 'db down',
    });
    expect(errorSpy).toHaveBeenCalled(); // 响亮不静默
  });

  it('⑤ currency.get 直通 GetService：同序一一对应（含重复位与 exists:false ⇒ 0）', async () => {
    db.seedAccount('u-a', 'user', 10);

    const res = (await ctrl.get({ ownerIds: ['u-b', 'u-a', 'u-b'] })) as CurrencyGetResponse;

    expect(res).toEqual({
      ok: true,
      data: {
        balances: [
          { ownerId: 'u-b', balance: 0, exists: false },
          { ownerId: 'u-a', balance: 10, exists: true },
          { ownerId: 'u-b', balance: 0, exists: false }, // 与请求同序一一对应，重复位逐位回答
        ],
      },
    });
  });

  it('⑥ currency.get：校验失败 ⇒ 10001 信封（不触 IO）；系统级故障 ⇒ 10007 信封、不抛', async () => {
    const rejected = await ctrl.get({ ownerIds: [] });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('unreachable');
    expect(rejected.code).toBe(ErrCode.BAD_PARAM);
    expect(db.directQueries).toEqual([]);

    const doomed = {
      get: vi.fn(async () => {
        throw new Error('mysql down');
      }),
    } as unknown as GetService;
    const ctrl2 = new CurrencyRpcController(
      {} as ApplyService,
      doomed,
      {} as EntryFeeSkipService,
      {} as CardCounterConsumeService,
    );

    await expect(ctrl2.get({ ownerIds: ['u-1'] })).resolves.toEqual({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: 'mysql down',
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('⑦ currency.entryFeeSkip：直透 EntryFeeSkipService（inserted 两态）；系统级故障 ⇒ 10007 信封、不抛', async () => {
    const skipReq: CurrencyEntryFeeSkipRequest = {
      roomCode: 'ABC123',
      ownerId: 'u-1',
      seat: 0,
      baseScore: 15,
      feeAmount: 1,
      reason: 'insufficient_funds',
    };

    const first = await ctrl.entryFeeSkip(skipReq);
    expect(first).toEqual({ ok: true, data: { inserted: true } });

    const second = await ctrl.entryFeeSkip(skipReq); // 同房同人二投 ⇒ INSERT IGNORE 0 行
    expect(second).toEqual({ ok: true, data: { inserted: false } });

    const doomed = {
      record: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as EntryFeeSkipService;
    const ctrl2 = new CurrencyRpcController(
      {} as ApplyService,
      {} as GetService,
      doomed,
      {} as CardCounterConsumeService,
    );

    await expect(ctrl2.entryFeeSkip(skipReq)).resolves.toEqual({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: 'db down',
    });
    expect(errorSpy).toHaveBeenCalled(); // 响亮不静默
  });
});
