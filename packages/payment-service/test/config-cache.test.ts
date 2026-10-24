/**
 * `ConfigCacheService`（payment-service）的行为面 —— 本片（节奏/清理旋钮管理化）T4 创建：
 * 支付片 T2 骨架落成时本文件**不存在**（r1 🟠5 实核）⇒ 本卡照 user/currency 两份同构克隆
 * （夹具/三件套/失败语义/日志分源/关停闸逐块），差异面 = 本服务的两个读数键：
 * `pay.scanIntervalMs`（第 35 键；扫描链八补偿循环的统一节奏）与
 * `pay.reconcileIntervalMs`（第 36 键；日自检链），缺省回落 = 种子（60_000 / 86_400_000）。
 *
 * 分层姿态（设计 D3，**刻意登记防误读**）：两 getter 是 **janitor fail-safe** ——
 * 缺失/类型漂移/越界/**快照整体不可用**一律回落代码默认（六循环永不因配置不可用停摆）；
 * 钱面（充值/提现闸）用 `hasSnapshot()` **fail-closed 拒**，两者分层是刻意的
 * （「不确定不停扫」vs「不确定不放松钱」）。`hasSnapshot()` 本片新用途 = ⚙️5 首排动作快路径。
 *
 * ─── 夹具（照 user/currency 成例）────────────────────────────────────────
 *  - **假 ConfigClient**：`{ snapshot: vi.fn() }`，用例可控成功/失败
 *    （失败桩**用真实的 `ConfigServiceError`** —— 真 client 的失败形状就是它）；
 *  - **假订阅连接**：`vi.mock('ioredis')` 把**构造器**换成 spy —— `CONFIG_SYNC_DISABLE_PUSH`
 *    的「不建连接」判据要在**构造器**上断言（专用连接是服务自己 `new Redis(...)` 建的）；
 *  - **假时钟**：vitest fake timers（重试/安全网判据全部由 `vi.advanceTimersByTimeAsync` 驱动）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  createCapturingSink,
  createRedactingLogger,
  type LogRecord,
} from '@fight-the-landlord/shared';
import {
  ErrCode,
  type ConfigKey,
  type ConfigSnapshot,
  type ConfigSnapshotResponse,
} from '@fight-the-landlord/protocol';
import {
  CONFIG_CHANGED_CHANNEL,
  PAY_RECONCILE_DEFAULT_INTERVAL_MS,
  PAY_SCAN_DEFAULT_INTERVAL_MS,
  SNAPSHOT_BOOT_WAIT_MS,
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

/** 造一个「首拉成功」的缓存（await 到首快照就位后返回）。 */
async function cachedWith(over: Partial<Record<ConfigKey, unknown>>): Promise<ConfigCacheService> {
  const { client, snapshot } = makeClient();
  snapshot.mockResolvedValue(snapshotWith(over));
  const cache = new ConfigCacheService(client);
  cache.onModuleInit();
  await cache.waitForFirstSnapshot();
  return cache;
}

/** 真 client 在传输失败时的失败形状（用例的失败桩一律用它）。 */
const transportDown = () =>
  new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);

const ENV_KEYS = ['CONFIG_SYNC_SAFETY_NET_MS', 'CONFIG_SYNC_DISABLE_PUSH'] as const;

describe('ConfigCacheService（本片 T4：payment-service 节奏二键消费链）', () => {
  let savedEnv: Record<string, string | undefined>;
  let captured: ReturnType<typeof createCapturingSink>;
  const warnRecords = (): LogRecord[] => captured.records.filter((r) => r.level === 'warn');

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    redisState.instances.length = 0;
    captured = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'payment-service' }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    // M4（config.client.test.ts 的成例）：`Logger.overrideLogger` 是**进程级**的，用后必须还原。
    Logger.overrideLogger(new Logger());
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.useRealTimers();
  });

  it('缺省回落：拉取失败 + 空缓存 ⇒ 不阻塞就绪、二键取代码默认值（种子）、hasSnapshot=false、1s 退避、空窗 WARN 只一次', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);

    // 🔴 不阻塞就绪：同步返回（若实现改成 await 首次拉取，这里当场红）。
    expect(cache.onModuleInit()).toBeUndefined();
    // 缺省 = 种子（⚙️1 第 35/36 键）：janitor fail-safe —— 配置说不清也不停扫。
    expect(PAY_SCAN_DEFAULT_INTERVAL_MS).toBe(60_000);
    expect(PAY_RECONCILE_DEFAULT_INTERVAL_MS).toBe(86_400_000);
    expect(cache.scanIntervalMs()).toBe(60_000);
    expect(cache.reconcileIntervalMs()).toBe(86_400_000);
    // 钱面判别面（fail-closed 侧；与 janitor fail-safe 刻意分层，设计 D3）。
    expect(cache.hasSnapshot()).toBe(false);

    // 1s 退避重试直到首次成功：启动那次 + 每 1s 一次。
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(snapshot).toHaveBeenCalledTimes(1); // 未到 1s：不重试
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot).toHaveBeenCalledTimes(2);

    // 空窗 WARN 只发一次（1s 重试不刷屏）；来源如实（退避循环的一轮 ⇒ timer）。
    expect(warnRecords()).toHaveLength(1);
    expect(warnRecords()[0]!.source).toBe('timer');
    expect(cache.hasSnapshot()).toBe(false); // 一直失败 ⇒ 一直 false

    cache.onApplicationShutdown();
  });

  it('hasSnapshot()：首拉成功 ⇒ true（⚙️5 首排快路径的成立侧）', async () => {
    const cache = await cachedWith({ 'pay.scanIntervalMs': 2_000 });
    expect(cache.hasSnapshot()).toBe(true);
    cache.onApplicationShutdown();
  });

  it('节奏二 getter 默认常数与 WAIT 逐值：60,000 / 86,400,000（= 种子 ⚙️1）；SNAPSHOT_BOOT_WAIT_MS=10_000', () => {
    expect(PAY_SCAN_DEFAULT_INTERVAL_MS).toBe(60_000);
    expect(PAY_RECONCILE_DEFAULT_INTERVAL_MS).toBe(86_400_000);
    expect(SNAPSHOT_BOOT_WAIT_MS).toBe(10_000);
  });

  it('二 getter 正常值逐值生效（含每键边界两端 1 与上界 600,000 / 864,000,000）', async () => {
    for (const value of [1, 2_000, 60_000, 600_000]) {
      const cache = await cachedWith({ 'pay.scanIntervalMs': value });
      expect(cache.scanIntervalMs(), `pay.scanIntervalMs=${value} 必须原样生效`).toBe(value);
      cache.onApplicationShutdown();
    }
    for (const value of [1, 2_000, 86_400_000, 864_000_000]) {
      const cache = await cachedWith({ 'pay.reconcileIntervalMs': value });
      expect(cache.reconcileIntervalMs(), `pay.reconcileIntervalMs=${value} 必须原样生效`).toBe(value);
      cache.onApplicationShutdown();
    }
  });

  it('二 getter 坏值回落：键缺失 / 类型漂移 / 0 / 负数 / 非整数 / 上界+1 ⇒ 一律默认常数', async () => {
    const missing = await cachedWith({}); // 二键全缺失
    expect(missing.scanIntervalMs()).toBe(PAY_SCAN_DEFAULT_INTERVAL_MS);
    expect(missing.reconcileIntervalMs()).toBe(PAY_RECONCILE_DEFAULT_INTERVAL_MS);
    missing.onApplicationShutdown();

    const spec: Array<{
      key: ConfigKey;
      bad: unknown[];
      read: (c: ConfigCacheService) => number;
      expected: number;
    }> = [
      {
        key: 'pay.scanIntervalMs',
        bad: ['60000', 0, -1, 3.5, 600_001, true, null, undefined, Number.NaN],
        read: (c) => c.scanIntervalMs(),
        expected: 60_000,
      },
      {
        key: 'pay.reconcileIntervalMs',
        bad: ['86400000', 0, -1, 3.5, 864_000_001, true, null, undefined, Number.NaN],
        read: (c) => c.reconcileIntervalMs(),
        expected: 86_400_000,
      },
    ];
    for (const { key, bad, read, expected } of spec) {
      for (const value of bad) {
        const cache = await cachedWith({ [key]: value });
        expect(read(cache), `${key}=${JSON.stringify(value)} 必须回落 ${expected}`).toBe(expected);
        cache.onApplicationShutdown();
      }
    }
  });

  it('🔴 快照整体不可用（拉取失败 + 空缓存）⇒ 二 getter 同样回落默认常数（janitor fail-safe，不停扫）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await vi.advanceTimersByTimeAsync(0); // 首轮失败落定

    // ⚠️ 与钱面 fail-closed 刻意分层（设计 D3）：这里**不许** throw / 拒绝，一律回落默认。
    expect(cache.scanIntervalMs()).toBe(PAY_SCAN_DEFAULT_INTERVAL_MS);
    expect(cache.reconcileIntervalMs()).toBe(PAY_RECONCILE_DEFAULT_INTERVAL_MS);

    cache.onApplicationShutdown();
  });

  it('频道名逐字：订阅 config:changed（与 config-service 发布侧逐字同名）', () => {
    expect(CONFIG_CHANGED_CHANNEL).toBe('config:changed');
  });

  it('通知 ⇒ 重拉并换缓存（改扫描周期生效）；非本频道消息不触发重拉', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValueOnce(snapshotWith({ 'pay.scanIntervalMs': 60_000 }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.scanIntervalMs()).toBe(60_000);

    // 订阅真的挂上了：专用连接（恰一条）+ 频道名逐字。
    expect(redisState.instances).toHaveLength(1);
    const subscriber = redisState.instances[0]!;
    expect(subscriber.subscribe).toHaveBeenCalledWith('config:changed');

    // 触发订阅回调（`on('message', …)` 注册的那一条）—— 不解析 payload，全量重拉。
    const handler = subscriber.on.mock.calls.find(([event]) => event === 'message')?.[1] as
      | ((channel: string, payload: string) => Promise<void>)
      | undefined;
    expect(handler, '订阅必须注册一条 message 处理器（否则本条空转）').toBeDefined();

    snapshot.mockResolvedValue(snapshotWith({ 'pay.scanIntervalMs': 2_000 }, 2));
    await handler!('config:changed', JSON.stringify({ keys: ['pay.scanIntervalMs'] }));

    expect(cache.scanIntervalMs()).toBe(2_000); // 换缓存生效

    // 别的频道不触发重拉。
    const callsBefore = snapshot.mock.calls.length;
    await handler!('some:other:channel', '{}');
    expect(snapshot.mock.calls.length).toBe(callsBefore);

    cache.onApplicationShutdown();
  });

  it('安全网：CONFIG_SYNC_SAFETY_NET_MS=100 ⇒ 每 100ms 无条件重拉（与推送无关）；关停后停止', async () => {
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '100';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'pay.scanIntervalMs': 60_000 }));
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

  it('CONFIG_SYNC_DISABLE_PUSH 非空 ⇒ 不建订阅连接；空串 = 未设 ⇒ 照常订阅（正对照）', async () => {
    process.env.CONFIG_SYNC_DISABLE_PUSH = '1';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'pay.scanIntervalMs': 60_000 }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(redisState.instances).toHaveLength(0); // 未 new Redis、也未 subscribe
    cache.onApplicationShutdown();

    // 正对照：空串（compose 的空默认透传形态）= 未设 ⇒ 恰好建一条订阅连接。
    // 没有这一半，「未建连接」可能只是因为实现根本不订阅（= 变异开关不存在）。
    process.env.CONFIG_SYNC_DISABLE_PUSH = '';
    const { client: client2, snapshot: snapshot2 } = makeClient();
    snapshot2.mockResolvedValue(snapshotWith({ 'pay.scanIntervalMs': 60_000 }));
    const cache2 = new ConfigCacheService(client2);
    cache2.onModuleInit();
    await cache2.waitForFirstSnapshot();

    expect(redisState.instances).toHaveLength(1);
    expect(redisState.instances[0]!.subscribe).toHaveBeenCalledWith('config:changed');
    cache2.onApplicationShutdown();
  });

  it("空串 env = 未设：CONFIG_SYNC_SAFETY_NET_MS='' ⇒ 走 60000 默认", async () => {
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'pay.scanIntervalMs': 60_000 }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(snapshot).toHaveBeenCalledTimes(1); // 59.999s 时点仍未重拉 ⇒ 默认是 60000 而非 0/100
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot).toHaveBeenCalledTimes(2);

    cache.onApplicationShutdown();
  });

  it('启动重试：失败 ⇒ 1s 后重试；首次成功后停止（不空转）；随后 hasSnapshot 翻 true', async () => {
    const { client, snapshot } = makeClient();
    snapshot
      .mockImplementationOnce(() => Promise.reject(transportDown()))
      .mockImplementationOnce(() => Promise.reject(transportDown()))
      .mockImplementation(() => Promise.resolve(snapshotWith({ 'pay.scanIntervalMs': 2_000 })));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    expect(cache.hasSnapshot()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(2); // 1s 退避后重试（仍失败）
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(3); // 再 1s 后第 3 次 —— 成功
    await cache.waitForFirstSnapshot();
    expect(cache.hasSnapshot()).toBe(true);
    expect(cache.scanIntervalMs()).toBe(2_000);

    // 成功后不再重试：再推 10s（安全网 60s 未到）也不会有第 4 次。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshot).toHaveBeenCalledTimes(3);

    cache.onApplicationShutdown();
  });

  it('日志分源（R1107 同构落地）：定时器轮 ⇒ timer（每轮独立 id）；订阅回调 ⇒ internal', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'pay.scanIntervalMs': 60_000 }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    const applied = () => captured.records.filter((r) => r.msg.includes('config snapshot applied'));

    // 启动首拉 = 退避循环的第 1 轮 ⇒ timer + 自建 id（`bootstrap` 不得当兜底用）。
    expect(applied()).toHaveLength(1);
    expect(applied()[0]!.source).toBe('timer');
    expect(applied()[0]!.traceId).not.toBeNull();

    // 安全网轮到点 ⇒ 同一个来源类别（每轮各自建 id）。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applied()).toHaveLength(2);
    expect(applied()[1]!.source).toBe('timer');
    expect(applied()[1]!.traceId).not.toBeNull();

    // 订阅回调 ⇒ internal（内部事件：无客户端请求 ⇒ 不编造 id）。
    const subscriber = redisState.instances[0]!;
    const handler = subscriber.on.mock.calls.find(([event]) => event === 'message')?.[1] as
      | ((channel: string, payload: string) => Promise<void>)
      | undefined;
    await handler!('config:changed', '{}');
    expect(applied()).toHaveLength(3);
    expect(applied()[2]!.source).toBe('internal');
    expect(applied()[2]!.traceId).toBeNull();

    cache.onApplicationShutdown();
  });

  it('🔴 关停发生在在途拉取期间 ⇒ 之后不再排任何定时器（T6 审查 Important-2 的同构落地）', async () => {
    // ── Phase A：启动退避循环的一轮**在途**时关停 ──────────────────────────
    const { client, snapshot } = makeClient();
    let rejectInFlight: ((reason: unknown) => void) | undefined;
    snapshot.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectInFlight = reject;
        }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    expect(snapshot).toHaveBeenCalledTimes(1); // 第 1 轮在途（挂起）

    cache.onApplicationShutdown(); // 关停发生在在途期间
    rejectInFlight!(transportDown()); // 迟到的失败回执
    await vi.advanceTimersByTimeAsync(0);

    // 没有守卫时：这条迟到的回执会再排一个 1s 退避定时器 ⇒ 循环「复活」。
    const internals = cache as unknown as { retryTimer: unknown; safetyTimer: unknown };
    expect(internals.retryTimer).toBeNull();
    expect(internals.safetyTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshot).toHaveBeenCalledTimes(1); // 不再被调（无复活循环）

    // ── Phase B：60s 安全网的一轮在途时关停（同一缺陷的另一条腿）────────────
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '100';
    const { client: client2, snapshot: snapshot2 } = makeClient();
    let settleSafety: ((reason: unknown) => void) | undefined;
    snapshot2
      .mockResolvedValueOnce(snapshotWith({ 'pay.scanIntervalMs': 60_000 }))
      .mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            settleSafety = reject;
          }),
      );
    const cache2 = new ConfigCacheService(client2);
    cache2.onModuleInit();
    await cache2.waitForFirstSnapshot();
    await vi.advanceTimersByTimeAsync(100); // 安全网轮到点 ⇒ 第 2 次拉取在途
    expect(snapshot2).toHaveBeenCalledTimes(2);

    cache2.onApplicationShutdown();
    settleSafety!(transportDown());
    await vi.advanceTimersByTimeAsync(0);

    const internals2 = cache2 as unknown as { retryTimer: unknown; safetyTimer: unknown };
    expect(internals2.retryTimer).toBeNull();
    expect(internals2.safetyTimer).toBeNull(); // 不得重排下一轮安全网
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot2).toHaveBeenCalledTimes(2); // 不再被调
  });
});
