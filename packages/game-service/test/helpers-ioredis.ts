import { vi } from 'vitest';

/**
 * `ioredis` 的内存替身（单例）。
 *
 * 单测必须能在**无外部依赖**时通过（A.2 E10 的教训）。对局真源已改为
 * Redis（§10.2），因此这个替身要同时支持字符串存取与 pub/sub 记录。
 *
 * ⚠️ `vi.mock()` 的工厂会被提升到文件顶部，**不能引用文件内的顶层变量**；
 * 因此替身必须放在独立模块里、由工厂 `await import()` 取得。
 */
const store = new Map<string, string>();
const published: Array<[string, string]> = [];

export const redisDouble = {
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  publish: vi.fn(async (channel: string, payload: string) => {
    published.push([channel, payload]);
    return 1;
  }),
  quit: vi.fn(async () => undefined),
  on: vi.fn(),
  subscribe: vi.fn(async () => undefined),
  _store: store,
  _published: published,
};

export type RedisDouble = typeof redisDouble;

/** 每个用例之间清空内存状态。 */
export function resetRedisDouble(): void {
  store.clear();
  published.length = 0;
}

/**
 * 供 `vi.mock('ioredis', ...)` 直接复用的工厂。
 *
 * ⚠️ **必须同时导出 `default` 与 `Redis`**：R284 把连接提成 provider 之后，
 * `game.service.ts` 用 `@Inject(Redis)` 声明注入 token（源码里是
 * `import Redis, { Redis as RedisToken } from 'ioredis'`）—— 少了命名导出，
 * 模块图在**链接期**就炸（`No "Redis" export is defined on the "ioredis" mock`），
 * 而那是**整个文件级**的失败，不是单个用例。
 */
export function ioredisMockModule() {
  const ctor = vi.fn(() => redisDouble);
  return { default: ctor, Redis: ctor, __redis: redisDouble };
}
