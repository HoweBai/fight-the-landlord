/**
 * `ConfigCacheService`（api-gateway）的行为面 —— 客户端接入片 T4 创建：网关**第一条
 * RPC 出站边**（`config.snapshot`）之上的快照缓存 / 专用订阅 / 安全网骨架。
 *
 * 形态逐段克隆 payment-service 的同名测试（夹具 / 行为三件 / 失败两态 / 关停闸），差异面：
 *  ① 读面从「键级 getter 族」换成 `snapshotOrNull()`（**从未拉到 ⇒ null**）；
 *  ② 本文件是**任务书 Step 2 四条用例（①–④）**的落点：从未拉到+等待者 /
 *     last-good 不被一次失败放门 / 广播即刷 / 专用连接结构钉；
 *  ③ 追加三条（⑤–⑦）克隆骨架既有行为面的对应件：安全网 ≤60s（丢广播形态）与
 *     两枚测试 env 的「空串 = 未设」语义（写面判据在 T5/真栈，此处只钉机制）。
 *
 * ─── 夹具（照 payment 成例）────────────────────────────────────────────
 *  - **假 ConfigClient**：`{ snapshot: vi.fn() }`，用例可控成功/失败
 *    （失败桩**用真实的 `ConfigServiceError`** —— 真 client 的失败形状就是它）；
 *  - **假订阅连接**：`vi.mock('ioredis')` 把**构造器**换成 spy，并记录每个替身实例 ——
 *    「专用连接」判据要在**构造器**上断言（订阅连接是服务自己 `new Redis(...)` 建的；
 *    本文件从不向服务提供任何共享实例 ⇒ 「订阅发生在服务自建连接上」是测试面可达的形态）；
 *  - **假时钟**：vitest fake timers（退避 / 安全网判据全部由 `vi.advanceTimersByTimeAsync` 驱动）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ErrCode,
  type ConfigKey,
  type ConfigSnapshot,
  type ConfigSnapshotResponse,
} from '@fight-the-landlord/protocol';
import {
  CONFIG_CHANGED_CHANNEL,
  ConfigCacheService,
} from '../src/config/config-cache.service';
import {
  ConfigClient,
  ConfigServiceError,
  TRANSPORT_FAILURE_MESSAGE,
} from '../src/config/config.client';

/** `vi.mock` 的工厂是**提升**的 ⇒ 共享状态必须先经 `vi.hoisted` 建出来（照 vitest 官方形态）。 */
const redisState = vi.hoisted(() => ({
  /** 每一次 `new Redis(...)` 的替身实例（按创建顺序）。 */
  instances: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('ioredis', () => {
  const ctor = vi.fn(() => {
    const instance = {
      on: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
    };
    redisState.instances.push(instance);
    return instance;
  });
  // 生产代码两种写法都有（health.test.ts 的注记）—— 两个名字都指同一个 spy。
  return { default: ctor, Redis: ctor };
});

/** 假 ConfigClient（`snapshot` 是 `vi.fn`，用例可以 mockResolvedValue / mockRejectedValue）。 */
function makeClient(): { client: ConfigClient; snapshot: ReturnType<typeof vi.fn> } {
  const snapshot = vi.fn();
  return { client: { snapshot } as unknown as ConfigClient, snapshot };
}

/** 造一个 `ConfigSnapshotResponse`（只含传入的键）。 */
function snapshotWith(
  over: Partial<Record<ConfigKey, unknown>> = {},
  version = 1,
): ConfigSnapshotResponse {
  const config = {} as ConfigSnapshot;
  for (const [key, value] of Object.entries(over)) {
    (config as Record<string, { value: unknown; version: number }>)[key] = { value, version };
  }
  return { config, version };
}

/** 真 client 在传输失败时的失败形状（用例的失败桩一律用它）。 */
const transportDown = () =>
  new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);

/**
 * 取替身订阅连接上注册的 `message` 处理器 —— 它由「服务真的对新连接调 `.on('message', ...)`」
 * 产生（拿不到就说明订阅根本没挂上，用例当场红，而不是空转）。
 */
function messageHandlerOf(instance: {
  on: ReturnType<typeof vi.fn>;
}): ((channel: string, payload: string) => Promise<void>) | undefined {
  return instance.on.mock.calls.find(([event]) => event === 'message')?.[1] as
    | ((channel: string, payload: string) => Promise<void>)
    | undefined;
}

const ENV_KEYS = ['CONFIG_SYNC_SAFETY_NET_MS', 'CONFIG_SYNC_DISABLE_PUSH'] as const;

describe('ConfigCacheService（客户端接入片 T4：网关快照缓存）', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    redisState.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.useRealTimers();
  });

  it('① 从未拉到（冷启不可达）：snapshotOrNull() === null；注入成功拉取后 waitForFirstSnapshot 唤醒', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);

    // 🔴 不阻塞就绪：同步返回（若实现改成 await 首次拉取，这里当场红）。
    expect(cache.onModuleInit()).toBeUndefined();
    // 从未拉到 ⇒ null（**不是**空对象/默认对象 —— 「读不到」不得被伪装成「没有配置」）。
    expect(cache.snapshotOrNull()).toBeNull();
    // 等待者**注册在成功之前**（本用例的要害：成功拉取必须唤醒既有等待者）。
    const waiter = cache.waitForFirstSnapshot();

    // 1s 退避重试：首轮失败落定 ⇒ 仍为 null、退避已排。
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(cache.snapshotOrNull()).toBeNull();

    // 注入成功拉取（config-service 恢复可达）⇒ 退避到点第 2 次拉取成功。
    snapshot.mockResolvedValue(snapshotWith({ 'client.h5Enabled': false }, 2));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(2);

    await waiter; // 在成功前注册的等待者被唤醒（实现若漏唤醒，这里挂到 vitest 超时）
    expect(cache.snapshotOrNull()).toEqual(
      snapshotWith({ 'client.h5Enabled': false }, 2).config,
    );

    cache.onApplicationShutdown();
  });

  it('② 拉过一次后刷新失败：snapshotOrNull() 仍返回旧快照（last-good 执法——关态不被一次失败放门）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValueOnce(snapshotWith({ 'client.h5Enabled': false }, 1));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    const old = cache.snapshotOrNull();
    expect(old?.['client.h5Enabled']?.value).toBe(false);

    // 刷新（广播路径；真实世界里的刷新失败来源）——失败 ⇒ 不覆盖缓存。
    const handler = messageHandlerOf(redisState.instances[0]!);
    expect(handler, '订阅必须注册一条 message 处理器（否则本条空转）').toBeDefined();
    const callsBefore = snapshot.mock.calls.length;
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    await handler!('config:changed', '{}');
    expect(snapshot.mock.calls.length).toBeGreaterThan(callsBefore); // 刷新真的发生过（防「没刷也绿」）

    expect(cache.snapshotOrNull()).toEqual(old); // last-good 原样保留
    expect(cache.snapshotOrNull()?.['client.h5Enabled']?.value).toBe(false); // 关态不放门

    cache.onApplicationShutdown();
  });

  it('③ 广播到达即刷：订阅收到 config:changed ⇒ 重拉全量换新值；非本频道不触发', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValueOnce(snapshotWith({ 'client.h5Enabled': false }, 1));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.snapshotOrNull()?.['client.h5Enabled']?.value).toBe(false);

    const handler = messageHandlerOf(redisState.instances[0]!);
    expect(handler).toBeDefined();

    // 触发订阅回调 —— ⚠️ 不解析 payload、不做增量、不比版本（简单优先；只认频道名）。
    snapshot.mockResolvedValue(snapshotWith({ 'client.h5Enabled': true }, 2));
    await handler!('config:changed', JSON.stringify({ keys: ['client.h5Enabled'] }));
    expect(cache.snapshotOrNull()?.['client.h5Enabled']?.value).toBe(true); // 换缓存生效

    // 别的频道不触发重拉。
    const callsBefore = snapshot.mock.calls.length;
    await handler!('some:other:channel', '{}');
    expect(snapshot.mock.calls.length).toBe(callsBefore);

    cache.onApplicationShutdown();
  });

  it('④ 专用连接结构钉：订阅只发生在服务自建的独立连接上（未触碰任何共享 REDIS——本用例没给过它共享实例）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'client.appEnabled': true }));
    // 构造入参**只有** ConfigClient —— 没有任何共享 REDIS 实例的注入口。
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    // 服务自己建了**恰一条**连接，且 `subscribe('config:changed')` 发生在它上面。
    // 🔴 性质：网关的共享 `REDIS`（SessionGuard/限流/WS 名额共用实例）一旦被 subscribe
    // 会在 ioredis 里进入 subscribe 模式、普通命令永久失败 ⇒ 本用例以「全测试面里
    // **只有服务自建的这一条**连接被 subscribe 过」钉住专用连接结构。
    expect(redisState.instances).toHaveLength(1);
    const dedicated = redisState.instances[0]!;
    expect(dedicated.subscribe).toHaveBeenCalledWith('config:changed');
    const totalSubscribeCalls = redisState.instances.reduce(
      (n, instance) => n + instance.subscribe.mock.calls.length,
      0,
    );
    expect(totalSubscribeCalls).toBe(1);

    cache.onApplicationShutdown();
  });

  it('⑤ 安全网：CONFIG_SYNC_SAFETY_NET_MS=100 ⇒ 每 100ms 无条件重拉（丢广播形态）；关停后停止', async () => {
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '100';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'client.h5Enabled': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(snapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(snapshot).toHaveBeenCalledTimes(2); // 无条件：没有任何通知也重拉
    await vi.advanceTimersByTimeAsync(100);
    expect(snapshot).toHaveBeenCalledTimes(3);

    cache.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(3); // 关停清掉安全网定时器
  });

  it("⑥ 空串 = 未设：CONFIG_SYNC_SAFETY_NET_MS='' 走 60000 默认（|| 语义，不是 ??）", async () => {
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'client.h5Enabled': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(snapshot).toHaveBeenCalledTimes(1); // 59.999s 时点仍未重拉 ⇒ 默认是 60000 而非 0
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot).toHaveBeenCalledTimes(2);

    cache.onApplicationShutdown();
  });

  it('⑦ CONFIG_SYNC_DISABLE_PUSH 非空 ⇒ 不建订阅连接；空串 = 未设 ⇒ 照常订阅（正对照）', async () => {
    process.env.CONFIG_SYNC_DISABLE_PUSH = '1';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'client.h5Enabled': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(redisState.instances).toHaveLength(0); // 未 new Redis、也未 subscribe
    cache.onApplicationShutdown();

    // 正对照：空串（compose 的空默认透传形态）= 未设 ⇒ 恰好建一条订阅连接。
    // 没有这一半，「未建连接」可能只是因为实现根本不订阅（= 变异开关不存在）。
    process.env.CONFIG_SYNC_DISABLE_PUSH = '';
    const { client: client2, snapshot: snapshot2 } = makeClient();
    snapshot2.mockResolvedValue(snapshotWith({ 'client.h5Enabled': true }));
    const cache2 = new ConfigCacheService(client2);
    cache2.onModuleInit();
    await cache2.waitForFirstSnapshot();

    expect(redisState.instances).toHaveLength(1);
    expect(redisState.instances[0]!.subscribe).toHaveBeenCalledWith('config:changed');
    cache2.onApplicationShutdown();
  });

  it('⑧ 频道名逐字：订阅 config:changed（与 config-service 发布侧逐字同名）', () => {
    expect(CONFIG_CHANGED_CHANNEL).toBe('config:changed');
  });
});
