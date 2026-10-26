/**
 * `ConfigCacheService`（currency-service）的行为面 —— ② 金币场规格 §9：
 * currency-service 的**第一条出站 RPC 边**（消费 config-service 的三键：
 * `currency.reliefEnabled` / `currency.reliefAmount` / `currency.reliefThresholdCoins`）。
 *
 * 克隆自 user-service / robot-service 的同名测试（记录片 T7 / 片⑦ T8 成例），保留其覆盖
 * 骨架：三件套行为（启动退避拉取 / 专用连接订阅 `config:changed` / 60s 安全网）+ 失败语义
 * （热项取代码默认值）+ 日志分源（R1107）+ 关停闸（T6 审查 Important-2）；本服务的差异：
 *  - 三个读数面（救助开关 / 救助金额 / 门槛倍率），缺省回落 = 种子（false / 200 / 10）；
 *  - 🔴 **`hasSnapshot()`**：relief 端点据此把「从未拉到快照」判成 503/10007
 *    （规格 §9「配置读取失败 ⇒ 503/10007，**不默认放行**」—— 代码默认值只覆盖
 *    「键缺失/坏值」，不覆盖「拿不到配置」）。
 *
 * ─── 夹具（照成例）──────────────────────────────────────────────────────
 *  - **假 ConfigClient**：`{ snapshot: vi.fn() }`，用例可控成功/失败
 *    （失败桩**用真实的 `ConfigServiceError`** —— 真 client 的失败形状就是它）；
 *  - **假订阅连接**：`vi.mock('ioredis')` 把**构造器**换成 spy —— `CONFIG_SYNC_DISABLE_PUSH`
 *    的「不建连接」判据要在**构造器**上断言；
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
import { AppModule } from '../src/app.module';
import { ConfigModule } from '../src/config/config.module';
import {
  CONFIG_CHANGED_CHANNEL,
  CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS,
  RELIEF_AMOUNT_DEFAULT,
  RELIEF_ENABLED_DEFAULT,
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

describe('ConfigCacheService（② 金币场 T8：currency-service 首条出站配置链）', () => {
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
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'currency-service' }));
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

  it('注册面（T6 教训）：`ConfigModule` 在 `AppModule` 的 imports 里（未注册 = 真容器解析不到）', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(ConfigModule);
  });

  it('缺省回落：拉取失败 + 空缓存 ⇒ 不阻塞就绪、三键取代码默认值（种子）、hasSnapshot=false、1s 退避、空窗 WARN 只一次', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);

    // 🔴 不阻塞就绪：同步返回（若实现改成 await 首次拉取，这里当场红）。
    expect(cache.onModuleInit()).toBeUndefined();
    // 缺省 = 种子（§1 第 16/17 键 + 第 14 键）：开关说不清 ⇒ 不开；金额/倍率拿可用数字。
    expect(RELIEF_ENABLED_DEFAULT).toBe(false);
    expect(RELIEF_AMOUNT_DEFAULT).toBe(200);
    expect(cache.reliefEnabled()).toBe(false);
    expect(cache.reliefAmount()).toBe(200);
    expect(cache.reliefThresholdCoins()).toBeNull();
    // 🔴 「拿不到」= hasSnapshot false —— relief 端点据此 503/10007（不默认放行，§9）。
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

  it('hasSnapshot()：首拉成功 ⇒ true（relief 端点 503 判别面的正侧）', async () => {
    const cache = await cachedWith({ 'currency.reliefEnabled': true });
    expect(cache.hasSnapshot()).toBe(true);
    cache.onApplicationShutdown();
  });

  it('三键正常值逐值生效（含两端：金额 1 / 1,000,000；倍率 1 / 100；开关 true/false）', async () => {
    for (const value of [true, false]) {
      const cache = await cachedWith({ 'currency.reliefEnabled': value });
      expect(cache.reliefEnabled(), `值 ${value} 必须原样生效`).toBe(value);
      cache.onApplicationShutdown();
    }
    for (const value of [1, 200, 1_000_000]) {
      const cache = await cachedWith({ 'currency.reliefAmount': value });
      expect(cache.reliefAmount(), `值 ${value} 必须原样生效`).toBe(value);
      cache.onApplicationShutdown();
    }
    for (const value of [1, 150, 1_000_000]) {
      const cache = await cachedWith({ 'currency.reliefThresholdCoins': value });
      expect(cache.reliefThresholdCoins(), `值 ${value} 必须原样生效`).toBe(value);
      cache.onApplicationShutdown();
    }
  });

  it('坏值回落：键缺失 / 类型漂移 / 越界 / 非整数 ⇒ 各自代码默认值（绝不把坏值透传进发币/门槛）', async () => {
    const missing = await cachedWith({}); // 三键全缺失
    expect(missing.reliefEnabled()).toBe(false);
    expect(missing.reliefAmount()).toBe(200);
    expect(missing.reliefThresholdCoins()).toBeNull();
    missing.onApplicationShutdown();

    for (const value of ['true', 1, 0, null, undefined]) {
      const cache = await cachedWith({ 'currency.reliefEnabled': value });
      expect(cache.reliefEnabled(), `开关值 ${JSON.stringify(value)} 必须回落 false`).toBe(false);
      cache.onApplicationShutdown();
    }
    // 金额：0 不是「不发」的合法表达（停发用开关）——非法值一律回落到种子 200。
    for (const value of ['200', 0, -1, 1_000_001, 3.5, true, null, undefined]) {
      const cache = await cachedWith({ 'currency.reliefAmount': value });
      expect(cache.reliefAmount(), `金额值 ${JSON.stringify(value)} 必须回落 200`).toBe(200);
      cache.onApplicationShutdown();
    }
    for (const value of ['150', 0, 1_000_001, 2.5, true, null, undefined]) {
      const cache = await cachedWith({ 'currency.reliefThresholdCoins': value });
      expect(cache.reliefThresholdCoins(), `门槛值 ${JSON.stringify(value)} 必须 null`).toBeNull();
      cache.onApplicationShutdown();
    }
  });

  /**
   * 2026-10-24 平行化：救助门槛改为平台级绝对金币 `currency.reliefThresholdCoins`。
   * 缺失/非法 ⇒ null（钱路径 fail-closed）；正常值逐字生效。
   */
  it('reliefThresholdCoins()：正常值生效；缺键 / 坏值 / 越界 ⇒ null', async () => {
    const normal = await cachedWith({ 'currency.reliefThresholdCoins': 150 });
    expect(normal.reliefThresholdCoins()).toBe(150);
    normal.onApplicationShutdown();

    const missing = await cachedWith({});
    expect(missing.reliefThresholdCoins()).toBeNull();
    missing.onApplicationShutdown();

    for (const value of [0, -1, 1_000_001, 1.5, '150', true, null, undefined]) {
      const cache = await cachedWith({ 'currency.reliefThresholdCoins': value });
      expect(cache.reliefThresholdCoins(), `值 ${JSON.stringify(value)} 必须 null`).toBeNull();
      cache.onApplicationShutdown();
    }
  });

  it('记牌器读边：enabled 缺/坏 false；prices 缺/坏/越界 10/100；正常值/0 透传', async () => {
    const missing = await cachedWith({});
    expect(missing.cardCounterEnabled()).toBe(false);
    expect(missing.cardCounterPrices()).toEqual({ perGame: 10, perHour: 100 });
    missing.onApplicationShutdown();

    for (const value of ['true', 1, 0, null, undefined]) {
      const cache = await cachedWith({ 'game.doudizhu.cardCounterEnabled': value });
      expect(cache.cardCounterEnabled(), `开关值 ${JSON.stringify(value)} 必须回落 false`).toBe(false);
      cache.onApplicationShutdown();
    }

    const good = await cachedWith({
      'game.doudizhu.cardCounterEnabled': true,
      'game.doudizhu.cardCounterPricePerGameCoins': 10,
      'game.doudizhu.cardCounterPricePerHourCoins': 100,
    });
    expect(good.cardCounterEnabled()).toBe(true);
    expect(good.cardCounterPrices()).toEqual({ perGame: 10, perHour: 100 });
    good.onApplicationShutdown();

    const zero = await cachedWith({
      'game.doudizhu.cardCounterPricePerGameCoins': 0,
      'game.doudizhu.cardCounterPricePerHourCoins': 0,
    });
    expect(zero.cardCounterPrices()).toEqual({ perGame: 0, perHour: 0 });
    zero.onApplicationShutdown();

    for (const value of ['10', -1, 1_000_001, 1.5, true, null, undefined]) {
      const cache = await cachedWith({
        'game.doudizhu.cardCounterPricePerGameCoins': value,
        'game.doudizhu.cardCounterPricePerHourCoins': value,
      });
      expect(cache.cardCounterPrices(), `价格值 ${JSON.stringify(value)} 必须回落 10/100`).toEqual({
        perGame: 10,
        perHour: 100,
      });
      cache.onApplicationShutdown();
    }
  });

  it('记牌器新键缺失 ⇒ 回退旧键', async () => {
    const cache = await cachedWith({
      'game.cardCounterEnabled': true,
      'game.cardCounterPricePerGameCoins': 20,
      'game.cardCounterPricePerHourCoins': 200,
    });
    expect(cache.cardCounterEnabled()).toBe(true);
    expect(cache.cardCounterPrices()).toEqual({ perGame: 20, perHour: 200 });
    cache.onApplicationShutdown();
  });

  // ─── 节奏键（本片 T4；规格 ⚙️4；第 37 键 `currency.reconcileIntervalMs`）──────────
  // 读法逐字照 reliefAmount()：缺失 / 类型漂移 / 越界 ⇒ 代码默认常数；⚠️ 快照整体不可用
  // 同样回落（janitor fail-safe —— 与钱面 fail-closed 刻意分层；设计 D3）。

  it('reconcileIntervalMs() 默认常数与 WAIT 逐值：3,600,000（= 1h 种子 ⚙️1）；SNAPSHOT_BOOT_WAIT_MS=10_000', () => {
    expect(CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS).toBe(3_600_000);
    expect(SNAPSHOT_BOOT_WAIT_MS).toBe(10_000);
  });

  it('reconcileIntervalMs() 缺键 / 坏值（类型漂移 / 0 / 负数 / 非整数 / 上界+1）⇒ 一律默认常数', async () => {
    const missing = await cachedWith({}); // 键缺失
    expect(missing.reconcileIntervalMs()).toBe(CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS);
    missing.onApplicationShutdown();

    for (const value of ['3600000', 0, -1, 3.5, 36_000_001, true, null, undefined, Number.NaN]) {
      const cache = await cachedWith({ 'currency.reconcileIntervalMs': value });
      expect(cache.reconcileIntervalMs(), `值 ${JSON.stringify(value)} 必须回落默认`).toBe(
        CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS,
      );
      cache.onApplicationShutdown();
    }
  });

  it('reconcileIntervalMs() 正常值逐值生效（含边界两端 1 与上界 36,000,000）', async () => {
    for (const value of [1, 2_000, 3_600_000, 36_000_000]) {
      const cache = await cachedWith({ 'currency.reconcileIntervalMs': value });
      expect(cache.reconcileIntervalMs(), `值 ${value} 必须原样生效`).toBe(value);
      cache.onApplicationShutdown();
    }
  });

  // ─── C2：台费档位费率（记录对账用；与既有 getter 无关）──────────────────────

  it('entryFeePercents：ddz 新键优先；缺失回退旧 game.baseScoreLevels；pdk 无旧键', async () => {
    const levels = [{ name: '休闲场', baseScore: 15, entryFeePercent: 10 }];
    const fresh = await cachedWith({ 'game.levels.doudizhu': levels });
    expect(fresh.entryFeePercents('doudizhu')).toEqual([{ baseScore: 15, percent: 10 }]);
    fresh.onApplicationShutdown();

    const legacyLevels = [{ name: '旧档', baseScore: 15 }];
    const legacy = await cachedWith({ 'game.baseScoreLevels': legacyLevels });
    expect(legacy.entryFeePercents('doudizhu')).toEqual([{ baseScore: 15, percent: 0 }]);
    expect(legacy.entryFeePercents('paodekuai')).toBeNull();
    legacy.onApplicationShutdown();
  });

  it('entryFeePercents：合法空 []；合法全 0 ⇒ 非空全 0；缺失/非法 ⇒ null；新键非法不回退', async () => {
    const empty = await cachedWith({ 'game.levels.doudizhu': [] });
    expect(empty.entryFeePercents('doudizhu')).toEqual([]);
    empty.onApplicationShutdown();

    const zero = await cachedWith({
      'game.levels.doudizhu': [{ name: '零费', baseScore: 15, entryFeePercent: 0 }],
    });
    expect(zero.entryFeePercents('doudizhu')).toEqual([{ baseScore: 15, percent: 0 }]);
    zero.onApplicationShutdown();

    const missing = await cachedWith({});
    expect(missing.entryFeePercents('paodekuai')).toBeNull();
    missing.onApplicationShutdown();

    for (const bad of [
      null,
      'x',
      [{}],
      [{ name: 'X', baseScore: 0 }],
      [{ name: 'X', baseScore: 15, entryFeePercent: 101 }],
    ]) {
      const cache = await cachedWith({ 'game.levels.paodekuai': bad as never });
      expect(cache.entryFeePercents('paodekuai'), JSON.stringify(bad)).toBeNull();
      cache.onApplicationShutdown();
    }

    const invalidNew = await cachedWith({
      'game.levels.doudizhu': [{ name: 'X', baseScore: 0 }],
      'game.baseScoreLevels': [{ name: 'OK', baseScore: 15 }],
    });
    expect(invalidNew.entryFeePercents('doudizhu'), '新键非法不得回退旧键').toBeNull();
    invalidNew.onApplicationShutdown();
  });

  it('🔴 快照整体不可用（拉取失败 + 空缓存）⇒ reconcileIntervalMs() 同样回落默认（janitor fail-safe，不停扫）', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockImplementation(() => Promise.reject(transportDown()));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await vi.advanceTimersByTimeAsync(0); // 首轮失败落定

    // ⚠️ 与钱面 fail-closed 刻意分层（设计 D3）：这里**不许** throw / 拒绝，一律回落默认。
    expect(cache.reconcileIntervalMs()).toBe(CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS);

    cache.onApplicationShutdown();
  });

  it('频道名逐字：订阅 config:changed（与 config-service 发布侧逐字同名）', () => {
    expect(CONFIG_CHANGED_CHANNEL).toBe('config:changed');
  });

  it('通知 ⇒ 重拉并换缓存（改救助开关生效）；非本频道消息不触发重拉', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValueOnce(snapshotWith({ 'currency.reliefEnabled': false }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.reliefEnabled()).toBe(false);

    // 订阅真的挂上了：专用连接（恰一条）+ 频道名逐字。
    expect(redisState.instances).toHaveLength(1);
    const subscriber = redisState.instances[0]!;
    expect(subscriber.subscribe).toHaveBeenCalledWith('config:changed');

    // 触发订阅回调（`on('message', …)` 注册的那一条）—— 不解析 payload，全量重拉。
    const handler = subscriber.on.mock.calls.find(([event]) => event === 'message')?.[1] as
      | ((channel: string, payload: string) => Promise<void>)
      | undefined;
    expect(handler, '订阅必须注册一条 message 处理器（否则本条空转）').toBeDefined();

    snapshot.mockResolvedValue(snapshotWith({ 'currency.reliefEnabled': true }, 2));
    await handler!('config:changed', JSON.stringify({ keys: ['currency.reliefEnabled'] }));

    expect(cache.reliefEnabled()).toBe(true); // 换缓存生效

    // 别的频道不触发重拉。
    const callsBefore = snapshot.mock.calls.length;
    await handler!('some:other:channel', '{}');
    expect(snapshot.mock.calls.length).toBe(callsBefore);

    cache.onApplicationShutdown();
  });

  it('安全网：CONFIG_SYNC_SAFETY_NET_MS=100 ⇒ 每 100ms 无条件重拉（与推送无关）；关停后停止', async () => {
    process.env.CONFIG_SYNC_SAFETY_NET_MS = '100';
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'currency.reliefEnabled': true }));
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
    snapshot.mockResolvedValue(snapshotWith({ 'currency.reliefEnabled': true }));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();

    expect(redisState.instances).toHaveLength(0); // 未 new Redis、也未 subscribe
    cache.onApplicationShutdown();

    // 正对照：空串（compose 的空默认透传形态）= 未设 ⇒ 恰好建一条订阅连接。
    // 没有这一半，「未建连接」可能只是因为实现根本不订阅（= 变异开关不存在）。
    process.env.CONFIG_SYNC_DISABLE_PUSH = '';
    const { client: client2, snapshot: snapshot2 } = makeClient();
    snapshot2.mockResolvedValue(snapshotWith({ 'currency.reliefEnabled': true }));
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
    snapshot.mockResolvedValue(snapshotWith({ 'currency.reliefEnabled': true }));
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
      .mockImplementation(() => Promise.resolve(snapshotWith({ 'currency.reliefEnabled': true })));
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    expect(cache.hasSnapshot()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(2); // 1s 退避后重试（仍失败）
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(3); // 再 1s 后第 3 次 —— 成功
    await cache.waitForFirstSnapshot();
    expect(cache.hasSnapshot()).toBe(true);
    expect(cache.reliefEnabled()).toBe(true);

    // 成功后不再重试：再推 10s（安全网 60s 未到）也不会有第 4 次。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshot).toHaveBeenCalledTimes(3);

    cache.onApplicationShutdown();
  });

  it('日志分源（R1107 同构落地）：定时器轮 ⇒ timer（每轮独立 id）；订阅回调 ⇒ internal', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(snapshotWith({ 'currency.reliefEnabled': true }));
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
      .mockResolvedValueOnce(snapshotWith({ 'currency.reliefEnabled': true }))
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
