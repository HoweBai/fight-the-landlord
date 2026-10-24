/**
 * `ConfigCacheService` 的行为面（片⑦ design D2 / 规格 §2.3 的消费侧）。
 *
 * ─── 夹具（三件，形态照既有成例）──────────────────────────────────────────
 *  - **假 ConfigClient**：`{ snapshot: vi.fn() }`，用例可控成功/失败
 *    （失败桩**用真实的 `ConfigServiceError`** —— 真 client 的失败形状就是它，
 *     用 `new Error()` 桩会测一个现实中不存在的输入）；
 *  - **假订阅连接**：`vi.mock('ioredis')` 把**构造器**换成 spy（照 `health.test.ts` 成例，
 *     同时导出 `default` 与 `Redis` 两种写法）—— `CONFIG_SYNC_DISABLE_PUSH` 的
 *     「不建连接」判据要在**构造器**上断言，这是本文件用 mock 而非注入替身的原因
 *     （🔴 专用连接是服务自己 `new Redis(...)` 建的，不是注入的：design D1 M-5）；
 *  - **假时钟**：vitest fake timers（重试/安全网判据全部由 `vi.advanceTimersByTimeAsync` 驱动）。
 *
 * ─── 覆盖（brief Step 1 的七组 + 两组补）：────────────────────────────────
 *  ① C3 拉取失败 + 空缓存 ⇒ 服务照常、热项取默认、1s 退避重试、空窗 WARN 只一次
 *  ② C4 空缓存 + 拉失败 ⇒ baseScoreLevels() 抛 ConfigServiceError(10007)
 *  ③ C4′ 拉取成功但表缺失/非法 ⇒ 仍抛 10007（fail-closed，绝不返回空表）
 *  ④ C4b 缓存有旧值 ⇒ 用旧值、不抛、不再拉
 *  ⑤ 通知（config:changed）⇒ 重拉并换缓存；非本频道不触发
 *  ⑥ 安全网：CONFIG_SYNC_SAFETY_NET_MS=100 ⇒ 每 100ms 无条件重拉；关停后不再重拉
 *  ⑦ CONFIG_SYNC_DISABLE_PUSH 非空 ⇒ 不建订阅连接（含空串正对照的判别力自证）
 *  ⑧ 空串 env = 未设：CONFIG_SYNC_SAFETY_NET_MS='' ⇒ 走 60000 默认
 *  ⑨ 启动重试：1s 后重试、**首次成功后停止**（不空转）
 *  ⑩ **C9**（T7 补）：三处循环（match / autostart / reaper）的自重排口径 ——
 *     「改小后第 N+1 轮触发点 = 第 N 轮结束 + 新值」（setInterval 未退役的实现下必红）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger, type LogRecord } from '@fight-the-landlord/shared';
import { DEFAULT_PDK_RULES } from '@fight-the-landlord/shared';
import { ErrCode, type ConfigKey, type ConfigSnapshot, type ConfigSnapshotResponse } from '@fight-the-landlord/protocol';
import {
  CYCLE_MS_DEFAULTS,
  CONFIG_CHANGED_CHANNEL,
  ConfigCacheService,
} from '../src/config/config-cache.service';
import { ConfigClient, ConfigServiceError } from '../src/gateway/config.client';
import { TRANSPORT_FAILURE_MESSAGE } from '../src/gateway/transport-failure';
import { MatchService } from '../src/match/match.service';
import { RoomsAutostartTask } from '../src/rooms/rooms.autostart';
import { RoomsReaperTask } from '../src/rooms/rooms.reaper';
import type { RoomsService } from '../src/rooms/rooms.service';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

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
  // 生产代码两种写法都有（`health.test.ts` 的注记）—— 两个名字都指同一个 spy。
  return { default: ctor, Redis: ctor };
});

const LEVELS_A = [
  { name: '休闲场', baseScore: 15 },
  { name: '标准场', baseScore: 80 },
];
const LEVELS_B = [
  { name: '休闲场', baseScore: 15 },
  { name: '标准场', baseScore: 80 },
  { name: '竞技场', baseScore: 480 },
];

/** 假 ConfigClient（`snapshot` 是 `vi.fn`，用例可以 mockResolvedValue / mockRejectedValue）。 */
function makeClient(): { client: ConfigClient; snapshot: ReturnType<typeof vi.fn> } {
  const snapshot = vi.fn();
  return { client: { snapshot } as unknown as ConfigClient, snapshot };
}

/** 造一个 `ConfigSnapshotResponse`（只含传入的键；`config` 的完整九十二键由 config-service 保证）。 */
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

describe('ConfigCacheService（design D2：缓存 + 推送 + 安全网）', () => {
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
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'room-service' }));
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

  it('C3：拉取失败 + 空缓存 ⇒ 服务照常（不抛、就绪不被阻塞），热项取默认值', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);

    // 🔴 不阻塞就绪：同步返回（若实现改成 await 首次拉取，这里当场红）。
    expect(cache.onModuleInit()).toBeUndefined();

    // 热项全部取代码默认值（=种子），且**不抛**（配置中心挂了不得停止服务）。
    expect(cache.friendRoomEnabled()).toBe(false); // 安全方向
    expect(cache.cycleMs('room.matchScanIntervalMs')).toBe(5_000);
    expect(cache.cycleMs('room.autostartIntervalMs')).toBe(5_000);
    expect(cache.cycleMs('room.reapIntervalMs')).toBe(60_000);

    // 1s 退避重试直到首次成功：启动那次 + 每 1s 一次。
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(snapshot).toHaveBeenCalledTimes(1); // 未到 1s：不重试
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(3);

    // 空窗 WARN 只发一次（设计要求的「一次 WARN」——3 次失败不允许刷 3 条）。
    expect(warnRecords()).toHaveLength(1);
    // 来源如实（R1107 / T6 审查 Important-1）：退避循环的一轮 ⇒ `timer`，不是 `bootstrap`。
    expect(warnRecords()[0].source).toBe('timer');

    cache.onApplicationShutdown();
  });

  it('C4：空缓存 + 即时拉取也失败 ⇒ baseScoreLevels() 抛 ConfigServiceError(10007)', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();

    const err = await cache.baseScoreLevels().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigServiceError);
    expect((err as ConfigServiceError).code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);

    cache.onApplicationShutdown();
  });

  it('C4′：拉取成功但表缺失/非法 ⇒ 仍抛 10007（fail-closed，绝不返回空表）', async () => {
    const { client, snapshot } = makeClient();
    // 快照在手、但没有 game.baseScoreLevels（或它不是非空数组）——「读不到 ≠ 没有档位」的红线。
    snapshot.mockResolvedValue(snapshotWith({ 'room.friendRoomEnabled': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    const err = await cache.baseScoreLevels().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigServiceError);
    expect((err as ConfigServiceError).code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);

    cache.onApplicationShutdown();
  });

  it('C4b：缓存有旧值 ⇒ 用旧值、不抛（哪怕此后 client 变红），且不再拉', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValueOnce(snapshotWith({ 'game.baseScoreLevels': LEVELS_A }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    // 此后配置中心挂了：有旧值 ⇒ 一律用旧值（design D2 的失败语义分层）。
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    await expect(cache.baseScoreLevels()).resolves.toEqual(LEVELS_A);
    expect(snapshot).toHaveBeenCalledTimes(1); // 有缓存 ⇒ 不发起即时拉取

    cache.onApplicationShutdown();
  });

  it('频道名逐字：订阅 config:changed（与 config-service 发布侧逐字同名）', () => {
    expect(CONFIG_CHANGED_CHANNEL).toBe('config:changed');
  });

  it('通知 ⇒ 重拉并换缓存（版本不前进也换）；非本频道消息不触发重拉', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValueOnce(
      snapshotWith({ 'game.baseScoreLevels': LEVELS_A, 'room.friendRoomEnabled': false }),
    );
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

    snapshot.mockResolvedValue(
      snapshotWith({ 'game.baseScoreLevels': LEVELS_B, 'room.friendRoomEnabled': true }, 2),
    );
    await handler!('config:changed', JSON.stringify({ keys: ['room.friendRoomEnabled'] }));

    expect(cache.friendRoomEnabled()).toBe(true); // 换缓存生效
    await expect(cache.baseScoreLevels()).resolves.toEqual(LEVELS_B);

    // 别的频道不触发重拉。
    const callsBefore = snapshot.mock.calls.length;
    await handler!('some:other:channel', '{}');
    expect(snapshot.mock.calls.length).toBe(callsBefore);

    cache.onApplicationShutdown();
  });

  it('安全网：CONFIG_SYNC_SAFETY_NET_MS=100 ⇒ 每 100ms 无条件重拉（与推送无关）；关停后停止', async () => {
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '100';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'room.friendRoomEnabled': true }));
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

  it('CONFIG_SYNC_DISABLE_PUSH 非空 ⇒ 不建订阅连接；空串 = 未设 ⇒ 照常订阅（变异开关可控）', async () => {
    process.env.CONFIG_SYNC_DISABLE_PUSH = '1';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'room.friendRoomEnabled': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(redisState.instances).toHaveLength(0); // 未 new Redis、也未 subscribe
    cache.onApplicationShutdown();

    // 正对照：空串（compose 的空默认透传形态）= 未设 ⇒ 恰好建一条订阅连接。
    // 没有这一半，「未建连接」可能只是因为实现根本不订阅（=变异开关不存在）。
    process.env.CONFIG_SYNC_DISABLE_PUSH = '';
    const second = makeClient();
    second.snapshot.mockResolvedValue(snapshotWith({ 'room.friendRoomEnabled': true }));
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
    snapshot.mockResolvedValue(snapshotWith({ 'room.friendRoomEnabled': true }));
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
      .mockImplementation(() => Promise.resolve(snapshotWith({ 'room.friendRoomEnabled': true })));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(2); // 1s 退避后重试（仍失败）
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(3); // 再 1s 后第 3 次 —— 成功
    await cache.waitForFirstSnapshot();
    expect(cache.friendRoomEnabled()).toBe(true);

    // 成功后不再重试：再推 10s（安全网 60s 未到）也不会有第 4 次。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshot).toHaveBeenCalledTimes(3);

    cache.onApplicationShutdown();
  });

  it('常量表与种子同值：三个周期键的默认值 5000/5000/60000', () => {
    expect(CYCLE_MS_DEFAULTS).toEqual({
      'room.matchScanIntervalMs': 5_000,
      'room.autostartIntervalMs': 5_000,
      'room.reapIntervalMs': 60_000,
    });
  });

  it('日志分源（T6 审查 Important-1）：定时器轮 ⇒ timer（每轮独立 id）；订阅回调 ⇒ internal', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({ 'game.baseScoreLevels': LEVELS_A, 'room.friendRoomEnabled': false }),
    );
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

    // 订阅回调 ⇒ internal（内部事件：无客户端请求 ⇒ 不编造 id）。
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

  it('🔴 关停发生在在途拉取期间 ⇒ 之后不再排任何定时器（T6 审查 Important-2）', async () => {
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
      .mockResolvedValueOnce(snapshotWith({ 'room.friendRoomEnabled': true }))
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

/**
 * 一个可由用例放行的挂起 promise（把「一轮在途」钉在精确时刻）。
 * C9 组与「关停闸」组共用（两组的夹具形态是同一个：让第 1 轮挂起、在在途期间做手脚）。
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * **② 金币场 T4**：三个新 getter 的读面（C1/C2/C4 的配置侧单测）。
 *
 * 纪律与 `friendRoomEnabled` 同款：**快照值优先；缺失/非法取代码缺省**——
 *  - `freeRoomEnabled`：缺省 **true**（与种子一致：免费场保持现状开，配置说不清时
 *    不改变现状、不掐服务）；
 *  - `goldRoomEnabled`：缺省 **true**（与种子一致：2026-10-04 用户裁决「金币场默认开」，
 *    原缺省 false/暗上线同款翻转；与 freeRoomEnabled 同一方向）；
 *  - `entryMultiplier`：缺省 **10**，且带**范围哨兵**（越界/非整数 ⇒ 10）——
 *    消费方（门槛的 `baseScore × N` 乘法）必须永远拿到可用的数字。
 */
describe('② T4 新 getter：free / gold 开关与 entryMultiplier（缺省镜像种子 + 范围哨兵）', () => {
  it('快照值生效：三键都按快照原值返回（含客户端与门槛各不相同的一组值）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({
        'room.freeRoomEnabled': false,
        'room.goldRoomEnabled': true,
        'currency.entryMultiplier': 100,
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(cache.freeRoomEnabled()).toBe(false);
    expect(cache.goldRoomEnabled()).toBe(true);
    expect(cache.entryMultiplier()).toBe(100);

    cache.onApplicationShutdown();
  });

  it('空缓存（从未拉到）⇒ 全走种子缺省：free=true / gold=true / entryMultiplier=10', () => {
    const { client } = makeClient();
    const cache = new ConfigCacheService(client);
    // 注意：**不调 onModuleInit** —— 构造完直接读，`snapshot === null` 就是
    // 「配置中心从未拉到过」的形态（不得抛、不得返回 undefined）。
    expect(cache.freeRoomEnabled()).toBe(true); // 与种子一致：免费场保持现状开
    expect(cache.goldRoomEnabled()).toBe(true); // 与种子一致：默认开（2026-10-04 用户裁决）
    expect(cache.entryMultiplier()).toBe(10);
    cache.onApplicationShutdown();
  });

  it('缺失/类型不对 ⇒ 缺省方向不漂移：free 非 boolean ⇒ true；gold 非 boolean ⇒ true', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({
        'room.freeRoomEnabled': 'true' as never, // 字符串（快照损坏/异常写入的形态）
        'room.goldRoomEnabled': 1 as never,
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(cache.freeRoomEnabled()).toBe(true);
    expect(cache.goldRoomEnabled()).toBe(true);

    cache.onApplicationShutdown();
  });

  it('entryMultiplier 的范围哨兵：0 / 101 / 1.5 / 非数 ⇒ 10；边界 1 与 100 原样生效', async () => {
    const { client, snapshot } = makeClient();

    for (const [stored, expected] of [
      [0, 10], // 下越界（0 会让门槛恒真 ⇒ 放行一切，恰是本哨兵要挡的）
      [101, 10], // 上越界
      [1.5, 10], // 非整数
      ['10', 10], // 非数
      [undefined, 10], // 缺键
      [1, 1], // 下边界（parseEntryMultiplier 的合法面内）
      [100, 100], // 上边界
    ] as const) {
      snapshot.mockResolvedValue(
        snapshotWith(stored === undefined ? {} : { 'currency.entryMultiplier': stored as never }),
      );
      const cache = new ConfigCacheService(client);
      cache.onModuleInit();
      await cache.waitForFirstSnapshot();

      expect(cache.entryMultiplier(), `entryMultiplier=${String(stored)} 的读面`).toBe(expected);
      cache.onApplicationShutdown();
    }
  });
});

/**
 * **② 金币场 T5**：`rakePercent` getter（规格 §1.1 第 15 键；设计 D3 的 `floor(g × p / 100)`）。
 *
 * 纪律与 T4 的三个 getter 同款：**快照值优先；缺失/非法取代码缺省**——
 * 默认 **0**（与种子一致：零和起点，抽水是运营开关不是默认行为）；范围哨兵 `0..50`
 * （结算算法必须永远拿到可用整数，越界值绝不漏进 `floor(g × p / 100)`）。
 */
describe('② T5 新 getter：rakePercent（缺省镜像种子 0 + 范围哨兵）', () => {
  it('快照值生效；空缓存（从未拉到）⇒ 0（零和起点）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'currency.rakePercent': 10 }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.rakePercent()).toBe(10);
    cache.onApplicationShutdown();

    const { client: coldClient } = makeClient();
    const cold = new ConfigCacheService(coldClient);
    // 不调 onModuleInit：`snapshot === null` = 配置中心从未拉到过（不得抛、不得 undefined）
    expect(cold.rakePercent()).toBe(0);
    cold.onApplicationShutdown();
  });

  it('范围哨兵：-1 / 51 / 1.5 / 非数 ⇒ 0；边界 0 与 50 原样生效', async () => {
    const { client, snapshot } = makeClient();

    for (const [stored, expected] of [
      [-1, 0], // 下越界（负抽水 = 发钱，恰是本哨兵要挡的）
      [51, 0], // 上越界
      [1.5, 0], // 非整数
      ['10', 0], // 非数
      [undefined, 0], // 缺键
      [0, 0], // 下边界（种子）
      [50, 50], // 上边界（parseRakePercent 的合法面内）
    ] as const) {
      snapshot.mockResolvedValue(
        snapshotWith(stored === undefined ? {} : { 'currency.rakePercent': stored as never }),
      );
      const cache = new ConfigCacheService(client);
      cache.onModuleInit();
      await cache.waitForFirstSnapshot();

      expect(cache.rakePercent(), `rakePercent=${String(stored)} 的读面`).toBe(expected);
      cache.onApplicationShutdown();
    }
  });
});

describe('台费 reader：由 game.baseScoreLevels 派生（fail 方向 = 空表，**绝不抛**）', () => {
  it('快照值生效：entryFeePercent 缺省 = 0、顺序保持', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({
        'game.baseScoreLevels': [
          { name: '休闲场', baseScore: 15, entryFeePercent: 10 },
          { name: '标准场', baseScore: 80 },
        ],
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.entryFeePercents()).toEqual([
      { baseScore: 15, percent: 10 },
      { baseScore: 80, percent: 0 },
    ]);
    cache.onApplicationShutdown();
  });

  it('🔴 上限 100 在读侧合法：entryFeePercent = 100 ⇒ percent 100', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({
        'game.baseScoreLevels': [{ name: '休闲场', baseScore: 15, entryFeePercent: 100 }],
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.entryFeePercents()).toEqual([{ baseScore: 15, percent: 100 }]);
    cache.onApplicationShutdown();
  });

  it('档位项缺 entryFeePercent ⇒ 与档位等长的全 0 行（不是 []；旧键已删）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({
        'game.baseScoreLevels': [
          { name: '休闲场', baseScore: 15 },
          { name: '标准场', baseScore: 80 },
        ],
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.entryFeePercents()).toEqual([
      { baseScore: 15, percent: 0 },
      { baseScore: 80, percent: 0 },
    ]);
    cache.onApplicationShutdown();
  });

  it('空缓存（从未拉到）⇒ []；档位表缺键/非数组/坏元素 ⇒ [] 且不抛；baseScoreLevels() 仍 fail-closed', async () => {
    const { client, snapshot } = makeClient();

    const { client: coldClient } = makeClient();
    const cold = new ConfigCacheService(coldClient);
    // 不调 onModuleInit：`snapshot === null` = 配置中心从未拉到过（不得抛、不得 undefined）
    expect(cold.entryFeePercents()).toEqual([]);
    cold.onApplicationShutdown();

    for (const stored of [
      undefined, // 缺键
      { x: 1 }, // 非数组
      'x', // 非数组
      [], // 空表（parser 拒绝）
      [{ name: 'X', baseScore: 15, entryFeePercent: 101 }], // 越界（0–100 之外）
      [{ name: 'X', baseScore: 15, entryFeePercent: 1.5 }], // 非整数
      [{ name: 'X', baseScore: 0 }], // baseScore 非正
    ] as const) {
      snapshot.mockResolvedValue(
        snapshotWith(stored === undefined ? {} : { 'game.baseScoreLevels': stored as never }),
      );
      const cache = new ConfigCacheService(client);
      cache.onModuleInit();
      await cache.waitForFirstSnapshot();

      expect(
        cache.entryFeePercents(),
        `baseScoreLevels=${JSON.stringify(stored)} 的读面`,
      ).toEqual([]);
      cache.onApplicationShutdown();
    }

    // 反向对照（C5 明文）：baseScoreLevels() 的 fail-closed 语义未被动过
    snapshot.mockResolvedValue(snapshotWith({}));
    const cache2 = new ConfigCacheService(client);
    cache2.onModuleInit();
    await cache2.waitForFirstSnapshot();
    await expect(cache2.baseScoreLevels()).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
    cache2.onApplicationShutdown();
  });
});

/**
 * **风控 T2**：两个谓词开关 getter（风控规格 §2.1 第 18/19 键；§2.4-2 启停来自 config-cache）。
 *
 * 纪律与兄弟 getter 同款：**快照值优先；缺失/非法取代码缺省** —— 默认 **false**
 *（谓词**默认关**：生产种子态；配置说不清时不开启谓词面 —— 缺省即生产现状）。
 */
describe('风控 T2 新 getter：riskPredicateSameDevice / riskPredicateSameIp（缺省 false）', () => {
  it('快照值生效：两键各自按快照原值返回（含一开一关的错位组合）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({
        'risk.predicate.sameDevice': true,
        'risk.predicate.sameIp': false,
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(cache.riskPredicateSameDevice()).toBe(true);
    expect(cache.riskPredicateSameIp()).toBe(false);

    cache.onApplicationShutdown();
  });

  it('空缓存（从未拉到）/ 缺键 / 非 boolean ⇒ 全走 false（缺省方向 = 谓词默认关）', async () => {
    const { client } = makeClient();
    const cold = new ConfigCacheService(client);
    // 不调 onModuleInit：`snapshot === null` = 配置中心从未拉到过（不得抛、不得 undefined）
    expect(cold.riskPredicateSameDevice()).toBe(false);
    expect(cold.riskPredicateSameIp()).toBe(false);
    cold.onApplicationShutdown();

    const { client: client2, snapshot: snapshot2 } = makeClient();
    snapshot2.mockResolvedValue(
      snapshotWith({
        'risk.predicate.sameDevice': 'true' as never, // 字符串（快照损坏/异常写入的形态）
        'risk.predicate.sameIp': 1 as never,
      }),
    );
    const cache = new ConfigCacheService(client2);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(cache.riskPredicateSameDevice()).toBe(false);
    expect(cache.riskPredicateSameIp()).toBe(false);

    cache.onApplicationShutdown();
  });
});

/**
 * **机器人补位开关片**：三个新 getter（第 45/46/47 键）。
 *
 *  - `freeBotFillEnabled` / `goldBotFillEnabled`：缺省 **true**（= 种子 = 现状；
 *    配置说不清时绝不改变「缺人补机器人」的既有行为）；
 *  - `matchNoBotMaxWaitMs`：缺省 **300000**（5 分钟），范围哨兵 **30000..1800000**
 *    （与 protocol 的 parseNoBotMaxWaitMs 同边界），非整数/越界/非数 ⇒ 缺省。
 */
describe('机器人补位开关片 getter：free/gold 开关缺省 true、maxWaitMs 缺省 300000 + 范围哨兵', () => {
  it('快照值生效：三键都按快照原值返回（含两开关都关的形态）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({
        'room.freeBotFillEnabled': false,
        'room.goldBotFillEnabled': false,
        'room.matchNoBotMaxWaitMs': 60_000,
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(cache.freeBotFillEnabled()).toBe(false);
    expect(cache.goldBotFillEnabled()).toBe(false);
    expect(cache.matchNoBotMaxWaitMs()).toBe(60_000);

    cache.onApplicationShutdown();
  });

  it('空缓存（从未拉到）⇒ free=true / gold=true / maxWaitMs=300000（缺省 = 现状 + 种子）', () => {
    const { client } = makeClient();
    const cache = new ConfigCacheService(client);
    // 不调 onModuleInit：snapshot === null = 配置中心从未拉到过（不得抛、不得 undefined）。
    expect(cache.freeBotFillEnabled()).toBe(true);
    expect(cache.goldBotFillEnabled()).toBe(true);
    expect(cache.matchNoBotMaxWaitMs()).toBe(300_000);
    cache.onApplicationShutdown();
  });

  it('两开关非 boolean ⇒ true；maxWaitMs 哨兵：29999/1800001/1.5/非数 ⇒ 300000', async () => {
    const { client: bClient, snapshot: bSnap } = makeClient();
    bSnap.mockResolvedValue(
      snapshotWith({
        'room.freeBotFillEnabled': 'false' as never, // 字符串（快照损坏形态）
        'room.goldBotFillEnabled': 0 as never,
      }),
    );
    const boolCache = new ConfigCacheService(bClient);
    boolCache.onModuleInit();
    await boolCache.waitForFirstSnapshot();
    expect(boolCache.freeBotFillEnabled()).toBe(true);
    expect(boolCache.goldBotFillEnabled()).toBe(true);
    boolCache.onApplicationShutdown();

    const { client, snapshot } = makeClient();
    for (const [stored, expected] of [
      [29_999, 300_000], // 下越界（< 30s 的上限无意义）
      [1_800_001, 300_000], // 上越界（> 30min）
      [1.5, 300_000], // 非整数
      ['300000', 300_000], // 非数
      [undefined, 300_000], // 缺键
      [30_000, 30_000], // 下边界
      [1_800_000, 1_800_000], // 上边界
    ] as const) {
      snapshot.mockResolvedValue(
        snapshotWith(stored === undefined ? {} : { 'room.matchNoBotMaxWaitMs': stored as never }),
      );
      const cache = new ConfigCacheService(client);
      cache.onModuleInit();
      await cache.waitForFirstSnapshot();
      expect(cache.matchNoBotMaxWaitMs(), `matchNoBotMaxWaitMs=${String(stored)} 的读面`).toBe(expected);
      cache.onApplicationShutdown();
    }
  });
});

/**
 * **C9（片规格 §4 的 C9 行 / Task 7）**：三处循环的**自重排口径** ——
 *
 *   改小后**第 N+1 轮触发点 = 第 N 轮结束 + 新值**（当前一轮按旧值跑完）。
 *
 * 精确断言点（写进用例名）：先让第 1 轮**在途**（工作方法返回挂起 promise），在途期间改小
 * 周期，放行第 1 轮 ⇒ 第 2 轮必须落在「第 1 轮结束 + 100ms」而不是「+1000ms」；
 * 边界两侧各断言一次（+99ms 不得触发、+100ms 必须触发）。
 * ⚠️ **改小必须发生在第 1 轮结束之前**（模板原文把改值放在 `advance(1000)` 之后 —— 那时
 * 第 2 轮**已经**按旧值排好了，改值对第 2 轮不生效，断言会落在错误的点上）；规格原文的
 * 场景本来就是「在途一轮按旧值跑完」。
 *
 * 判别力：`setInterval` 未退役的实现下周期改不动（第 2 轮永远只有旧节拍）；
 * 「排下一轮时现读周期」写错成「启动时读一次存起来」的实现同样红。
 * 三处各钉**自己那个键**（copy-paste 读错键 = 改了不生效，且单看别处发现不了）。
 */
describe('C9：三处循环的自重排（match / autostart / reaper）', () => {
  let captured: ReturnType<typeof createCapturingSink>;

  beforeEach(() => {
    // 循环起手会各打一条 log —— 装 sink 保持测试输出干净（本文件上半部分的同一纪律）。
    captured = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'room-service' }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    Logger.overrideLogger(new Logger()); // M4：进程级开关，用后必须还原
    vi.useRealTimers();
  });

  it('C9 · reap：改小 1000→100 后第 2 轮触发点 = 第 1 轮结束 + 100（+99 不触发）', async () => {
    const round = deferred<unknown[]>();
    const listForReap = vi.fn(() => round.promise);
    const rooms = { listForReap } as unknown as RoomsService;
    const cache = makeConfigCache();
    cache.cycleMs.mockReturnValue(1_000);
    const reaper = new RoomsReaperTask(rooms, asConfigCache(cache));

    reaper.startReapLoop(); // 第 1 轮排在 t=1000（旧值）
    await vi.advanceTimersByTimeAsync(1_000); // 第 1 轮开始（在途：listForReap 未回）
    expect(listForReap).toHaveBeenCalledTimes(1);

    cache.cycleMs.mockReturnValue(100); // 一轮**在途期间**改小
    round.resolve([]); // 第 1 轮结束
    await vi.advanceTimersByTimeAsync(0); // flush：其后按新值排下一轮

    await vi.advanceTimersByTimeAsync(99);
    expect(listForReap, '第 1 轮结束 + 99ms：第 2 轮还没到点').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      listForReap,
      '第 2 轮触发点 = 第 1 轮结束 + 100（新值）—— setInterval 实现下这里是恒 1',
    ).toHaveBeenCalledTimes(2);
    expect(cache.cycleMs, '循环必须读自己那个键').toHaveBeenCalledWith('room.reapIntervalMs');

    reaper.onApplicationShutdown();
  });

  it('C9 · autostart：改小 1000→100 后第 2 轮触发点 = 第 1 轮结束 + 100（+99 不触发）', async () => {
    const round = deferred<unknown[]>();
    const findAll = vi.fn(() => round.promise);
    const rooms = { findAll } as unknown as RoomsService;
    const cache = makeConfigCache();
    cache.cycleMs.mockReturnValue(1_000);
    const task = new RoomsAutostartTask(rooms, {} as never, asConfigCache(cache));

    task.startScanLoop(); // 第 1 轮排在 t=1000（旧值）
    await vi.advanceTimersByTimeAsync(1_000); // 第 1 轮开始（在途）
    expect(findAll).toHaveBeenCalledTimes(1);

    cache.cycleMs.mockReturnValue(100); // 在途期间改小
    round.resolve([]); // 第 1 轮结束
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(99);
    expect(findAll, '第 1 轮结束 + 99ms：第 2 轮还没到点').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      findAll,
      '第 2 轮触发点 = 第 1 轮结束 + 100（新值）—— setInterval 实现下这里是恒 1',
    ).toHaveBeenCalledTimes(2);
    expect(cache.cycleMs, '循环必须读自己那个键').toHaveBeenCalledWith(
      'room.autostartIntervalMs',
    );

    task.onApplicationShutdown();
  });

  it('C9 · match：改小 1000→100 后第 2 轮触发点 = 第 1 轮结束 + 100（+99 不触发）', async () => {
    const round = deferred<[string, string[]]>();
    const scan = vi.fn(() => round.promise);
    const cache = makeConfigCache();
    cache.cycleMs.mockReturnValue(1_000);
    const match = new MatchService(
      { scan } as never,
      {} as never,
      {} as never,
      asConfigCache(cache),
      {} as never,
    );

    match.startMatchingLoop(); // 第 1 轮排在 t=1000（旧值）
    await vi.advanceTimersByTimeAsync(1_000); // 第 1 轮开始（在途：scan 未回）
    expect(scan, '一轮 = 一次队列键扫描（listQueueKeys 的第一跳）').toHaveBeenCalledTimes(1);

    cache.cycleMs.mockReturnValue(100); // 在途期间改小
    round.resolve(['0', []]); // cursor '0' ⇒ 一轮结束（无队列）
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(99);
    expect(scan, '第 1 轮结束 + 99ms：第 2 轮还没到点').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      scan,
      '第 2 轮触发点 = 第 1 轮结束 + 100（新值）—— setInterval 实现下这里是恒 1',
    ).toHaveBeenCalledTimes(2);
    expect(cache.cycleMs, '循环必须读自己那个键').toHaveBeenCalledWith('room.matchScanIntervalMs');

    await match.onApplicationShutdown();
  });
});

/**
 * **关停闸（T7 修复轮 · 审查 Important-1）**：三处循环与 `ConfigCacheService` 同一缺陷
 * 形状 —— **第 1 轮在途时关停** ⇒ 迟到的 `.finally` 回执**不得**再排下一轮（否则
 * `clearTimeout` 只清得住「已存在」的那一个，循环在关停后「复活」：测试进程/容器会看到
 * 永不停止的扫描）。
 *
 * 🩸 为什么必须有这一组：修复轮实测——**把三处闸的 `if (!this.shuttingDown)` 全删掉，
 * 362 条全绿** ⇒ 闸的行为没有判据兜着（「修了但可以被下一步改回去」）。本组即那条判据；
 * 判据形态照 `ConfigCacheService` 的同款测试（本文件上半部分「关停发生在在途拉取期间」）：
 *  ① 挂起第 1 轮 → **在途期间关停** → 放行 → 断言**定时器引用为 null**
 *    （机械形态：闸没了这里会非 null）；
 *  ② 再推进 10 个周期 ⇒ 工作方法**不得再被调**（行为形态：复活就会再调）。
 * 两半缺一不可：只留 ② 时「排了又被别处清掉」会漏过；只留 ① 时内部字段断言可能被
 * 无关的实现细节带偏。三条各钉一处循环（copy-paste 漏改一处时那条当场红）。
 */
describe('关停闸：第 1 轮在途时关停 ⇒ 放行后不再排下一轮（三处循环）', () => {
  let captured: ReturnType<typeof createCapturingSink>;

  beforeEach(() => {
    captured = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'room-service' }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    Logger.overrideLogger(new Logger()); // M4：进程级开关，用后必须还原
    vi.useRealTimers();
  });

  it('关停闸 · reap：第 1 轮在途时关停 ⇒ 迟到回执不再排定时器', async () => {
    const round = deferred<unknown[]>();
    const listForReap = vi.fn(() => round.promise);
    const rooms = { listForReap } as unknown as RoomsService;
    const cache = makeConfigCache();
    cache.cycleMs.mockReturnValue(1_000);
    const reaper = new RoomsReaperTask(rooms, asConfigCache(cache));

    reaper.startReapLoop(); // 第 1 轮排在 t=1000
    await vi.advanceTimersByTimeAsync(1_000); // 第 1 轮开始（在途：listForReap 未回）
    expect(listForReap, '反空测：第 1 轮必须真的在途').toHaveBeenCalledTimes(1);

    reaper.onApplicationShutdown(); // 关停发生在在途期间
    round.resolve([]); // 迟到的回执（第 1 轮结束）
    await vi.advanceTimersByTimeAsync(0); // flush：无闸时这条回执会在此**复活**循环

    expect(
      (reaper as unknown as { timer: unknown }).timer,
      '关停后不得再排定时器（闸被删掉时这里会非 null）',
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listForReap, '放行后不得再扫（无复活循环）').toHaveBeenCalledTimes(1);
  });

  it('关停闸 · autostart：第 1 轮在途时关停 ⇒ 迟到回执不再排定时器', async () => {
    const round = deferred<unknown[]>();
    const findAll = vi.fn(() => round.promise);
    const rooms = { findAll } as unknown as RoomsService;
    const cache = makeConfigCache();
    cache.cycleMs.mockReturnValue(1_000);
    const task = new RoomsAutostartTask(rooms, {} as never, asConfigCache(cache));

    task.startScanLoop(); // 第 1 轮排在 t=1000
    await vi.advanceTimersByTimeAsync(1_000); // 第 1 轮开始（在途）
    expect(findAll, '反空测：第 1 轮必须真的在途').toHaveBeenCalledTimes(1);

    task.onApplicationShutdown(); // 在途期间关停
    round.resolve([]); // 迟到的回执
    await vi.advanceTimersByTimeAsync(0);

    expect(
      (task as unknown as { timer: unknown }).timer,
      '关停后不得再排定时器（闸被删掉时这里会非 null）',
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(findAll, '放行后不得再扫（无复活循环）').toHaveBeenCalledTimes(1);
  });

  it('关停闸 · match：第 1 轮在途时关停 ⇒ 迟到回执不再排定时器', async () => {
    const round = deferred<[string, string[]]>();
    const scan = vi.fn(() => round.promise);
    const cache = makeConfigCache();
    cache.cycleMs.mockReturnValue(1_000);
    const match = new MatchService(
      { scan } as never,
      {} as never,
      {} as never,
      asConfigCache(cache),
      {} as never,
    );

    match.startMatchingLoop(); // 第 1 轮排在 t=1000
    await vi.advanceTimersByTimeAsync(1_000); // 第 1 轮开始（在途：scan 未回）
    expect(scan, '反空测：第 1 轮必须真的在途').toHaveBeenCalledTimes(1);

    await match.onApplicationShutdown(); // 在途期间关停（本方法 async，等它落地）
    round.resolve(['0', []]); // 迟到的回执（cursor '0' ⇒ 一轮结束）
    await vi.advanceTimersByTimeAsync(0);

    expect(
      (match as unknown as { scanTimer: unknown }).scanTimer,
      '关停后不得再排定时器（闸被删掉时这里会非 null）',
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scan, '放行后不得再扫（无复活循环）').toHaveBeenCalledTimes(1);
  });
});

describe('记牌器收费片 getter：cardCounterEnabled / cardCounterPrices（缺省 false / 10/100）', () => {
  it('enabled：快照 true/false 原样；缺键/坏值/空缓存 ⇒ false', async () => {
    for (const value of [true, false]) {
      const { client, snapshot } = makeClient();
      snapshot.mockResolvedValue(snapshotWith({ 'game.cardCounterEnabled': value }));
      const cache = new ConfigCacheService(client);
      cache.onModuleInit();
      await cache.waitForFirstSnapshot();
      expect(cache.cardCounterEnabled()).toBe(value);
      cache.onApplicationShutdown();
    }

    for (const value of ['true', 1, 0, null] as const) {
      const { client, snapshot } = makeClient();
      snapshot.mockResolvedValue(snapshotWith({ 'game.cardCounterEnabled': value }));
      const cache = new ConfigCacheService(client);
      cache.onModuleInit();
      await cache.waitForFirstSnapshot();
      expect(cache.cardCounterEnabled(), `值 ${JSON.stringify(value)}`).toBe(false);
      cache.onApplicationShutdown();
    }

    const { client: coldClient } = makeClient();
    const cold = new ConfigCacheService(coldClient);
    expect(cold.cardCounterEnabled()).toBe(false);
    cold.onApplicationShutdown();
  });

  it('prices：正常值/0 透传；缺键/坏值/越界 ⇒ 10/100；空缓存 ⇒ 10/100', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({
        'game.cardCounterPricePerGameCoins': 25,
        'game.cardCounterPricePerHourCoins': 250,
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.cardCounterPrices()).toEqual({ perGame: 25, perHour: 250 });
    cache.onApplicationShutdown();

    const { client: zeroClient, snapshot: zeroSnapshot } = makeClient();
    zeroSnapshot.mockResolvedValue(
      snapshotWith({
        'game.cardCounterPricePerGameCoins': 0,
        'game.cardCounterPricePerHourCoins': 0,
      }),
    );
    const zero = new ConfigCacheService(zeroClient);
    zero.onModuleInit();
    await zero.waitForFirstSnapshot();
    expect(zero.cardCounterPrices()).toEqual({ perGame: 0, perHour: 0 });
    zero.onApplicationShutdown();

    for (const value of ['10', -1, 1_000_001, 1.5, true, null] as const) {
      const { client: badClient, snapshot: badSnapshot } = makeClient();
      badSnapshot.mockResolvedValue(
        snapshotWith({
          'game.cardCounterPricePerGameCoins': value,
          'game.cardCounterPricePerHourCoins': value,
        }),
      );
      const bad = new ConfigCacheService(badClient);
      bad.onModuleInit();
      await bad.waitForFirstSnapshot();
      expect(bad.cardCounterPrices(), `值 ${JSON.stringify(value)}`).toEqual({
        perGame: 10,
        perHour: 100,
      });
      bad.onApplicationShutdown();
    }

    const { client: coldClient } = makeClient();
    const cold = new ConfigCacheService(coldClient);
    expect(cold.cardCounterPrices()).toEqual({ perGame: 10, perHour: 100 });
    cold.onApplicationShutdown();
  });
});

/**
 * 多玩法配置（Task 2.2 / spec §4.7）：按玩法取档位/台费、组装 pdk 规则快照、玩法开关。
 *
 * ⚠️ 这里测的是**读侧**：写入侧（config-service 种子）在 Task 5.1；缺键时的默认值必须
 * 与 spec §4.7.1 的种子一致（本文件直接引用 `DEFAULT_PDK_RULES`，不抄第二份）。
 */
describe('ConfigCacheService：多玩法配置（Task 2.2）', () => {
  const PDK_LEVELS = [
    { name: '休闲场', baseScore: 15, entryFeePercent: 2 },
    { name: '标准场', baseScore: 80, entryFeePercent: 3 },
  ];

  async function bootCache(config: Parameters<typeof snapshotWith>[0]): Promise<ConfigCacheService> {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith(config));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    return cache;
  }

  it('baseScoreLevels(gameType)：斗地主读旧键、跑得快读 game.levels.paodekuai（互不串）', async () => {
    const cache = await bootCache({
      'game.baseScoreLevels': LEVELS_A,
      'game.levels.paodekuai': PDK_LEVELS,
    });

    await expect(cache.baseScoreLevels()).resolves.toEqual(LEVELS_A);
    await expect(cache.baseScoreLevels('doudizhu')).resolves.toEqual(LEVELS_A);
    await expect(cache.baseScoreLevels('paodekuai')).resolves.toEqual(PDK_LEVELS);

    cache.onApplicationShutdown();
  });

  it('跑得快档位缺失 ⇒ 10007（fail-closed；不得回落斗地主档位）', async () => {
    const cache = await bootCache({ 'game.baseScoreLevels': LEVELS_A });

    const err = await cache.baseScoreLevels('paodekuai').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigServiceError);
    expect((err as ConfigServiceError).code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);

    cache.onApplicationShutdown();
  });

  it('entryFeePercents(gameType) 按各自档位表派生（斗地主默认参数不变）', async () => {
    const cache = await bootCache({
      'game.baseScoreLevels': [{ name: '休闲场', baseScore: 15, entryFeePercent: 10 }],
      'game.levels.paodekuai': PDK_LEVELS,
    });

    expect(cache.entryFeePercents()).toEqual([{ baseScore: 15, percent: 10 }]);
    expect(cache.entryFeePercents('doudizhu')).toEqual([{ baseScore: 15, percent: 10 }]);
    expect(cache.entryFeePercents('paodekuai')).toEqual([
      { baseScore: 15, percent: 2 },
      { baseScore: 80, percent: 3 },
    ]);

    cache.onApplicationShutdown();
  });

  it('pdkRules()：缺键取默认值（= spec §4.7.1 种子）；存在则读快照', async () => {
    const defaults = await bootCache({});
    expect(defaults.pdkRules()).toEqual(DEFAULT_PDK_RULES);
    defaults.onApplicationShutdown();

    const overridden = await bootCache({
      'game.paodekuai.bareTrioEnabled': false,
      'game.paodekuai.trioWithPairEnabled': true,
      'game.paodekuai.airplaneWings': 'singles',
      'game.paodekuai.multiplierCap': 32,
      'game.paodekuai.baobenEnabled': false,
    });
    expect(overridden.pdkRules()).toEqual({
      ...DEFAULT_PDK_RULES,
      bareTrioEnabled: false,
      trioWithPairEnabled: true,
      airplaneWings: 'singles',
      multiplierCap: 32,
      baobenEnabled: false,
    });
    overridden.onApplicationShutdown();
  });

  it('pdkRules()：非法值**抛错**（开局前暴露，不得静默回落默认）', async () => {
    const cases: Array<[string, unknown]> = [
      ['game.paodekuai.multiplierCap', 0],
      ['game.paodekuai.airplaneWings', 'wings'],
      ['game.paodekuai.bareTrioEnabled', 'yes'],
    ];
    for (const [key, value] of cases) {
      const cache = await bootCache({ [key]: value } as never);
      expect(() => cache.pdkRules(), `${key}=${JSON.stringify(value)}`).toThrow();
      cache.onApplicationShutdown();
    }
  });

  it('玩法开关缺省 false（暗上线）；显式 true 生效', async () => {
    const off = await bootCache({});
    expect(off.paodekuaiEnabled()).toBe(false);
    expect(off.paodekuaiNonThreePlayerEnabled()).toBe(false);
    expect(off.doudizhuEnabled()).toBe(true); // 缺键 ⇒ true（旧库兼容）
    expect(off.gameEnabled('doudizhu')).toBe(true);
    expect(off.gameEnabled('paodekuai')).toBe(false);
    off.onApplicationShutdown();

    const ddzOff = await bootCache({ 'game.doudizhu.enabled': false });
    expect(ddzOff.doudizhuEnabled()).toBe(false);
    expect(ddzOff.gameEnabled('doudizhu')).toBe(false);
    ddzOff.onApplicationShutdown();

    const on = await bootCache({
      'game.paodekuai.enabled': true,
      'game.paodekuai.nonThreePlayerEnabled': true,
    });
    expect(on.paodekuaiEnabled()).toBe(true);
    expect(on.paodekuaiNonThreePlayerEnabled()).toBe(true);
    expect(on.gameEnabled('paodekuai')).toBe(true);
    on.onApplicationShutdown();
  });

  it('supportsRoomPlayerCount：pdk nonThree=false 收窄为 [3]；开后可 2/4；ddz 恒 3', async () => {
    const narrow = await bootCache({ 'game.paodekuai.enabled': true });
    expect(narrow.supportsRoomPlayerCount('paodekuai', 3)).toBe(true);
    expect(narrow.supportsRoomPlayerCount('paodekuai', 2)).toBe(false);
    expect(narrow.supportsRoomPlayerCount('paodekuai', 4)).toBe(false);
    expect(narrow.supportsRoomPlayerCount('doudizhu', 3)).toBe(true);
    expect(narrow.supportsRoomPlayerCount('doudizhu', 2)).toBe(false);
    expect(narrow.supportsRoomPlayerCount('doudizhu', 4)).toBe(false);
    narrow.onApplicationShutdown();

    const wide = await bootCache({ 'game.paodekuai.nonThreePlayerEnabled': true });
    expect(wide.supportsRoomPlayerCount('paodekuai', 2)).toBe(true);
    expect(wide.supportsRoomPlayerCount('paodekuai', 3)).toBe(true);
    expect(wide.supportsRoomPlayerCount('paodekuai', 4)).toBe(true);
    expect(wide.supportsRoomPlayerCount('paodekuai', 5)).toBe(false);
    wide.onApplicationShutdown();
  });
});

describe('配置平行化（2026-10-24）：按玩法读取与旧键回退', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function cacheWith(
    over: Partial<Record<ConfigKey, unknown>>,
  ): Promise<ConfigCacheService> {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith(over));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    return cache;
  }

  it('场次/好友房/补位：新键优先、缺失回退旧键、跑得快缺省保守', async () => {
    const cache = await cacheWith({
      'game.doudizhu.freeRoomEnabled': false,
      'room.freeRoomEnabled': true,
      'game.paodekuai.freeRoomEnabled': false,
      'game.paodekuai.goldRoomEnabled': true,
      'room.goldRoomEnabled': true,
      'game.paodekuai.friendRoomEnabled': false,
      'room.friendRoomEnabled': true,
      'game.paodekuai.freeBotFillEnabled': false,
      'room.freeBotFillEnabled': true,
    });
    try {
      expect(cache.freeRoomEnabled('doudizhu')).toBe(false); // 新键覆盖旧键
      expect(cache.freeRoomEnabled('paodekuai')).toBe(false);
      expect(cache.goldRoomEnabled('doudizhu')).toBe(true); // 新键缺失 ⇒ 旧键 true
      expect(cache.goldRoomEnabled('paodekuai')).toBe(true);
      expect(cache.friendRoomEnabled('doudizhu')).toBe(true); // 新键缺失 ⇒ 旧键 true
      expect(cache.friendRoomEnabled('paodekuai')).toBe(false);
      expect(cache.freeBotFillEnabled('paodekuai')).toBe(false);
      expect(cache.botFillEnabled('random', 'paodekuai')).toBe(false);
      expect(cache.botFillEnabled('practice', 'paodekuai')).toBe(true);
    } finally {
      cache.onApplicationShutdown();
    }
  });

  it('跑得快缺新键 ⇒ 自己的默认，不得回退旧全局金币场 true', async () => {
    const cache = await cacheWith({
      'room.goldRoomEnabled': true,
      'room.freeRoomEnabled': true,
      'room.friendRoomEnabled': true,
    });
    try {
      expect(cache.goldRoomEnabled('paodekuai')).toBe(false);
      expect(cache.friendRoomEnabled('paodekuai')).toBe(false);
      expect(cache.freeRoomEnabled('paodekuai')).toBe(true);
    } finally {
      cache.onApplicationShutdown();
    }
  });

  it('全缺省：斗地主沿用种子、跑得快金币场默认关', async () => {
    const cache = await cacheWith({ 'room.matchScanIntervalMs': 5000 });
    try {
      expect(cache.freeRoomEnabled('doudizhu')).toBe(true);
      expect(cache.goldRoomEnabled('doudizhu')).toBe(true);
      expect(cache.friendRoomEnabled('doudizhu')).toBe(false);
      expect(cache.freeRoomEnabled('paodekuai')).toBe(true);
      expect(cache.goldRoomEnabled('paodekuai')).toBe(false);
      expect(cache.friendRoomEnabled('paodekuai')).toBe(false);
      expect(cache.entryMultiplier('doudizhu')).toBe(10);
      expect(cache.entryMultiplier('paodekuai')).toBe(10);
      expect(cache.rakePercent('doudizhu')).toBe(0);
      expect(cache.rakePercent('paodekuai')).toBe(0);
    } finally {
      cache.onApplicationShutdown();
    }
  });

  it('档位表：新键优先；新键缺失回退旧键；新键存在但非法 ⇒ fail-closed 不回退', async () => {
    const valid = await cacheWith({
      'game.levels.doudizhu': LEVELS_B,
      'game.baseScoreLevels': LEVELS_A,
    });
    try {
      await expect(valid.baseScoreLevels('doudizhu')).resolves.toEqual(LEVELS_B);
      expect(valid.entryFeePercents('doudizhu')).toHaveLength(3);
    } finally {
      valid.onApplicationShutdown();
    }

    const fallback = await cacheWith({ 'game.baseScoreLevels': LEVELS_A });
    try {
      await expect(fallback.baseScoreLevels('doudizhu')).resolves.toEqual(LEVELS_A);
      expect(fallback.entryFeePercents('doudizhu')).toHaveLength(2);
    } finally {
      fallback.onApplicationShutdown();
    }

    const badNew = await cacheWith({
      'game.levels.doudizhu': [],
      'game.baseScoreLevels': LEVELS_A,
    });
    try {
      await expect(badNew.baseScoreLevels('doudizhu')).rejects.toBeInstanceOf(ConfigServiceError);
      expect(badNew.entryFeePercents('doudizhu')).toEqual([]);
    } finally {
      badNew.onApplicationShutdown();
    }
  });

  it('门槛/抽水：按玩法读；坏新值不回退旧键', async () => {
    const cache = await cacheWith({
      'game.doudizhu.entryMultiplier': 20,
      'currency.entryMultiplier': 10,
      'game.paodekuai.entryMultiplier': 30,
      'game.doudizhu.rakePercent': 5,
    });
    try {
      expect(cache.entryMultiplier('doudizhu')).toBe(20);
      expect(cache.entryMultiplier('paodekuai')).toBe(30);
      expect(cache.rakePercent('doudizhu')).toBe(5);
      expect(cache.rakePercent('paodekuai')).toBe(0);
    } finally {
      cache.onApplicationShutdown();
    }

    const bad = await cacheWith({
      'game.doudizhu.entryMultiplier': 0,
      'currency.entryMultiplier': 7,
    });
    try {
      expect(bad.entryMultiplier('doudizhu')).toBe(10); // 坏新值 ⇒ 代码默认，不回退 7
    } finally {
      bad.onApplicationShutdown();
    }
  });

  it('记牌器：新键优先、缺失回退旧键', async () => {
    const cache = await cacheWith({
      'game.doudizhu.cardCounterEnabled': false,
      'game.cardCounterEnabled': true,
      'game.doudizhu.cardCounterPricePerGameCoins': 20,
      'game.cardCounterPricePerGameCoins': 10,
      'game.doudizhu.cardCounterPricePerHourCoins': 200,
      'game.cardCounterPricePerHourCoins': 100,
    });
    try {
      expect(cache.cardCounterEnabled()).toBe(false);
      expect(cache.cardCounterPrices()).toEqual({ perGame: 20, perHour: 200 });
    } finally {
      cache.onApplicationShutdown();
    }

    const fallback = await cacheWith({
      'game.cardCounterEnabled': true,
      'game.cardCounterPricePerGameCoins': 10,
      'game.cardCounterPricePerHourCoins': 100,
    });
    try {
      expect(fallback.cardCounterEnabled()).toBe(true);
      expect(fallback.cardCounterPrices()).toEqual({ perGame: 10, perHour: 100 });
    } finally {
      fallback.onApplicationShutdown();
    }
  });
});
