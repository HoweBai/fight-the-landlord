/**
 * §2.4 / R267 / 货币片 C1：`currency-service` 的就绪面（`/api/health`）与存活面
 * （`/api/health/live`，恒 200、不查依赖）。
 *
 * ⚠️ R267 逐字：`checks` **只报自己真的依赖的** —— T3 接入余额缓存（`RedisModule`）后
 * 本服务的真依赖 = **Redis + MySQL** ⇒ 报 `{redis, mysql}`（T1 骨架期只报 `mysql` 的
 * 形态随 `redis.module.ts` 落地失效；用户/配置两服务是同形先例）。
 *
 * ⚠️ 健康检查复用**已有的**依赖（`REDIS` provider + `@nestjs/typeorm` 的 `DataSource`）
 * —— **不得**新建连接。形态照 `user-service/test/health.test.ts`。
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import { REDIS } from '../src/redis/redis.module';

/** `DataSource` 只需 `query` —— 健康检查打的是 `SELECT 1`。 */
function createDataSourceDouble() {
  return { query: vi.fn(async () => [{ '1': 1 }]) };
}

/** `REDIS` 只需 `ping` —— 健康检查打的是 `PING`。 */
function createRedisDouble() {
  return { ping: vi.fn(async () => 'PONG') };
}

const bodyOf = (value: unknown) =>
  value as { status: string; service: string; checks?: Record<string, string> };

describe('§2.4 健康检查（R267）— currency-service', () => {
  let db: ReturnType<typeof createDataSourceDouble>;
  let redis: ReturnType<typeof createRedisDouble>;

  beforeEach(() => {
    db = createDataSourceDouble();
    redis = createRedisDouble();
  });

  const build = () => new HealthService(redis as unknown as Redis, db as unknown as DataSource);

  it('就绪：依赖正常 ⇒ status=ok + checks **恰好** {redis, mysql}；HTTP 200', async () => {
    const codes: number[] = [];
    const body = bodyOf(
      await new HealthController(build()).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({
      status: 'ok',
      service: 'currency-service',
      checks: { redis: 'up', mysql: 'up' },
    });
    expect(Object.keys(body.checks!).sort()).toEqual(['mysql', 'redis']);
    expect(codes).toEqual([200]);
    // 判别力：两个 `up` 必须来自**真的探测**
    expect(db.query).toHaveBeenCalled();
    expect(redis.ping).toHaveBeenCalled();
  });

  it('就绪：MySQL 挂了 ⇒ degraded + checks {redis:up, mysql:down}；HTTP 503', async () => {
    db.query.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const codes: number[] = [];
    const body = bodyOf(
      await new HealthController(build()).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({
      status: 'degraded',
      service: 'currency-service',
      checks: { redis: 'up', mysql: 'down' },
    });
    expect(codes).toEqual([503]);
  });

  it('就绪：Redis 挂了 ⇒ degraded + checks {redis:down, mysql:up}；HTTP 503', async () => {
    redis.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const codes: number[] = [];
    const body = bodyOf(
      await new HealthController(build()).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({
      status: 'degraded',
      service: 'currency-service',
      checks: { redis: 'down', mysql: 'up' },
    });
    expect(codes).toEqual([503]);
  });

  it('就绪：探测失败**不得**让健康检查自己抛（那会变成 500 而不是 503）', async () => {
    db.query.mockRejectedValueOnce(new Error('boom'));
    redis.ping.mockRejectedValueOnce(new Error('boom'));
    await expect(build().check()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('存活：**不查依赖**、只报 status+service，依赖都打断也不影响它', async () => {
    db.query.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.ping.mockRejectedValue(new Error('ECONNREFUSED'));
    const health = build();

    // 判别力：先在本用例内证明探针**能观测到「发生」**，再断言 `live()` 没碰它们
    await health.check();
    expect(db.query).toHaveBeenCalled();
    expect(redis.ping).toHaveBeenCalled();
    db.query.mockClear();
    redis.ping.mockClear();

    const body = bodyOf(health.live());

    expect(body).toEqual({ status: 'ok', service: 'currency-service' });
    expect('checks' in body).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });

  it('容器门禁：`HealthService` 从真容器解析，且注入的 `DataSource`/`REDIS` 就是那两个对象（R216/R217 同族）', async () => {
    // 用**新鲜**替身：跨用例复用同一组 `vi.fn()` 会被 `mockRejectedValueOnce` 的残余串味。
    const freshDb = createDataSourceDouble();
    const freshRedis = createRedisDouble();

    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: DataSource, useValue: freshDb },
        { provide: REDIS, useValue: freshRedis },
      ],
    }).compile();

    expect(mod.get(HealthController)).toBeInstanceOf(HealthController);
    // 反向判据：缺任一 provider，Nest 会解析失败 ⇒ 这条必红
    await expect(mod.get(HealthService).check()).resolves.toEqual({
      status: 'ok',
      service: 'currency-service',
      checks: { redis: 'up', mysql: 'up' },
    });

    await mod.close();
  });
});
