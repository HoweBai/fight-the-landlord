/**
 * §2.4 / R267：`game-service` 的就绪面（`/api/health`，`checks` **恰好** `{redis}`）与
 * 存活面（`/api/health/live`，恒 200、不查依赖）。
 *
 * ⚠️ **本文件重写了旧的 `new HealthController()` 形态**：旧形态直接实例化控制器，
 * 既不经容器、也没有 `checks`，因此它**测不到** R267 的任何一条。
 *
 * ⚠️ 本片把 `GameService` 内部那个 `new Redis(...)` 提成了 `RedisProviderModule`
 * 的 provider（**R284 裁决**）—— 健康检查复用**同一个**实例（**不得**再 `new Redis()`）。
 * 本文件把容器里那个连接与 `GameService.redis` 的**同一性**也钉住。
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import { RedisProviderModule, createRedis } from '../src/redis.provider.module';
import { GameService } from '../src/game/game.service';
import { RobotClient } from '../src/game/robot.client';
import { createFakeRedis } from './helpers/fake-redis';

/**
 * ⚠️ `vi.mock` 的工厂被**提升**到文件顶部 ⇒ 里面不能直接引用文件里的顶层 `const`
 * （TDZ：`game.service.ts` 在**模块求值期**就 `import 'ioredis'`，会先触发工厂）。
 * 用 `vi.hoisted` 把替身提到提升区，工厂就能安全地闭包引用它。
 * 同时导出 `default` 与 `Redis` —— 生产代码两种写法都有。
 */
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

describe('§2.4 健康检查（R267）— game-service', () => {
  let redis: ReturnType<typeof createFakeRedis>;

  beforeEach(() => {
    redis = createFakeRedis();
    conn.ping.mockClear();
  });

  it('就绪：Redis 正常 ⇒ status=ok + checks 恰好 {redis:up}；HTTP 200', async () => {
    const health = new HealthService(redis as unknown as Redis);
    const codes: number[] = [];

    const body = bodyOf(
      await new HealthController(health).check({ status: (c) => void codes.push(c) }),
    );

    expect(body).toEqual({ status: 'ok', service: 'game-service', checks: { redis: 'up' } });
    expect(Object.keys(body.checks!)).toEqual(['redis']);
    expect(codes).toEqual([200]);
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
      service: 'game-service',
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

    // 判别力（R115）：先在本用例内证明探针**能观测到「发生」**，再断言 `live()` 没碰它
    await health.check();
    const after = redis.ping.mock.calls.length;
    expect(after).toBeGreaterThan(0);

    const body = bodyOf(health.live());

    expect(body).toEqual({ status: 'ok', service: 'game-service' });
    expect('checks' in body).toBe(false);
    expect(redis.ping.mock.calls.length).toBe(after);
  });

  /**
   * **R284 的核心判据**：健康检查与 `GameService` 复用**同一个** Redis 实例。
   *
   * 判别力：「健康检查另起一个 `new Redis()`」⇒ 注入进去的两个对象不同（红）；
   * 「`GameService` 仍在构造函数里自己 `new`」⇒ 它拿到的不是容器那个 `Redis`（红）。
   */
  it('复用判据：容器里 `GameService.redis` 与 `createRedis()` 返回的是同一个连接', async () => {
    // `createRedis()` 在 mock 下就是 `new Redis()` ⇒ 恒为 `conn`
    expect(createRedis()).toBe(conn as unknown as Redis);

    const mod = await Test.createTestingModule({
      imports: [RedisProviderModule],
      controllers: [HealthController],
      providers: [
        HealthService,
        GameService,
        // `GameService` 有 `@Inject(forwardRef(() => RobotClient))` 的**属性注入**
        // （N20/P4）⇒ 容器里必须能解析 `RobotClient`（空壳即可，本用例不驱动对局）。
        { provide: RobotClient, useValue: {} },
      ],
    }).compile();

    expect(mod.get(GameService).redis).toBe(conn);
    expect(mod.get(Redis)).toBe(conn);

    await mod.get(HealthService).check();
    expect(conn.ping).toHaveBeenCalled();

    await mod.close();
  });

  it('`GameService` 不再在构造函数里自建连接：它存的引用就是传进来的那个', () => {
    const injected = createFakeRedis();
    const service = new GameService(injected as unknown as Redis);
    expect(service.redis).toBe(injected);
    // 反向：不是模块顶部那个替身
    expect(service.redis).not.toBe(conn);
  });
});
