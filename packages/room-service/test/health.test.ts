/**
 * §2.4 / R267：`room-service` 的就绪面（`/api/health`，`checks` **恰好** `{redis}`）与
 * 存活面（`/api/health/live`，恒 200、不查依赖）。
 *
 * ⚠️ 健康检查复用**已有的** `RedisProviderModule`（`createRedis()`）—— **不得**新建连接。
 * `vi.mock('ioredis')` 的替身必须**同时**导出 `default` 与 `Redis`（生产代码两种写法都有），
 * 且工厂里不能引用文件内的顶层变量（会被提升）。
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import { RedisProviderModule, createRedis } from '../src/redis.provider.module';
import { createFakeRedis } from './helpers/fake-redis';

/** 容器/工厂造出来的那个连接（`vi.hoisted` 保证工厂能安全闭包引用）。 */
const { conn } = vi.hoisted(() => {
  const make = () => ({
    ping: vi.fn(async () => 'PONG'),
    on: vi.fn(),
    quit: vi.fn(async () => undefined),
  });
  return { conn: make() };
});

vi.mock('ioredis', () => {
  const ctor = vi.fn(() => conn);
  return { default: ctor, Redis: ctor };
});

const bodyOf = (value: unknown) =>
  value as { status: string; service: string; checks?: Record<string, string> };

describe('§2.4 健康检查（R267）— room-service', () => {
  let redis: ReturnType<typeof createFakeRedis>;

  beforeEach(() => {
    redis = createFakeRedis();
  });

  it('就绪：Redis 正常 ⇒ status=ok + checks 恰好 {redis:up}；HTTP 200', async () => {
    const health = new HealthService(redis as unknown as Redis);
    const codes: number[] = [];

    const body = bodyOf(
      await new HealthController(health).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({ status: 'ok', service: 'room-service', checks: { redis: 'up' } });
    expect(Object.keys(body.checks!)).toEqual(['redis']);
    expect(codes).toEqual([200]);
    // 判别力：`up` 必须来自**真的探测**（`ping` 被调用），不是常量
    expect(redis.ping).toHaveBeenCalled();
  });

  it('就绪：Redis 不可用 ⇒ status=degraded + checks.redis=down；**控制器设 503**', async () => {
    redis.ping.mockRejectedValueOnce(new Error('Connection is closed.'));
    const health = new HealthService(redis as unknown as Redis);
    const codes: number[] = [];

    const body = bodyOf(
      await new HealthController(health).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({
      status: 'degraded',
      service: 'room-service',
      checks: { redis: 'down' },
    });
    expect(codes).toEqual([503]);
  });

  it('就绪：探测失败**不得**让健康检查自己抛（那会变成 500 而不是 503）', async () => {
    redis.ping.mockRejectedValueOnce(new Error('boom'));
    const health = new HealthService(redis as unknown as Redis);
    await expect(health.check()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('存活：**不查依赖**、只报 status+service，Redis 被打断也不影响它', async () => {
    redis.ping.mockRejectedValue(new Error('Connection is closed.'));
    const health = new HealthService(redis as unknown as Redis);

    // 判别力（R115）：先在本用例内证明这个探针**能观测到「发生」**，再断言 `live()` 没碰它
    await health.check();
    const after = redis.ping.mock.calls.length;
    expect(after).toBeGreaterThan(0);

    const body = bodyOf(health.live());

    expect(body).toEqual({ status: 'ok', service: 'room-service' });
    expect('checks' in body).toBe(false);
    expect(redis.ping.mock.calls.length).toBe(after);
  });

  it('连接工厂：`createRedis()` 真的返回一个连接对象（provider 与 health 共用它）', () => {
    const created = createRedis();
    expect(typeof (created as Redis).ping).toBe('function');
    expect(typeof (created as Redis).on).toBe('function');
    // 反向判据：工厂确实走了 `new Redis()`（mock 的构造器返回 `conn`）
    expect(created).toBe(conn);
  });

  it('容器门禁：`HealthService` 能从真容器里被解析出来，且注入的 Redis 就是那个连接（R216/R217 同族）', async () => {
    const mod = await Test.createTestingModule({
      imports: [RedisProviderModule],
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();

    expect(mod.get(HealthController)).toBeInstanceOf(HealthController);
    // 反向判据：注入 `undefined`（R217 的 `this.redis === undefined`）时这条必须红
    await expect(mod.get(HealthService).check()).resolves.toEqual({
      status: 'ok',
      service: 'room-service',
      checks: { redis: 'up' },
    });

    await mod.close();
  });
});
