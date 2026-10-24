/**
 * §2.4 / R267 / spec A11：`config-service` 的就绪面（`/api/health`，`checks` **恰好**
 * `{redis, mysql}`）与存活面（`/api/health/live`，恒 200、不查依赖）。
 *
 * ⚠️ R267 逐字：`checks` **只报自己真的依赖的** —— 本服务依赖 Redis（`config:changed` 广播）
 * 与 MySQL（`platform_config` 持久源）⇒ 报这两个；**不得**为没有的依赖报 `up`（那是假信息）。
 *
 * ⚠️ 健康检查复用**已有的**依赖：`RedisModule` 的 `REDIS` token + `@nestjs/typeorm` 的
 * `DataSource` —— **不得**新建连接。形态照 `user-service/test/health.test.ts`。
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import { REDIS } from '../src/redis/redis.module';

type RedisDouble = { ping: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };

/** 内存替身：`ping()` 的成败由用例控制（与 `room-service` 的 `createFakeRedis` 同族）。 */
function createRedisDouble(): RedisDouble {
  return { ping: vi.fn(async () => 'PONG'), on: vi.fn() };
}

/** `DataSource` 只需 `query` —— 健康检查打的是 `SELECT 1`。 */
function createDataSourceDouble() {
  return { query: vi.fn(async () => [{ '1': 1 }]) };
}

const bodyOf = (value: unknown) =>
  value as { status: string; service: string; checks?: Record<string, string> };

describe('§2.4 健康检查（R267）— config-service', () => {
  let redis: RedisDouble;
  let db: ReturnType<typeof createDataSourceDouble>;

  beforeEach(() => {
    redis = createRedisDouble();
    db = createDataSourceDouble();
  });

  const build = () => new HealthService(redis as unknown as Redis, db as unknown as DataSource);

  it('就绪：两个依赖都正常 ⇒ status=ok + checks **恰好** {redis,mysql}；HTTP 200', async () => {
    const codes: number[] = [];
    const body = bodyOf(
      await new HealthController(build()).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({
      status: 'ok',
      service: 'config-service',
      checks: { redis: 'up', mysql: 'up' },
    });
    expect(Object.keys(body.checks!).sort()).toEqual(['mysql', 'redis']);
    expect(codes).toEqual([200]);
    // 判别力：两个 `up` 都必须来自**真的探测**
    expect(redis.ping).toHaveBeenCalled();
    expect(db.query).toHaveBeenCalled();
  });

  it('就绪：Redis 挂了 ⇒ degraded + checks 恰好 {redis:down, mysql:up}；HTTP 503', async () => {
    redis.ping.mockRejectedValueOnce(new Error('Connection is closed.'));
    const codes: number[] = [];
    const body = bodyOf(
      await new HealthController(build()).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({
      status: 'degraded',
      service: 'config-service',
      checks: { redis: 'down', mysql: 'up' },
    });
    expect(codes).toEqual([503]);
  });

  it('就绪：MySQL 挂了 ⇒ degraded + checks 恰好 {redis:up, mysql:down}；HTTP 503', async () => {
    db.query.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const codes: number[] = [];
    const body = bodyOf(
      await new HealthController(build()).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({
      status: 'degraded',
      service: 'config-service',
      checks: { redis: 'up', mysql: 'down' },
    });
    expect(codes).toEqual([503]);
  });

  it('就绪：探测失败**不得**让健康检查自己抛（那会变成 500 而不是 503）', async () => {
    redis.ping.mockRejectedValueOnce(new Error('boom'));
    db.query.mockRejectedValueOnce(new Error('boom'));
    await expect(build().check()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('存活：**不查依赖**、只报 status+service，两个依赖都打断也不影响它', async () => {
    redis.ping.mockRejectedValue(new Error('Connection is closed.'));
    db.query.mockRejectedValue(new Error('ECONNREFUSED'));
    const health = build();

    // 判别力：先在本用例内证明两个探针**都能观测到「发生」**，再断言 `live()` 没碰它们
    await health.check();
    expect(redis.ping).toHaveBeenCalled();
    expect(db.query).toHaveBeenCalled();
    redis.ping.mockClear();
    db.query.mockClear();

    const body = bodyOf(health.live());

    expect(body).toEqual({ status: 'ok', service: 'config-service' });
    expect('checks' in body).toBe(false);
    expect(redis.ping).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('容器门禁：`HealthService` 从真容器解析，且注入的 `REDIS`/`DataSource` 就是那两个对象', async () => {
    // 用**新鲜**替身：跨用例复用同一组 `vi.fn()` 会被 `mockRejectedValueOnce` 的残余串味。
    const freshRedis = createRedisDouble();
    const freshDb = createDataSourceDouble();

    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: REDIS, useValue: freshRedis },
        { provide: DataSource, useValue: freshDb },
      ],
    }).compile();

    expect(mod.get(HealthController)).toBeInstanceOf(HealthController);
    // 反向判据：缺 `REDIS`/`DataSource` 任一个 provider，Nest 会解析失败 ⇒ 这条必红
    await expect(mod.get(HealthService).check()).resolves.toEqual({
      status: 'ok',
      service: 'config-service',
      checks: { redis: 'up', mysql: 'up' },
    });

    await mod.close();
  });
});
