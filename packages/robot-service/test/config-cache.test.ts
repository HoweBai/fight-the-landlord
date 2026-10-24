/**
 * `ConfigCacheService`（robot 侧）的行为面（片⑦ design D2 / 规格 §2.3 的消费侧 —— T8 的
 * 「C3 半边」：**拉取失败 + 空缓存 ⇒ 服务照常就绪、四 getter 全取代码默认值**）。
 *
 * ─── 夹具（三件，形态照 room-service `config-cache.test.ts` 的成例）────────────────
 *  - **假 ConfigClient**：`{ snapshot: vi.fn() }`，用例可控成功/失败
 *    （失败桩**用真实的 `ConfigServiceError`** —— 真 client 的失败形状就是它）；
 *  - **假订阅连接**：`vi.mock('ioredis')` 把**构造器**换成 spy（`CONFIG_SYNC_DISABLE_PUSH`
 *    的「不建连接」判据要在**构造器**上断言 —— 专用连接是服务自己 `new Redis(...)` 建的，
 *    不是注入的：design D1 M-5）；
 *  - **假时钟**：vitest fake timers。
 *
 * ─── 覆盖（T8 brief Step 1 的组 + 补）：──────────────────────────────────
 *  ① C3 拉失败 + 空缓存 ⇒ 服务照常、**四 getter 全默认**、1s 退避重试、空窗 WARN 只一次
 *  ② 通知（config:changed）⇒ 重拉并换缓存；非本频道不触发；JSON 对象 → 有序对转换
 *  ③ 安全网：CONFIG_SYNC_SAFETY_NET_MS=100 ⇒ 每 100ms 无条件重拉；关停后不再重拉
 *  ④ CONFIG_SYNC_DISABLE_PUSH 非空 ⇒ 不建订阅连接（含空串正对照的判别力自证）
 *  ⑤ 空串 env = 未设：CONFIG_SYNC_SAFETY_NET_MS='' ⇒ 走 60000 默认
 *  ⑥ 启动重试：1s 后重试、**首次成功后停止**（不空转）
 *  ⑦ 常量表与种子同值（四键 = spec §2.2 的默认）；频道名逐字
 *  ⑧ **日志分源（R1107；T6 审查 Important-1）**：定时器轮 ⇒ timer（每轮独立 id）；
 *     订阅回调 ⇒ internal（不编造 id）—— 回调内再包一次（ioredis 回调不继承 ALS）
 *  ⑨ **关停闸（T6 审查 Important-2）**：两条自重排链「在途关停 ⇒ 迟到回执不再排定时器」
 *  ⑩ 快照值**形状非法** ⇒ 逐 getter 取默认（DB 被手工改坏时不得把垃圾数据带进决策）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger, type LogRecord } from '@fight-the-landlord/shared';
import {
  ErrCode,
  type ConfigKey,
  type ConfigSnapshot,
  type ConfigSnapshotResponse,
  type SkillLevel,
} from '@fight-the-landlord/protocol';
import {
  CONFIG_CHANGED_CHANNEL,
  ConfigCacheService,
} from '../src/config/config-cache.service';
import { ConfigClient, ConfigServiceError, TRANSPORT_FAILURE_MESSAGE } from '../src/config/config.client';
import { ROBOT_CONFIG_DEFAULTS } from '../src/robot/config';
import { MODEL_BY_SKILL } from '../src/robot/models';

/** `vi.mock` 的工厂是**提升**的 ⇒ 共享状态必须先经 `vi.hoisted` 建出来（vitest 官方形态）。 */
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
  // 生产代码两种写法都有（`health.test.ts` 的注记）—— 两个名字都指同一个 spy。
  return { default: ctor, Redis: ctor };
});

/** 种子的有序对形态（0.15/0.35/0.5 —— `parseSkillDistribution` 的归一化输出）。 */
const SEED_PAIRS: Array<[SkillLevel, number]> = [
  ['beginner', 0.15],
  ['intermediate', 0.35],
  ['advanced', 0.5],
];

/** 浮点残差的稳定比较（`robot.config.test.ts` 的同款纪律）。 */
const stable = (pairs: ReadonlyArray<readonly [SkillLevel, number]>): Array<[SkillLevel, number]> =>
  pairs.map(([k, w]) => [k, Number(w.toFixed(6))]);

/** 假 ConfigClient（`snapshot` 是 `vi.fn`，用例可以 mockResolvedValue / mockRejectedValue）。 */
function makeClient(): { client: ConfigClient; snapshot: ReturnType<typeof vi.fn> } {
  const snapshot = vi.fn();
  return { client: { snapshot } as unknown as ConfigClient, snapshot };
}

/** 造一个 `ConfigSnapshotResponse`（只含传入的键；`config` 的完整五十一键由 config-service 保证）。 */
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

const ENV_KEYS = ['CONFIG_SYNC_SAFETY_NET_MS', 'CONFIG_SYNC_DISABLE_PUSH'] as const;

/** 四 getter 全默认的断言（C3 的核心；多处复用）。 */
function expectAllDefaults(cache: ConfigCacheService): void {
  expect(stable(cache.skillDistribution())).toEqual(SEED_PAIRS);
  expect(cache.ruleFallback()).toBe(true);
  expect(cache.modelBySkill()).toEqual(MODEL_BY_SKILL);
  expect(cache.reclaimIntervalMs()).toBe(60_000);
}

describe('ConfigCacheService（robot；design D2：缓存 + 推送 + 安全网）', () => {
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
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'robot-service' }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    // M4 成例：`Logger.overrideLogger` 是**进程级**的，用后必须还原。
    Logger.overrideLogger(new Logger());
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.useRealTimers();
  });

  it('C3：拉取失败 + 空缓存 ⇒ 服务照常（不抛、就绪不被阻塞），四 getter 全取代码默认值', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);

    // 🔴 不阻塞就绪：同步返回（若实现改成 await 首次拉取，这里当场红）。
    expect(cache.onModuleInit()).toBeUndefined();

    // 四键全是「热项」：拿不到就取默认（=种子），且**不抛**（配置中心挂了不得停止服务）。
    expectAllDefaults(cache);

    // 1s 退避重试直到首次成功：启动那次 + 每 1s 一次。
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(snapshot).toHaveBeenCalledTimes(1); // 未到 1s：不重试
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot).toHaveBeenCalledTimes(2);

    // 空窗 WARN 只发一次（「一次 WARN」纪律 —— 3 次失败不允许刷 3 条）。
    expect(warnRecords()).toHaveLength(1);
    // 来源如实（R1107）：退避循环的一轮 ⇒ `timer`，不是 `bootstrap`。
    expect(warnRecords()[0].source).toBe('timer');

    cache.onApplicationShutdown();
  });

  it('通知 ⇒ 重拉并换缓存（JSON 对象 → 既有有序对形态）；非本频道消息不触发重拉', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValueOnce(snapshotWith({ 'robot.ruleFallback': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    // 订阅真的挂上了：专用连接（恰一条）+ 频道名逐字。
    expect(redisState.instances).toHaveLength(1);
    const subscriber = redisState.instances[0];
    expect(subscriber.subscribe).toHaveBeenCalledWith('config:changed');

    // 触发订阅回调（`on('message', …)` 注册的那一条）—— 不解析 payload，全量重拉。
    const handler = subscriber.on.mock.calls.find(([event]) => event === 'message')?.[1] as
      | ((channel: string, payload: string) => Promise<void>)
      | undefined;
    expect(handler, '订阅必须注册一条 message 处理器（否则本条空转）').toBeDefined();

    // 换缓存：四个键全换 —— 含 JSON 对象 → 有序对（LEVELS 顺序逐位）与自定义模型映射。
    snapshot.mockResolvedValue(
      snapshotWith(
        {
          'robot.skillDistribution': { beginner: 0.2, intermediate: 0.3, advanced: 0.5 },
          'robot.ruleFallback': false,
          'robot.modelBySkill': { beginner: 'douzero_ADP', intermediate: 'douzero_ADP', advanced: 'douzero_ADP' },
          'robot.reclaimIntervalMs': 45_000,
        },
        2,
      ),
    );
    await handler!('config:changed', JSON.stringify({ keys: ['robot.ruleFallback'] }));

    expect(stable(cache.skillDistribution())).toEqual([
      ['beginner', 0.2], ['intermediate', 0.3], ['advanced', 0.5],
    ]);
    expect(cache.ruleFallback()).toBe(false);
    expect(cache.modelBySkill()).toEqual({
      beginner: 'douzero_ADP', intermediate: 'douzero_ADP', advanced: 'douzero_ADP',
    });
    expect(cache.reclaimIntervalMs()).toBe(45_000);

    // 别的频道不触发重拉。
    const callsBefore = snapshot.mock.calls.length;
    await handler!('some:other:channel', '{}');
    expect(snapshot.mock.calls.length).toBe(callsBefore);

    cache.onApplicationShutdown();
  });

  it('安全网：CONFIG_SYNC_SAFETY_NET_MS=100 ⇒ 每 100ms 无条件重拉（与推送无关）；关停后停止', async () => {
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '100';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'robot.ruleFallback': true }));
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

    // 有旧值时的失败只记 warn 不刷屏（「using cached snapshot」形态）——快照在、拉取再失败。
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.ruleFallback()).toBe(true); // 继续用旧值（design D2 的失败语义分层）
  });

  it('CONFIG_SYNC_DISABLE_PUSH 非空 ⇒ 不建订阅连接；空串 = 未设 ⇒ 照常订阅（变异开关可控）', async () => {
    process.env.CONFIG_SYNC_DISABLE_PUSH = '1';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'robot.ruleFallback': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(redisState.instances).toHaveLength(0); // 未 new Redis、也未 subscribe
    cache.onApplicationShutdown();

    // 正对照：空串（compose 的空默认透传形态）= 未设 ⇒ 恰好建一条订阅连接。
    // 没有这一半，「未建连接」可能只是因为实现根本不订阅（=变异开关不存在）。
    process.env.CONFIG_SYNC_DISABLE_PUSH = '';
    const second = makeClient();
    second.snapshot.mockResolvedValue(snapshotWith({ 'robot.ruleFallback': true }));
    const cache2 = new ConfigCacheService(second.client);
    cache2.onModuleInit();
    await cache2.waitForFirstSnapshot();

    expect(redisState.instances).toHaveLength(1);
    expect(redisState.instances[0].subscribe).toHaveBeenCalledWith('config:changed');
    cache2.onApplicationShutdown();
  });

  it("空串 env = 未设：CONFIG_SYNC_SAFETY_NET_MS='' ⇒ 走 60000 默认", async () => {
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'robot.ruleFallback': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(snapshot).toHaveBeenCalledTimes(1); // 59.999s 时点仍未重拉 ⇒ 默认是 60000 而非 0/100
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot).toHaveBeenCalledTimes(2);

    cache.onApplicationShutdown();
  });

  it('启动重试：失败 ⇒ 1s 后重试；首次成功后停止（不空转）', async () => {
    const { client, snapshot } = makeClient();
    snapshot
      .mockImplementationOnce(() => Promise.reject(transportDown()))
      .mockImplementationOnce(() => Promise.reject(transportDown()))
      .mockImplementation(() => Promise.resolve(snapshotWith({ 'robot.ruleFallback': false })));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(2); // 1s 退避后重试（仍失败）
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(3); // 再 1s 后第 3 次 —— 成功
    await cache.waitForFirstSnapshot();
    expect(cache.ruleFallback()).toBe(false);

    // 成功后不再重试：再推 10s（安全网 60s 未到）也不会有第 4 次。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshot).toHaveBeenCalledTimes(3);

    cache.onApplicationShutdown();
  });

  it('频道名逐字 + 四键默认表与规格 §2.2 的种子逐键同值', () => {
    expect(CONFIG_CHANGED_CHANNEL).toBe('config:changed');
    // 常量表：真·种子（0.15/0.35/0.5 · true · 三档映射 · 60000）。
    expect(ROBOT_CONFIG_DEFAULTS['game.doudizhu.robot.ruleFallback']).toBe(true);
    expect(ROBOT_CONFIG_DEFAULTS['game.doudizhu.robot.modelBySkill']).toEqual({
      beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP',
    });
    expect(ROBOT_CONFIG_DEFAULTS['robot.reclaimIntervalMs']).toBe(60_000);
    expect(ROBOT_CONFIG_DEFAULTS['game.doudizhu.robot.skillDistribution']).toBe(
      'beginner=0.15,intermediate=0.35,advanced=0.5',
    );
  });

  it('快照值形状非法（DB 被手工改坏）⇒ 逐 getter 取默认，不得把垃圾数据带进决策', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValueOnce(
      snapshotWith({
        'robot.skillDistribution': { beginner: 0.1 }, // 缺档
        'robot.ruleFallback': 'true', // 字符串不是 boolean
        'robot.modelBySkill': { beginner: 'garbage', intermediate: 'douzero_WP', advanced: 'douzero_ADP' },
        'robot.reclaimIntervalMs': 0, // 非正
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expectAllDefaults(cache);

    // 另一半：非整数 / 非数字的周期、负数权重、数组形态 —— 同样逐键回默认。
    snapshot.mockResolvedValue(
      snapshotWith({
        'robot.skillDistribution': { beginner: -1, intermediate: 1, advanced: 1 },
        'robot.reclaimIntervalMs': 1.5,
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000); // 安全网重拉
    expect(stable(cache.skillDistribution())).toEqual(SEED_PAIRS);
    expect(cache.reclaimIntervalMs()).toBe(60_000);

    cache.onApplicationShutdown();
  });

  it('日志分源（R1107）：定时器轮 ⇒ timer（每轮独立 id）；订阅回调 ⇒ internal', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'robot.ruleFallback': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    const applied = () => captured.records.filter((r) => r.msg.includes('config snapshot applied'));

    // 启动首拉 = 退避循环的第 1 轮 ⇒ timer + 自建 id（`bootstrap` 是「进程启动早期」，
    // 不得当兜底；「这一轮」就是它的来源）。
    expect(applied()).toHaveLength(1);
    expect(applied()[0].source).toBe('timer');
    expect(applied()[0].traceId).not.toBeNull();

    // 安全网轮到点 ⇒ 同一个来源类别（每轮各自建 id）。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applied()).toHaveLength(2);
    expect(applied()[1].source).toBe('timer');
    expect(applied()[1].traceId).not.toBeNull();

    // 订阅回调 ⇒ internal（内部事件：无客户端请求 ⇒ 不编造 id）；
    // ⚠️ 回调内**再包一次** ALS —— ioredis 的回调不继承注册时那层作用域。
    const subscriber = redisState.instances[0];
    const handler = subscriber.on.mock.calls.find(([event]) => event === 'message')?.[1] as
      | ((channel: string, payload: string) => Promise<void>)
      | undefined;
    await handler!('config:changed', '{}');
    expect(applied()).toHaveLength(3);
    expect(applied()[2].source).toBe('internal');
    expect(applied()[2].traceId).toBeNull();

    cache.onApplicationShutdown();
  });

  it('🔴 关停发生在在途拉取期间 ⇒ 之后不再排任何定时器（T6 审查 Important-2 同构）', async () => {
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
    const second = makeClient();
    let settleSafety: ((reason: unknown) => void) | undefined;
    second.snapshot
      .mockResolvedValueOnce(snapshotWith({ 'robot.ruleFallback': true }))
      .mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            settleSafety = reject;
          }),
      );
    const cache2 = new ConfigCacheService(second.client);
    cache2.onModuleInit();
    await cache2.waitForFirstSnapshot();
    await vi.advanceTimersByTimeAsync(100); // 安全网轮到点 ⇒ 第 2 次拉取在途
    expect(second.snapshot).toHaveBeenCalledTimes(2);

    cache2.onApplicationShutdown();
    settleSafety!(transportDown());
    await vi.advanceTimersByTimeAsync(0);

    const internals2 = cache2 as unknown as { retryTimer: unknown; safetyTimer: unknown };
    expect(internals2.retryTimer).toBeNull();
    expect(internals2.safetyTimer).toBeNull(); // 不得重排下一轮安全网
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.snapshot).toHaveBeenCalledTimes(2); // 不再被调
  });
});

describe('机器人键平行化（2026-10-24）：新键优先、缺失回退旧键', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function cacheWith(over: Record<string, unknown>): Promise<ConfigCacheService> {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith(over as never));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    return cache;
  }

  it('新键覆盖旧键', async () => {
    const cache = await cacheWith({
      'game.doudizhu.robot.ruleFallback': false,
      'robot.ruleFallback': true,
      'game.doudizhu.robot.skillDistribution': { beginner: 0, intermediate: 0, advanced: 1 },
      'robot.skillDistribution': { beginner: 1, intermediate: 0, advanced: 0 },
      'game.doudizhu.robot.modelBySkill': {
        beginner: 'douzero_ADP',
        intermediate: 'sl',
        advanced: 'sl',
      },
      'robot.modelBySkill': { beginner: 'sl', intermediate: 'sl', advanced: 'sl' },
    });
    expect(cache.ruleFallback()).toBe(false);
    expect(stable(cache.skillDistribution())).toEqual([
      ['beginner', 0],
      ['intermediate', 0],
      ['advanced', 1],
    ]);
    expect(cache.modelBySkill().beginner).toBe('douzero_ADP');
    cache.onApplicationShutdown();
  });

  it('新键缺失 ⇒ 旧键', async () => {
    const cache = await cacheWith({
      'robot.ruleFallback': false,
      'robot.skillDistribution': { beginner: 1, intermediate: 0, advanced: 0 },
      'robot.modelBySkill': { beginner: 'douzero_ADP', intermediate: 'sl', advanced: 'sl' },
    });
    expect(cache.ruleFallback()).toBe(false);
    expect(stable(cache.skillDistribution())).toEqual([
      ['beginner', 1],
      ['intermediate', 0],
      ['advanced', 0],
    ]);
    expect(cache.modelBySkill().beginner).toBe('douzero_ADP');
    cache.onApplicationShutdown();
  });
});
