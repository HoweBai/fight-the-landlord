/**
 * §2.4 / R267：`api-gateway` 的就绪面（`/api/health`，含 `checks`，可 503）与
 * 存活面（`/api/health/live`，恒 200、不查依赖）。
 *
 * ⚠️ 本文件**不再**手工补 `design:paramtypes`（P18/N41）：测试环境已通过
 * `vitest.config.ts` 的插件 + `setupFiles: ['reflect-metadata']` 真的发出该元数据，
 * 因此下面那条容器门禁测的是**产品真实发出的**元数据，而不是测试写下的期望。
 *
 * ⚠️ 本文件**不连真实 Redis**：gateway 的 `REDIS` provider 在 `vi.mock('ioredis')`
 * 之下拿到的是内存替身，`ping()` 的成败由用例控制。
 */
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import { RedisProviderModule } from '../src/redis.provider.module';
import {
  healthRedisInstance,
  healthRedisInstanceAsRedis,
  resetHealthRedisDouble,
  setAlive,
} from './helpers/health-redis-double';

/** `vi.mock` 的工厂被提升 ⇒ 替身必须由工厂内部的 `await import()` 取得。 */
vi.mock('ioredis', async () => {
  const { healthRedisMockModule } = await import('./helpers/health-redis-double');
  return healthRedisMockModule();
});

const bodyOf = (value: unknown) =>
  value as { status: string; service: string; checks?: Record<string, string> };

describe('§2.4 健康检查（R267）— api-gateway', () => {
  beforeEach(() => {
    resetHealthRedisDouble();
  });

  it('就绪：Redis 正常 ⇒ status=ok + checks 恰好 {redis:up}；HTTP 200', async () => {
    const health = new HealthService(healthRedisInstanceAsRedis());
    const codes: number[] = [];

    const body = bodyOf(await health.check());
    const fromController = bodyOf(
      await new HealthController(health).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({ status: 'ok', service: 'api-gateway', checks: { redis: 'up' } });
    expect(Object.keys(body.checks!)).toEqual(['redis']);
    expect(fromController).toEqual(body);
    expect(codes).toEqual([200]);
    // 判别力：`up` 必须来自**真的探测**
    expect(healthRedisInstance().ping).toHaveBeenCalledTimes(2);
  });

  it('就绪：Redis 不可用 ⇒ status=degraded + checks.redis=down；**控制器设 503**', async () => {
    setAlive(false);
    const health = new HealthService(healthRedisInstanceAsRedis());
    const codes: number[] = [];

    const body = bodyOf(await new HealthController(health).check({ status: (c) => void codes.push(c) }));

    expect(body).toEqual({
      status: 'degraded',
      service: 'api-gateway',
      checks: { redis: 'down' },
    });
    expect(codes).toEqual([503]);
  });

  it('就绪：探测失败**不得**让健康检查自己抛（那会变成 500 而不是 503）', async () => {
    setAlive(false);
    const health = new HealthService(healthRedisInstanceAsRedis());
    await expect(health.check()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('存活：**不查依赖**、只报 status+service，Redis 被打断也不影响它', async () => {
    setAlive(false);
    const health = new HealthService(healthRedisInstanceAsRedis());

    // 判别力（R115）：先在本用例内证明这个探针**能观测到「发生」**（真的探测一次），
    // 再断言 `live()` **没有**再碰它 —— 只有前半句在同一个用例里，这条才不是空测。
    await health.check();
    const before = healthRedisInstance().ping.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    const body = bodyOf(health.live());

    expect(body).toEqual({ status: 'ok', service: 'api-gateway' });
    expect('checks' in body).toBe(false);
    expect(healthRedisInstance().ping.mock.calls.length).toBe(before);
  });

  it('容器门禁：gateway 的 health 装配真的能从容器里解析出来（R216/R217 同族）', async () => {
    // P18/N41：`design:paramtypes` 现由测试环境**真的**发出（`vitest.config.ts` 的
    // `scripts/vitest-plugins/emit-decorator-metadata.ts` + `setupFiles: ['reflect-metadata']`）
    // ⇒ 这里不再手写垫片：本用例现在测的是**产品真实发出的**元数据。
    const mod = await Test.createTestingModule({
      imports: [RedisProviderModule],
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();

    const controller = mod.get(HealthController);
    expect(controller).toBeInstanceOf(HealthController);
    // 端到端：容器装配的控制器在「Redis 正常」下真的报 `ok`
    await expect(controller.check({ status: () => {} })).resolves.toEqual({
      status: 'ok',
      service: 'api-gateway',
      checks: { redis: 'up' },
    });

    await mod.close();
  });
});
