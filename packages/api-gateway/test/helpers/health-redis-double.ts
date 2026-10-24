import { vi } from 'vitest';
import type { Redis } from 'ioredis';

/**
 * `api-gateway` 的 health 用例专用 Redis 替身。
 *
 * ⚠️ 为什么不在用例文件里直接写：`vi.mock('ioredis', …)` 的工厂会被**提升到文件顶部**，
 * 不能引用文件内的顶层变量 ⇒ 替身必须放在独立模块里、由工厂 `await import()` 取得
 * （与 `packages/game-service/test/helpers-ioredis.ts` 同一手法）。
 *
 * ⚠️ 为什么是**单例**：`api-gateway` 的 `REDIS` provider 是 `useFactory`
 * ⇒ 工厂每次调用都 `new Redis(...)`。共享同一实例让「provider 真的被调用过」变成可观测，
 * 也让「`live()` 没碰依赖」可以用 `ping` 的**调用次数**断言（R115：先证明探针能观测到
 * 「发生」，再断言「没发生」）。
 */
export type RedisDouble = {
  ping: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
};

const state = {
  /** 由用例控制：`false` ⇒ 模拟「Redis 不可用」（ping reject）。 */
  alive: true,
  /** provider 是否真的被构造过（`on('error')` 是它唯一的构造期副作用）。 */
  constructed: false,
};

let instance: RedisDouble = makeInstance();

function makeInstance(): RedisDouble {
  return {
    ping: vi.fn(async () => {
      if (!state.alive) throw new Error('Connection is closed.');
      return 'PONG';
    }),
    on: vi.fn(() => {
      state.constructed = true;
    }),
    quit: vi.fn(async () => undefined),
  };
}

/** 当前替身（provider 与用例共用**同一个**对象）。 */
export function healthRedisInstance(): RedisDouble {
  return instance;
}

export function setAlive(value: boolean): void {
  state.alive = value;
}

export function isConstructed(): boolean {
  return state.constructed;
}

/** 每个用例之间复位：清调用记录 + 恢复「连通」。 */
export function resetHealthRedisDouble(): void {
  state.alive = true;
  state.constructed = false;
  instance = makeInstance();
}

/** 交给 `vi.mock('ioredis', …)` 的工厂直接用。 */
export function healthRedisMockModule() {
  const ctor = vi.fn(() => instance);
  return { default: ctor, Redis: ctor };
}

/**
 * 交给 `new HealthService(...)` 用（`HealthService` 的构造参数是 `Redis`）。
 *
 * 替身故意只实现子集（`ping` / `on` / `quit` 三个，`Redis` 有 440+ 个成员），
 * 无法结构性满足 `Redis` 的类形状（TS2345 原文：`is missing the following properties
 * from type 'Redis': options, status, stream, isCluster, and 439 more`）。
 * 断言转换只收在**这一处**，与 `room-service/test/helpers/fake-redis.ts` 的
 * `asRedis()` 同一手法（那里同样是 `fake as unknown as Redis`）。
 */
export function healthRedisInstanceAsRedis(): Redis {
  return instance as unknown as Redis;
}
