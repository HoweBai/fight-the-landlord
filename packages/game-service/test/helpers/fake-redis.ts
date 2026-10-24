import { vi } from 'vitest';

/**
 * 内存版 Redis（**只为 `game-service` 的 health 用例**）。
 *
 * 与 `helpers-ioredis.ts` 的区别：那一份是 `vi.mock('ioredis')` 的**单例**替身
 * （`GameService` 的既有用例大量依赖它），本文件则每次 `createFakeRedis()` 都造一个
 * **新实例** —— health 用例需要「注入的连接就是我断言的那个对象」这种**同一性**判据
 * （R284：健康检查与 `GameService` 复用同一个 Redis）。
 *
 * 只实现健康检查路径真正用到的方法：`ping()`（就绪探测）与 `on()`（provider 构造期注册）。
 * ⚠️ 老规矩（fake-redis 被咬过多次）：**写替身时先问「真实 Redis 在这里会怎样」** ——
 * 连通 ⇒ `'PONG'`；连接不可用 ⇒ **reject**（用例用 `mockRejectedValueOnce` 构造）。
 */
export function createFakeRedis() {
  return {
    ping: vi.fn(async (): Promise<string> => 'PONG'),
    on: vi.fn(),
    quit: vi.fn(async () => undefined),
  };
}

export type FakeRedis = ReturnType<typeof createFakeRedis>;
