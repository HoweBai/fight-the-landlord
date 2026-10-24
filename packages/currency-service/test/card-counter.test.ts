/**
 * 记牌器收费片 T7：购买/状态服务与控制器（规格 §2.4c/d；C8–C16 的单测半边）。
 *
 * 夹具 = 共享 `FakeCurrencyDb`（已扩展 purchases/entitlements 的精确 SQL 形状）+
 * 真 `ApplyService`（同一事务内核）+ 假 `ConfigCacheService`（hasSnapshot/开关/价格）。
 * 真库/并发判据由 conformance slice-28 承载；本文件只钉控制流与契约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { ErrCode } from '@fight-the-landlord/protocol';
import { ApplyService } from '../src/apply/apply.service';
import { CardCounterService } from '../src/card-counter/card-counter.service';
import { CardCounterController } from '../src/card-counter/card-counter.controller';
import type { ConfigCacheService } from '../src/config/config-cache.service';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

const USER = 'u-cc-1';

function makeConfig(
  over: Partial<{ hasSnapshot: boolean; enabled: boolean; perGame: number; perHour: number }> = {},
): ConfigCacheService {
  return {
    hasSnapshot: () => over.hasSnapshot ?? true,
    cardCounterEnabled: () => over.enabled ?? true,
    cardCounterPrices: () => ({ perGame: over.perGame ?? 10, perHour: over.perHour ?? 100 }),
  } as unknown as ConfigCacheService;
}

function makeService(
  db: FakeCurrencyDb,
  config: ConfigCacheService,
): CardCounterService {
  const redis = new FakeRedis([]);
  const apply = new ApplyService(
    db.dataSource as unknown as DataSource,
    redis as unknown as Redis,
  );
  return new CardCounterService(apply, db.dataSource as unknown as DataSource, config);
}

describe('CardCounterService.buy（购买）', () => {
  let db: FakeCurrencyDb;
  let service: CardCounterService;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new FakeCurrencyDb([]);
    db.seedAccount(USER, 'user', 100);
    service = makeService(db, makeConfig());
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('单局卡：扣 10、credits+1、purchases 行逐字段；返回 credits/priceCharged/balanceAfter', async () => {
    const res = await service.buy(USER, {
      kind: 'game',
      requestId: 'req-game-1',
      expectedPrice: 10,
    });

    expect(res.credits).toBe(1);
    expect(res.passExpiresAt).toBeNull();
    expect(res.priceCharged).toBe(10);
    expect(res.balanceAfter).toBe(90);

    expect(db.ops).toHaveLength(1);
    expect(db.ops[0]).toMatchObject({
      actionId: `cardcounter:${USER}:req-game-1`,
      source: 'card_counter',
      refId: USER,
      reason: 'cardcounter:game',
    });
    expect(db.flows).toHaveLength(1);
    expect(db.flows[0]).toMatchObject({ ownerId: USER, delta: -10, balanceAfter: 90 });
    expect(db.purchases).toHaveLength(1);
    expect(db.purchases[0]).toMatchObject({
      actionId: `cardcounter:${USER}:req-game-1`,
      ownerId: USER,
      kind: 'game',
      hours: null,
      credits: 1,
      price: 10,
    });
    expect(db.entitlements.get(USER)).toMatchObject({ credits: 1, passExpiresAt: null });
  });

  it('包时卡（余额充足）：hours=2 ⇒ 扣 200、到期 ≈ now+2h', async () => {
    db.seedAccount(USER, 'user', 500);
    const before = Date.now();
    const res = await service.buy(USER, {
      kind: 'hour',
      hours: 2,
      requestId: 'req-hour-2',
      expectedPrice: 200,
    });
    const after = Date.now();

    expect(res.credits).toBe(0);
    expect(res.priceCharged).toBe(200);
    expect(res.balanceAfter).toBe(300);
    expect(res.passExpiresAt).toBeGreaterThanOrEqual(before + 2 * 3_600_000);
    expect(res.passExpiresAt).toBeLessThanOrEqual(after + 2 * 3_600_000);
    expect(db.ops[0]).toMatchObject({
      actionId: `cardcounter:${USER}:req-hour-2`,
      reason: 'cardcounter:hour:2',
    });
    expect(db.purchases[0]).toMatchObject({ kind: 'hour', hours: 2, credits: null, price: 200 });
  });

  it('重放：同 requestId 同商品 ⇒ 不重复扣/发，返回行内历史价与当前权益', async () => {
    const first = await service.buy(USER, {
      kind: 'game',
      requestId: 'req-replay',
      expectedPrice: 10,
    });
    const second = await service.buy(USER, {
      kind: 'game',
      requestId: 'req-replay',
      expectedPrice: 10,
    });

    expect(second).toEqual(first);
    expect(db.ops).toHaveLength(1);
    expect(db.flows).toHaveLength(1);
    expect(db.purchases).toHaveLength(1);
    expect(db.entitlements.get(USER)?.credits).toBe(1);
  });

  it('重放：同 requestId 同载荷 ⇒ 不重复扣/发、返回原结果', async () => {
    const first = await service.buy(USER, {
      kind: 'game',
      requestId: 'req-price-change',
      expectedPrice: 10,
    });
    // 用同一 requestId、同一载荷（价格已变也不影响幂等锚）
    const second = await service.buy(USER, {
      kind: 'game',
      requestId: 'req-price-change',
      expectedPrice: 10,
    });
    expect(second).toEqual(first);
    expect(db.ops).toHaveLength(1);
    expect(db.flows).toHaveLength(1);
  });

  it('**改价/关开关后**同 requestId 仍重放成功（effect 不评估当前态；B1 判别力）', async () => {
    let enabled = true;
    let perGame = 10;
    const mutable = {
      hasSnapshot: () => true,
      cardCounterEnabled: () => enabled,
      cardCounterPrices: () => ({ perGame, perHour: 100 }),
    } as unknown as ConfigCacheService;
    const svc = makeService(db, mutable);
    const req = { kind: 'game' as const, requestId: 'req-real-price-change', expectedPrice: 10 };

    const first = await svc.buy(USER, req);
    // 当前态变了：关开关 + 改价（若实现把校验放在 apply 之前/在重放路径重跑，这里会 14008/14009）
    enabled = false;
    perGame = 20;
    const second = await svc.buy(USER, req);

    expect(second).toEqual(first);
    expect(db.ops).toHaveLength(1);
    expect(db.flows).toHaveLength(1);
    expect(db.purchases).toHaveLength(1);
    expect(db.entitlements.get(USER)?.credits).toBe(1);
  });

  it('同 requestId 异 kind/hours ⇒ 14010，不重复扣', async () => {
    await service.buy(USER, { kind: 'game', requestId: 'req-conflict', expectedPrice: 10 });
    await expect(
      service.buy(USER, { kind: 'hour', hours: 1, requestId: 'req-conflict', expectedPrice: 100 }),
    ).rejects.toMatchObject({ code: ErrCode.E_CARD_COUNTER_REQUEST_CONFLICT });
    expect(db.ops).toHaveLength(1);
    expect(db.purchases).toHaveLength(1);
  });

  it('14001 金币不足 ⇒ 无权益、钱不动', async () => {
    db.seedAccount(USER, 'user', 5);
    await expect(
      service.buy(USER, { kind: 'game', requestId: 'req-poor', expectedPrice: 10 }),
    ).rejects.toMatchObject({ code: ErrCode.E_INSUFFICIENT_FUNDS });
    expect(db.ops).toHaveLength(0);
    expect(db.purchases).toHaveLength(0);
    expect(db.entitlements.size).toBe(0);
    expect(db.accounts.get(USER)?.balance).toBe(5);
  });

  it('未开放/价 0 ⇒ 14008；expectedPrice 不符 ⇒ 14009；均零扣款零权益', async () => {
    const closed = makeService(db, makeConfig({ enabled: false }));
    await expect(
      closed.buy(USER, { kind: 'game', requestId: 'req-closed', expectedPrice: 10 }),
    ).rejects.toMatchObject({ code: ErrCode.E_CARD_COUNTER_UNAVAILABLE });

    const free = makeService(db, makeConfig({ perGame: 0, perHour: 0 }));
    await expect(
      free.buy(USER, { kind: 'game', requestId: 'req-free', expectedPrice: 10 }),
    ).rejects.toMatchObject({ code: ErrCode.E_CARD_COUNTER_UNAVAILABLE });

    await expect(
      service.buy(USER, { kind: 'game', requestId: 'req-price', expectedPrice: 11 }),
    ).rejects.toMatchObject({ code: ErrCode.E_CARD_COUNTER_PRICE_CHANGED });

    expect(db.ops).toHaveLength(0);
    expect(db.purchases).toHaveLength(0);
    expect(db.accounts.get(USER)?.balance).toBe(100);
  });

  it('无快照 ⇒ 10007（不收费）', async () => {
    const noSnapshot = makeService(db, makeConfig({ hasSnapshot: false }));
    await expect(
      noSnapshot.buy(USER, { kind: 'game', requestId: 'req-nosnap', expectedPrice: 10 }),
    ).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });
    expect(db.ops).toHaveLength(0);
    expect(db.accounts.get(USER)?.balance).toBe(100);
  });

  it('请求形状：kind/hours/requestId/expectedPrice 反例 ⇒ 10001、零库操作', async () => {
    const bad: Array<[string, unknown]> = [
      ['非对象', null],
      ['kind 非法', { kind: 'week', requestId: 'r', expectedPrice: 10 }],
      ['game 带 hours', { kind: 'game', hours: 1, requestId: 'r', expectedPrice: 10 }],
      ['hour 缺 hours', { kind: 'hour', requestId: 'r', expectedPrice: 100 }],
      ['hour=0', { kind: 'hour', hours: 0, requestId: 'r', expectedPrice: 100 }],
      ['hour=9', { kind: 'hour', hours: 9, requestId: 'r', expectedPrice: 100 }],
      ['requestId 空', { kind: 'game', requestId: '', expectedPrice: 10 }],
      ['requestId 非法字符', { kind: 'game', requestId: 'a b', expectedPrice: 10 }],
      ['expectedPrice=0', { kind: 'game', requestId: 'r', expectedPrice: 0 }],
      ['expectedPrice 小数', { kind: 'game', requestId: 'r', expectedPrice: 1.5 }],
      ['expectedPrice 越界', { kind: 'game', requestId: 'r', expectedPrice: 1_000_001 }],
    ];
    for (const [name, body] of bad) {
      await expect(service.buy(USER, body as never), name).rejects.toMatchObject({
        code: ErrCode.BAD_PARAM,
      });
    }
    expect(db.ops).toHaveLength(0);
    expect(db.purchases).toHaveLength(0);
  });
});

describe('CardCounterService.status（状态）', () => {
  it('无行 ⇒ 0/null 且零 INSERT；有行 ⇒ credits/epoch ms', async () => {
    const db = new FakeCurrencyDb([]);
    const service = makeService(db, makeConfig());

    expect(await service.status(USER)).toEqual({ credits: 0, passExpiresAt: null });
    expect(db.entitlements.size).toBe(0);

    db.entitlements.set(USER, { ownerId: USER, credits: 2, passExpiresAt: Date.now() + 60_000 });
    const status = await service.status(USER);
    expect(status.credits).toBe(2);
    expect(typeof status.passExpiresAt).toBe('number');
    expect(status.passExpiresAt).toBeGreaterThan(Date.now());
  });
});

describe('CardCounterController（鉴权面）', () => {
  const service = {
    status: vi.fn(),
    buy: vi.fn(),
  } as unknown as CardCounterService;
  const controller = new CardCounterController(service);

  it('两条端点：缺/空 X-User-Id ⇒ 10002/401', async () => {
    for (const missing of [undefined, '']) {
      const statusErr = await controller.status(missing).then(
        () => null,
        (err: unknown) => err,
      );
      expect(statusErr).toBeInstanceOf(HttpException);
      expect((statusErr as HttpException).getStatus()).toBe(401);
      expect((statusErr as HttpException).getResponse()).toMatchObject({
        code: ErrCode.UNAUTHENTICATED,
      });

      const purchaseErr = await controller.purchase(missing, {}).then(
        () => null,
        (err: unknown) => err,
      );
      expect(purchaseErr).toBeInstanceOf(HttpException);
      expect((purchaseErr as HttpException).getStatus()).toBe(401);
    }
  });
});
