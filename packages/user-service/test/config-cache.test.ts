/**
 * `ConfigCacheService`（user-service）的行为面 —— 记录片 T7 / 设计 D5：
 * 本服务的**第一条配置消费链**（读 `record.retentionDays`）。
 *
 * 克隆自 room-service 的同名测试（片⑦ T6 成例），保留其覆盖骨架：三件套行为
 * （启动退避拉取 / 专用连接订阅 `config:changed` / 60s 安全网）+ 失败语义（热项取默认值）
 * + 日志分源（R1107）+ 关停闸（T6 审查 Important-2）；本服务的差异只有一条读数面 ——
 * `retentionDays()`（缓存缺省回落 **365**，规格 §2.4 种子；写死范围 1 ≤ n ≤ 3650）。
 *
 * ─── 夹具（照 room 成例）────────────────────────────────────────────────
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
  RETENTION_DAYS_DEFAULT,
  SIGNUP_GRANT_DEFAULT,
  RISK_WIN_RATE_THRESHOLD_DEFAULT,
  RISK_MIN_GAMES_DEFAULT,
  RISK_DEVICE_LIMIT_DEFAULT,
  RISK_DEVICE_WINDOW_DAYS_DEFAULT,
  RISK_AUTO_THROTTLE_DEFAULT,
  RISK_DEVICE_RETENTION_DAYS_DEFAULT,
  RISK_SCAN_DEFAULT_INTERVAL_MS,
  RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS,
  RECORDS_CLEANUP_DEFAULT_INTERVAL_MS,
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

/** 造一个 `ConfigSnapshotResponse`（只含传入的键；`config` 的完整一百键由 config-service 保证）。 */
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

describe('ConfigCacheService（记录片 T7：user-service 首条配置消费链）', () => {
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
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'user-service' }));
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

  it('C8 半边 · 缺省回落 365：拉取失败 + 空缓存 ⇒ 不阻塞就绪、retentionDays()=365、1s 退避重试、空窗 WARN 只一次', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);

    // 🔴 不阻塞就绪：同步返回（若实现改成 await 首次拉取，这里当场红）。
    expect(cache.onModuleInit()).toBeUndefined();
    // 规格 §2.4：种子 365；「拿不到」时取**代码默认值**（配置中心挂了不得停止服务）。
    expect(RETENTION_DAYS_DEFAULT).toBe(365);
    expect(cache.retentionDays()).toBe(365);

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
    expect(cache.retentionDays()).toBe(365);

    cache.onApplicationShutdown();
  });

  it('快照值生效：合法整数 1 / 30 / 3650 逐值 = 规格 §2.4 的写死范围 1 ≤ n ≤ 3650', async () => {
    for (const value of [1, 30, 3650]) {
      const cache = await cachedWith({ 'record.retentionDays': value });
      expect(cache.retentionDays()).toBe(value);
      cache.onApplicationShutdown();
    }
  });

  it('缺省回落：键缺失 / 类型漂移 / 越界 / 非整数 ⇒ 一律 365（绝不把坏值透传进清理 cutoff）', async () => {
    const missing = await cachedWith({}); // 键缺失
    expect(missing.retentionDays()).toBe(365);
    missing.onApplicationShutdown();

    for (const value of ['30', 0, 3651, 3.5, true, null, undefined]) {
      const cache = await cachedWith({ 'record.retentionDays': value });
      expect(cache.retentionDays(), `值 ${JSON.stringify(value)} 必须回落 365`).toBe(365);
      cache.onApplicationShutdown();
    }
  });

  // ─── 注册赠送金额（货币片 T6 / 规格 §2.8：第 11 键 `currency.signupGrant`）─────────

  it('signupGrant() 缺省：键缺失 ⇒ 0 —— 0 = 注册链路**完全绕开**货币服务（§2.7 步骤 3）', async () => {
    const missing = await cachedWith({}); // 键缺失
    expect(SIGNUP_GRANT_DEFAULT).toBe(0);
    expect(missing.signupGrant()).toBe(0);
    missing.onApplicationShutdown();
  });

  it('signupGrant() 正常值逐值生效（含两端 0 / 1,000,000 = 规格 §2.8 的写死范围）', async () => {
    for (const value of [0, 1, 100, 13, 1_000_000]) {
      const cache = await cachedWith({ 'currency.signupGrant': value });
      expect(cache.signupGrant(), `值 ${value} 必须原样生效`).toBe(value);
      cache.onApplicationShutdown();
    }
  });

  it('signupGrant() 坏值：类型漂移 / 越界 / 非整数 ⇒ 一律 0（绝不放行坏值触发发币）', async () => {
    for (const value of ['100', -1, 1_000_001, 3.5, 0.1, true, null, undefined]) {
      const cache = await cachedWith({ 'currency.signupGrant': value });
      expect(cache.signupGrant(), `值 ${JSON.stringify(value)} 必须回落 0`).toBe(0);
      cache.onApplicationShutdown();
    }
  });

  // ─── 风控六键（风控片 T4 / 规格 §2.1-3 第 20–25 键；C15 getter 半边）────────────────

  it('风控六 getter 缺省：键缺失 ⇒ 种子默认值（0.8 / 100 / 3 / 30 / true / 365）', async () => {
    const missing = await cachedWith({}); // 键缺失
    // 「缺省 = 种子值」本身是判据的一半（与 config-service 种子迁移逐值同源）。
    expect(RISK_WIN_RATE_THRESHOLD_DEFAULT).toBe(0.8);
    expect(RISK_MIN_GAMES_DEFAULT).toBe(100);
    expect(RISK_DEVICE_LIMIT_DEFAULT).toBe(3);
    expect(RISK_DEVICE_WINDOW_DAYS_DEFAULT).toBe(30);
    expect(RISK_AUTO_THROTTLE_DEFAULT).toBe(true);
    expect(RISK_DEVICE_RETENTION_DAYS_DEFAULT).toBe(365);

    expect(missing.riskWinRateThreshold()).toBe(0.8);
    expect(missing.riskMinGames()).toBe(100);
    expect(missing.riskDeviceLimit()).toBe(3);
    expect(missing.riskDeviceWindowDays()).toBe(30);
    expect(missing.riskAutoThrottle()).toBe(true);
    expect(missing.riskDeviceRetentionDays()).toBe(365);
    missing.onApplicationShutdown();
  });

  it('风控数值 getter 正常值逐值生效（含各域两端；0.79 = 两位小数域内值必须过）', async () => {
    for (const value of [0.5, 0.79, 0.8, 1]) {
      const cache = await cachedWith({ 'risk.winRateThreshold': value });
      expect(cache.riskWinRateThreshold(), `winRateThreshold=${value}`).toBe(value);
      cache.onApplicationShutdown();
    }
    for (const [key, value, read] of [
      ['risk.minGames', 1, (c: ConfigCacheService) => c.riskMinGames()],
      ['risk.minGames', 100_000, (c: ConfigCacheService) => c.riskMinGames()],
      ['risk.deviceLimit', 2, (c: ConfigCacheService) => c.riskDeviceLimit()],
      ['risk.deviceLimit', 100, (c: ConfigCacheService) => c.riskDeviceLimit()],
      ['risk.deviceWindowDays', 1, (c: ConfigCacheService) => c.riskDeviceWindowDays()],
      ['risk.deviceWindowDays', 365, (c: ConfigCacheService) => c.riskDeviceWindowDays()],
      ['risk.deviceRetentionDays', 1, (c: ConfigCacheService) => c.riskDeviceRetentionDays()],
      ['risk.deviceRetentionDays', 3650, (c: ConfigCacheService) => c.riskDeviceRetentionDays()],
    ] as const) {
      const cache = await cachedWith({ [key]: value });
      expect(read(cache), `${key}=${value}`).toBe(value);
      cache.onApplicationShutdown();
    }
    // 严格 boolean 键：true / false 都原样生效（false = 关，不是坏值）。
    for (const value of [true, false]) {
      const cache = await cachedWith({ 'risk.autoThrottle': value });
      expect(cache.riskAutoThrottle(), `autoThrottle=${value}`).toBe(value);
      cache.onApplicationShutdown();
    }
  });

  it('风控 getter 坏值回落：类型漂移 / 越界 / 非整数 / 三位小数 ⇒ 一律种子默认', async () => {
    const spec: Array<{
      key: ConfigKey;
      bad: unknown[];
      read: (c: ConfigCacheService) => unknown;
      expected: unknown;
    }> = [
      {
        key: 'risk.winRateThreshold',
        bad: ['0.8', 0.49, 1.01, 0.785, Number.NaN, true, null, undefined],
        read: (c) => c.riskWinRateThreshold(),
        expected: 0.8,
      },
      { key: 'risk.minGames', bad: ['100', 0, 100_001, 3.5, true, null], read: (c) => c.riskMinGames(), expected: 100 },
      { key: 'risk.deviceLimit', bad: ['3', 1, 101, 2.5, null], read: (c) => c.riskDeviceLimit(), expected: 3 },
      { key: 'risk.deviceWindowDays', bad: ['30', 0, 366, 1.5], read: (c) => c.riskDeviceWindowDays(), expected: 30 },
      { key: 'risk.autoThrottle', bad: ['true', 1, 0, null, undefined], read: (c) => c.riskAutoThrottle(), expected: true },
      {
        key: 'risk.deviceRetentionDays',
        bad: ['365', 0, 3651, 1.5],
        read: (c) => c.riskDeviceRetentionDays(),
        expected: 365,
      },
    ];

    for (const { key, bad, read, expected } of spec) {
      for (const value of bad) {
        const cache = await cachedWith({ [key]: value });
        expect(read(cache), `${key}=${JSON.stringify(value)} 必须回落 ${String(expected)}`).toBe(expected);
        cache.onApplicationShutdown();
      }
    }
  });

  // ─── 节奏/清理三键（本片 T4；规格 ⚙️4；第 38–40 键）────────────────────────────
  // 读法逐字照 retentionDays()：缺失 / 类型漂移 / 越界 ⇒ 代码默认常数；⚠️ 快照整体不可用
  // 同样回落（janitor fail-safe —— 与钱面 fail-closed 刻意分层；设计 D3）。

  it('节奏三 getter 默认常数与 WAIT 逐值：3,600,000（= 1h 种子 ⚙️1）×3；SNAPSHOT_BOOT_WAIT_MS=10_000', () => {
    expect(RISK_SCAN_DEFAULT_INTERVAL_MS).toBe(3_600_000);
    expect(RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS).toBe(3_600_000);
    expect(RECORDS_CLEANUP_DEFAULT_INTERVAL_MS).toBe(3_600_000);
    expect(SNAPSHOT_BOOT_WAIT_MS).toBe(10_000);
  });

  it('节奏 getter 缺键 ⇒ 代码默认常数（janitor fail-safe：配置说不清也不停扫）', async () => {
    const missing = await cachedWith({}); // 三键全缺失
    expect(missing.riskScanIntervalMs()).toBe(RISK_SCAN_DEFAULT_INTERVAL_MS);
    expect(missing.devicesCleanupIntervalMs()).toBe(RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS);
    expect(missing.recordsCleanupIntervalMs()).toBe(RECORDS_CLEANUP_DEFAULT_INTERVAL_MS);
    missing.onApplicationShutdown();
  });

  it('节奏 getter 正常值逐值生效（含每键边界两端 1 与上界 36,000,000）', async () => {
    const spec: Array<{
      key: ConfigKey;
      values: number[];
      read: (c: ConfigCacheService) => number;
    }> = [
      {
        key: 'risk.scanIntervalMs',
        values: [1, 2_000, 3_600_000, 36_000_000],
        read: (c) => c.riskScanIntervalMs(),
      },
      {
        key: 'risk.devicesCleanupIntervalMs',
        values: [1, 5_000, 3_600_000, 36_000_000],
        read: (c) => c.devicesCleanupIntervalMs(),
      },
      {
        key: 'record.cleanupIntervalMs',
        values: [1, 60_000, 3_600_000, 36_000_000],
        read: (c) => c.recordsCleanupIntervalMs(),
      },
    ];

    for (const { key, values, read } of spec) {
      for (const value of values) {
        const cache = await cachedWith({ [key]: value });
        expect(read(cache), `${key}=${value} 必须原样生效`).toBe(value);
        cache.onApplicationShutdown();
      }
    }
  });

  it('节奏 getter 坏值回落：键缺失 / 类型漂移 / 0 / 负数 / 非整数 / 上界+1 ⇒ 一律默认常数', async () => {
    const spec: Array<{
      key: ConfigKey;
      read: (c: ConfigCacheService) => number;
      expected: number;
    }> = [
      { key: 'risk.scanIntervalMs', read: (c) => c.riskScanIntervalMs(), expected: 3_600_000 },
      {
        key: 'risk.devicesCleanupIntervalMs',
        read: (c) => c.devicesCleanupIntervalMs(),
        expected: 3_600_000,
      },
      { key: 'record.cleanupIntervalMs', read: (c) => c.recordsCleanupIntervalMs(), expected: 3_600_000 },
    ];

    for (const { key, read, expected } of spec) {
      for (const value of ['3600000', 0, -1, 3.5, 36_000_001, true, null, undefined, Number.NaN]) {
        const cache = await cachedWith({ [key]: value });
        expect(read(cache), `${key}=${JSON.stringify(value)} 必须回落 ${expected}`).toBe(expected);
        cache.onApplicationShutdown();
      }
    }
  });

  it('🔴 快照整体不可用（拉取失败 + 空缓存）⇒ 三 getter 同样回落默认常数（janitor fail-safe，不停扫）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await vi.advanceTimersByTimeAsync(0); // 首轮失败落定

    // ⚠️ 与钱面 fail-closed 刻意分层（设计 D3）：这里**不许** throw / 拒绝，一律回落默认。
    expect(cache.riskScanIntervalMs()).toBe(RISK_SCAN_DEFAULT_INTERVAL_MS);
    expect(cache.devicesCleanupIntervalMs()).toBe(RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS);
    expect(cache.recordsCleanupIntervalMs()).toBe(RECORDS_CLEANUP_DEFAULT_INTERVAL_MS);

    cache.onApplicationShutdown();
  });

  it('hasSnapshot() 前后态：拉取失败 ⇒ false（⚙️5 首排快路径不成立）；首拉成功 ⇒ true', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    expect(cache.hasSnapshot()).toBe(false); // 前态

    snapshot.mockResolvedValue(snapshotWith({}));
    await vi.advanceTimersByTimeAsync(1_000); // 1s 退避重试 ⇒ 成功
    await cache.waitForFirstSnapshot();
    expect(cache.hasSnapshot()).toBe(true); // 后态

    cache.onApplicationShutdown();
  });

  it('频道名逐字：订阅 config:changed（与 config-service 发布侧逐字同名）', () => {
    expect(CONFIG_CHANGED_CHANNEL).toBe('config:changed');
  });

  it('通知 ⇒ 重拉并换缓存（改缓存值生效）；非本频道消息不触发重拉', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValueOnce(snapshotWith({ 'record.retentionDays': 365 }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.retentionDays()).toBe(365);

    // 订阅真的挂上了：专用连接（恰一条）+ 频道名逐字。
    expect(redisState.instances).toHaveLength(1);
    const subscriber = redisState.instances[0]!;
    expect(subscriber.subscribe).toHaveBeenCalledWith('config:changed');

    // 触发订阅回调（`on('message', …)` 注册的那一条）—— 不解析 payload，全量重拉。
    const handler = subscriber.on.mock.calls.find(([event]) => event === 'message')?.[1] as
      | ((channel: string, payload: string) => Promise<void>)
      | undefined;
    expect(handler, '订阅必须注册一条 message 处理器（否则本条空转）').toBeDefined();

    snapshot.mockResolvedValue(snapshotWith({ 'record.retentionDays': 30 }, 2));
    await handler!('config:changed', JSON.stringify({ keys: ['record.retentionDays'] }));

    expect(cache.retentionDays()).toBe(30); // 换缓存生效

    // 别的频道不触发重拉。
    const callsBefore = snapshot.mock.calls.length;
    await handler!('some:other:channel', '{}');
    expect(snapshot.mock.calls.length).toBe(callsBefore);

    cache.onApplicationShutdown();
  });

  it('安全网：CONFIG_SYNC_SAFETY_NET_MS=100 ⇒ 每 100ms 无条件重拉（与推送无关）；关停后停止', async () => {
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '100';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'record.retentionDays': 365 }));
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
    snapshot.mockResolvedValue(snapshotWith({ 'record.retentionDays': 365 }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(redisState.instances).toHaveLength(0); // 未 new Redis、也未 subscribe
    cache.onApplicationShutdown();

    // 正对照：空串（compose 的空默认透传形态）= 未设 ⇒ 恰好建一条订阅连接。
    // 没有这一半，「未建连接」可能只是因为实现根本不订阅（= 变异开关不存在）。
    process.env.CONFIG_SYNC_DISABLE_PUSH = '';
    const { client: client2, snapshot: snapshot2 } = makeClient();
    snapshot2.mockResolvedValue(snapshotWith({ 'record.retentionDays': 365 }));
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
    snapshot.mockResolvedValue(snapshotWith({ 'record.retentionDays': 365 }));
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
      .mockImplementation(() => Promise.resolve(snapshotWith({ 'record.retentionDays': 365 })));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(2); // 1s 退避后重试（仍失败）
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(3); // 再 1s 后第 3 次 —— 成功
    await cache.waitForFirstSnapshot();
    expect(cache.retentionDays()).toBe(365);

    // 成功后不再重试：再推 10s（安全网 60s 未到）也不会有第 4 次。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshot).toHaveBeenCalledTimes(3);

    cache.onApplicationShutdown();
  });

  it('日志分源（R1107 同构落地）：定时器轮 ⇒ timer（每轮独立 id）；订阅回调 ⇒ internal', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'record.retentionDays': 365 }));
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
      .mockResolvedValueOnce(snapshotWith({ 'record.retentionDays': 365 }))
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

describe('风控键平行化（2026-10-24）：新键优先、缺失回退旧键', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('新键覆盖旧键', async () => {
    const cache = await cachedWith({
      'game.doudizhu.risk.winRateThreshold': 0.9,
      'risk.winRateThreshold': 0.8,
      'game.doudizhu.risk.minGames': 50,
      'risk.minGames': 100,
    });
    expect(cache.riskWinRateThreshold()).toBe(0.9);
    expect(cache.riskMinGames()).toBe(50);
    cache.onApplicationShutdown();
  });

  it('新键缺失 ⇒ 旧键', async () => {
    const cache = await cachedWith({
      'risk.winRateThreshold': 0.7,
      'risk.minGames': 10,
    });
    expect(cache.riskWinRateThreshold()).toBe(0.7);
    expect(cache.riskMinGames()).toBe(10);
    cache.onApplicationShutdown();
  });
});

describe('跑得快风控键（2026-10-25）：新键 → 斗地主 → 默认', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pdkWin = (cache: ConfigCacheService) => cache.riskPaodekuaiWinRateThreshold();
  const pdkMin = (cache: ConfigCacheService) => cache.riskPaodekuaiMinGames();

  it('新键合法逐值生效（含两端）', async () => {
    for (const value of [0.5, 0.79, 0.8, 1]) {
      const cache = await cachedWith({ 'game.paodekuai.risk.winRateThreshold': value });
      expect(pdkWin(cache), `pdk winRate=${value}`).toBe(value);
      cache.onApplicationShutdown();
    }
    for (const value of [1, 100, 100_000]) {
      const cache = await cachedWith({ 'game.paodekuai.risk.minGames': value });
      expect(pdkMin(cache), `pdk minGames=${value}`).toBe(value);
      cache.onApplicationShutdown();
    }
  });

  it('新键缺失 ⇒ 斗地主新键 ⇒ 旧键 ⇒ 默认', async () => {
    const ddzNew = await cachedWith({
      'game.doudizhu.risk.winRateThreshold': 0.9,
      'game.doudizhu.risk.minGames': 50,
    });
    expect(pdkWin(ddzNew)).toBe(0.9);
    expect(pdkMin(ddzNew)).toBe(50);
    ddzNew.onApplicationShutdown();

    const legacy = await cachedWith({
      'risk.winRateThreshold': 0.7,
      'risk.minGames': 10,
    });
    expect(pdkWin(legacy)).toBe(0.7);
    expect(pdkMin(legacy)).toBe(10);
    legacy.onApplicationShutdown();

    const missing = await cachedWith({});
    expect(pdkWin(missing)).toBe(RISK_WIN_RATE_THRESHOLD_DEFAULT);
    expect(pdkMin(missing)).toBe(RISK_MIN_GAMES_DEFAULT);
    missing.onApplicationShutdown();
  });

  it('新键存在但非法 ⇒ 代码默认，不回退斗地主键（null 也算存在）', async () => {
    const winCases: unknown[] = [0.785, null, '0.8', 0.49, 1.01, true];
    for (const bad of winCases) {
      const cache = await cachedWith({
        'game.paodekuai.risk.winRateThreshold': bad,
        'game.doudizhu.risk.winRateThreshold': 0.7,
      });
      expect(pdkWin(cache), `pdk winRate=${JSON.stringify(bad)}`).toBe(
        RISK_WIN_RATE_THRESHOLD_DEFAULT,
      );
      cache.onApplicationShutdown();
    }
    const minCases: unknown[] = [0, 100_001, 3.5, '100', null, true];
    for (const bad of minCases) {
      const cache = await cachedWith({
        'game.paodekuai.risk.minGames': bad,
        'game.doudizhu.risk.minGames': 50,
      });
      expect(pdkMin(cache), `pdk minGames=${JSON.stringify(bad)}`).toBe(RISK_MIN_GAMES_DEFAULT);
      cache.onApplicationShutdown();
    }
  });

  it('快照为 null（config-service 不可达）⇒ 默认且不抛', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockRejectedValue(transportDown());
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();

    expect(pdkWin(cache)).toBe(RISK_WIN_RATE_THRESHOLD_DEFAULT);
    expect(pdkMin(cache)).toBe(RISK_MIN_GAMES_DEFAULT);

    cache.onApplicationShutdown();
  });

  it('斗地主回归：新键非法不回退旧键（共享 normalize 重构的判别面）', async () => {
    const win = await cachedWith({
      'game.doudizhu.risk.winRateThreshold': 0.785,
      'risk.winRateThreshold': 0.7,
    });
    expect(win.riskWinRateThreshold()).toBe(RISK_WIN_RATE_THRESHOLD_DEFAULT);
    win.onApplicationShutdown();

    const min = await cachedWith({
      'game.doudizhu.risk.minGames': 0,
      'risk.minGames': 50,
    });
    expect(min.riskMinGames()).toBe(RISK_MIN_GAMES_DEFAULT);
    min.onApplicationShutdown();
  });
});

describe('跑得快按人数风控键与自动限流阈值（2026-10-26）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const playerWin = (cache: ConfigCacheService, n: 2 | 3 | 4) =>
    cache.riskPaodekuaiPlayerWinRateThreshold(n);
  const playerMin = (cache: ConfigCacheService, n: 2 | 3 | 4) =>
    cache.riskPaodekuaiPlayerMinGames(n);

  it('playerN 键合法逐值生效（2/3/4 各自独立）', async () => {
    for (const n of [2, 3, 4] as const) {
      for (const value of [0.5, 0.79, 0.8, 1]) {
        const cache = await cachedWith({
          [`game.paodekuai.risk.player${n}.winRateThreshold`]: value,
        } as never);
        expect(playerWin(cache, n), `player${n} winRate=${value}`).toBe(value);
        cache.onApplicationShutdown();
      }
      for (const value of [1, 100, 100_000]) {
        const cache = await cachedWith({
          [`game.paodekuai.risk.player${n}.minGames`]: value,
        } as never);
        expect(playerMin(cache, n), `player${n} minGames=${value}`).toBe(value);
        cache.onApplicationShutdown();
      }
    }
  });

  it('playerN 缺失 ⇒ 旧 PDK ⇒ DDZ 新键 ⇒ DDZ 旧键 ⇒ 默认', async () => {
    const pdk = await cachedWith({
      'game.paodekuai.risk.winRateThreshold': 0.7,
      'game.paodekuai.risk.minGames': 50,
    });
    expect(playerWin(pdk, 2)).toBe(0.7);
    expect(playerMin(pdk, 2)).toBe(50);
    pdk.onApplicationShutdown();

    const ddzNew = await cachedWith({
      'game.doudizhu.risk.winRateThreshold': 0.9,
      'game.doudizhu.risk.minGames': 40,
    });
    expect(playerWin(ddzNew, 3)).toBe(0.9);
    expect(playerMin(ddzNew, 3)).toBe(40);
    ddzNew.onApplicationShutdown();

    const legacy = await cachedWith({
      'risk.winRateThreshold': 0.6,
      'risk.minGames': 30,
    });
    expect(playerWin(legacy, 4)).toBe(0.6);
    expect(playerMin(legacy, 4)).toBe(30);
    legacy.onApplicationShutdown();

    const missing = await cachedWith({});
    expect(playerWin(missing, 2)).toBe(RISK_WIN_RATE_THRESHOLD_DEFAULT);
    expect(playerMin(missing, 2)).toBe(RISK_MIN_GAMES_DEFAULT);
    missing.onApplicationShutdown();
  });

  it('playerN 存在但非法 ⇒ 代码默认，不回退旧 PDK/DDZ 键（null 也算存在）', async () => {
    const winCases: unknown[] = [0.785, null, '0.8', 0.49, 1.01, true];
    for (const bad of winCases) {
      const cache = await cachedWith({
        'game.paodekuai.risk.player2.winRateThreshold': bad,
        'game.paodekuai.risk.winRateThreshold': 0.7,
        'game.doudizhu.risk.winRateThreshold': 0.9,
      } as never);
      expect(playerWin(cache, 2), `player2 winRate=${JSON.stringify(bad)}`).toBe(
        RISK_WIN_RATE_THRESHOLD_DEFAULT,
      );
      cache.onApplicationShutdown();
    }
    const minCases: unknown[] = [0, 100_001, 3.5, '100', null, true];
    for (const bad of minCases) {
      const cache = await cachedWith({
        'game.paodekuai.risk.player3.minGames': bad,
        'game.paodekuai.risk.minGames': 50,
        'game.doudizhu.risk.minGames': 40,
      } as never);
      expect(playerMin(cache, 3), `player3 minGames=${JSON.stringify(bad)}`).toBe(
        RISK_MIN_GAMES_DEFAULT,
      );
      cache.onApplicationShutdown();
    }
  });

  it('自动限流阈值：25/26/49/50 原值；非法/缺失 ⇒ 50', async () => {
    for (const value of [25, 26, 49, 50]) {
      const cache = await cachedWith({ 'game.paodekuai.risk.autoThrottleScore': value });
      expect(cache.riskPaodekuaiAutoThrottleScore(), `autoThrottleScore=${value}`).toBe(value);
      cache.onApplicationShutdown();
    }
    for (const bad of [24, 51, 3.5, '25', null, true]) {
      const cache = await cachedWith({
        'game.paodekuai.risk.autoThrottleScore': bad,
      } as never);
      expect(cache.riskPaodekuaiAutoThrottleScore(), JSON.stringify(bad)).toBe(50);
      cache.onApplicationShutdown();
    }
    const missing = await cachedWith({});
    expect(missing.riskPaodekuaiAutoThrottleScore()).toBe(50);
    missing.onApplicationShutdown();
  });

  it('快照为 null ⇒ 两 getter 安全回落 0.8/100/50，不抛', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockRejectedValue(transportDown());
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();

    expect(playerWin(cache, 2)).toBe(RISK_WIN_RATE_THRESHOLD_DEFAULT);
    expect(playerMin(cache, 2)).toBe(RISK_MIN_GAMES_DEFAULT);
    expect(cache.riskPaodekuaiAutoThrottleScore()).toBe(50);

    cache.onApplicationShutdown();
  });
});
