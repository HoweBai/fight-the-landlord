/**
 * `ReconcileService` 的行为面 —— 货币片 T8 / 规格 §2.12（循环 + 三检查判定 + 7 指标 + 日志）
 * 与 §6.1 `reconcile.service` 行**全列**（含「写穿失败 ⇒ warn + counter」—— §2.12 表末行
 * 「两处同一计数器」的 apply 侧写点在此一并钉住）；本片 T8：间隔 = 配置第 37 键
 * `currency.reconcileIntervalMs`（**排期处现读**）+ 首排动作（⚙️5–⚙️7）。
 *
 * ─── 夹具（四件）──────────────────────────────────────────────────────────
 *  - **假 DB**（`helpers/fake-currency-db.ts` 扩展）：直读面新增两条对账 SQL 的**全文相等**
 *    识别（规格 §2.12 原文的独立副本 —— 实现侧 SQL 漂移一个字符就红）+ 真语义仿真
 *    （LEFT JOIN 求差 / COUNT DISTINCT 孤儿）+ 两条注入面（`directFailuresRemaining` 失败、
 *    `holdNextDirectQuery` 在途一轮）。
 *  - **假 Redis**：真存储 + 调用记录 + 失败注入（`failKeys`）+ `scan`/`scanPageSize`
 *    （游标循环的判别面）。
 *  - **假时钟**：vitest fake timers 驱动自重排链（10s 首跑 / 重排现读 / 首排等待 / 关停闸）；
 *    检查语义用例直接 `runReconcileOnce()`（无节拍依赖）。
 *  - **假 ConfigCache**（本片 T8）：`reconcileIntervalMs` getter 是 `vi.fn`（用例可改值模拟
 *    「改键 + 缓存已刷新」）+ 首排两把手（`hasSnapshot`/`waitForFirstSnapshot`，缺省 = 快
 *    路径就绪）。
 *
 * ─── 覆盖（§6.1 reconcile 行全列；env 注入族已迁移为假缓存注入）──────────────
 *  账实漂移 ⇒ 逐行 error（ownerId/两值/差）+ gauge、**不自修**（库零写、修回后归零）；
 *  缓存漂移 ⇒ DEL + counter（值不等 / 账户不存在 / 值损坏三支；相符键不动、
 *  「MySQL 有而缓存缺」不算、SCAN 游标多页）；写穿失败 ⇒ warn + 同一 counter；
 *  孤儿 COUNT DISTINCT ⇒ gauge + >0 日志（非 signup 源 / users 行在的不计、DISTINCT 去重）；
 *  last_success 启动 0 与 set（漂移轮也 set；查询抛错不 set）；runs_total 每轮开始 +1
 *  （失败轮也计）；7 条指标名齐；间隔注入（假缓存现读）与关停闸（含串行无重入）；
 *  注册面（AppModule providers）；重排现读（⚙️7）：一轮跑完 ⇒ 下一轮延迟 = 现读值、
 *  改值 ⇒ 再下一轮用新值、已排定的一轮不撤；首排动作（⚙️5/⚙️6）：快路径同帧 /
 *  晚到用缓存值 / 超时按缺省 / 超时后迟到恰一次排期 / 等待期间关停零排期 /
 *  启动行 interval 位 = 解析值；
 *  T8b：一轮一层 trace（定时链下一轮所有日志行同 id，跨层的一对漂移行/失败行亦同）。
 *  ⚠️ ② 金币场 T8 起每轮末尾**多两次直读**（池余额 + 机器人账户总和 ⇒ 两个新 gauge）——
 *  本文件所有「恰 N 条直读」断言已随行为同提交订正（判据只增不减：N 的组成在断言里写死）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { currentTrace, metricsRegistry } from '@fight-the-landlord/shared';
import {
  CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS,
  CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS,
  ReconcileService,
} from '../src/reconcile/reconcile.service';
import { SNAPSHOT_BOOT_WAIT_MS, type ConfigCacheService } from '../src/config/config-cache.service';
import {
  currencyOrphanSignupGrants,
  currencyReconcileCacheDriftTotal,
  currencyReconcileDriftAccounts,
  currencyReconcileLastSuccessTimestampSeconds,
  currencyReconcileRunsTotal,
  currencyRobotAccountsBalanceSum,
  currencyRobotPoolBalance,
} from '../src/metrics/currency.metrics';
import { ApplyService } from '../src/apply/apply.service';
import { AppModule } from '../src/app.module';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

/** 固定时间轴原点（last_success 用例的时钟注入；不随真实时钟漂移）。 */
const T0 = Date.parse('2026-10-03T12:00:00.000Z');

/** `currency:balance:<ownerId>`（⚙️4 逐字；与实现同面的字面量 —— 键名漂移会在这里现形）。 */
const KEY = (ownerId: string) => `currency:balance:${ownerId}`;

/** §2.12 表七行 + ② 金币场 §11.1 三行（T8）逐字（名称是判据的一半；C16 的「指标名齐」单测半边）。 */
const METRIC_NAMES = [
  // 货币片 §2.12 表七条
  'currency_apply_total',
  'currency_apply_entries_total',
  'currency_reconcile_runs_total',
  'currency_reconcile_last_success_timestamp_seconds',
  'currency_reconcile_drift_accounts',
  'currency_reconcile_cache_drift_total',
  'currency_orphan_signup_grants',
  // ② 金币场 §11.1 三条（池 gauge / 机器人总和 gauge / 救助计数）
  'currency_robot_pool_balance',
  'currency_robot_accounts_balance_sum',
  'currency_relief_total',
] as const;

/** metric 读面（结构类型，不引 prom-client 的类型 —— 本包不直接依赖它）。 */
interface MetricLike {
  get(): Promise<{
    values: Array<{ value: number; labels: Partial<Record<string, string | number>> }>;
  }>;
}

async function metricValue(metric: MetricLike, labels?: Record<string, string>): Promise<number> {
  const { values } = await metric.get();
  return values
    .filter(
      (v) =>
        labels === undefined ||
        Object.entries(labels).every(([name, expected]) => String(v.labels[name]) === expected),
    )
    .reduce((sum, v) => sum + v.value, 0);
}

/** 种一个**账实相符**的账户：余额 = 其全部流水之和（单笔流水即可；0 余额不产流水）。 */
function seedConsistent(db: FakeCurrencyDb, ownerId: string, balance: number): void {
  db.seedAccount(ownerId, 'user', balance);
  if (balance !== 0) {
    db.seedCommittedOp({ actionId: `seed:${ownerId}`, requestHash: `h:${ownerId}` }, [
      { ownerId, delta: balance, balanceAfter: balance },
    ]);
  }
}

/**
 * 假 ConfigCache（接口四件套 = 本片 T8 起循环消费面：`reconcileIntervalMs` getter + 首排
 * 两把手；getter 是 `vi.fn`，用例可改值模拟「改键 + 缓存已刷新」。缺省 = 快路径就绪 +
 * 1h 缺省）。 ⚠️ 「构造期不得读间隔」的判别力靠 `reconcileIntervalMs` 句柄的调用计数。
 */
function makeCache(opts: { intervalMs?: number } = {}): {
  cache: ConfigCacheService;
  reconcileIntervalMs: ReturnType<typeof vi.fn>;
} {
  const reconcileIntervalMs = vi.fn(() => opts.intervalMs ?? CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS);
  const cache = {
    reconcileIntervalMs,
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
  } as unknown as ConfigCacheService;
  return { cache, reconcileIntervalMs };
}

describe('§2.12 对账自调度循环（T8：三检查 + 指标 + 日志）', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  /** 构造被测服务（假 DB + 假 Redis + 假缓存树成构造函数形状；缺省缓存 = 快路径就绪 + 1h）。 */
  const mkService = (
    db: FakeCurrencyDb,
    redis: FakeRedis,
    cache: ConfigCacheService = makeCache().cache,
  ): ReconcileService =>
    new ReconcileService(db.dataSource as unknown as DataSource, redis as unknown as Redis, cache);

  /** 本用例捕获到的启动行（`afterSnapshotReady` 是唯一打印落点）。 */
  const startedLines = (log: ReturnType<typeof vi.spyOn>): string[] =>
    log.mock.calls.map((args) => String(args[0])).filter((m) => m.includes('Currency reconcile loop started'));

  it('注册面（T6 教训）：`ReconcileService` 在 `AppModule` 的 providers 里', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(ReconcileService);
  });

  it('节奏：启动后 10s 首跑；随后按缓存现读的 1h 默认自重排（advance 边界两侧）', async () => {
    // §2.12 的两个数字**写死**：常量的值本身就是判据的一半
    // （`CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS` 现为 `config-cache.service` 的 re-export —— 引用面不变）。
    expect(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS).toBe(10_000);
    expect(CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS).toBe(3_600_000);

    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    const svc = mkService(db, redis);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS - 1);
    expect(db.directQueries, '9.999s 时点：首跑还没到').toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      db.directQueries,
      '首跑 = 检查① + 检查③ + 两个新 gauge（缓存为空 ⇒ 检查②无逐键读）',
    ).toHaveLength(4);
    expect(
      logSpy.mock.calls.some((args) => String(args[0]).includes('currency reconcile done')),
      '轮摘要（心跳）：零漂移轮也要留痕',
    ).toBe(true);

    const afterFirst = db.directQueries.length;
    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS - 1);
    expect(db.directQueries, '1h 未到点：不排第 2 轮').toHaveLength(afterFirst);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.directQueries.length, '第 2 轮 = 第 1 轮结束 + 1h（每轮同 4 条直读）').toBe(afterFirst + 4);

    svc.onApplicationShutdown();
  });

  it('假缓存注入：reconcileIntervalMs=100 ⇒ 第 2 轮触发点 = 第 1 轮结束 + 100（+99 不触发）', async () => {
    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    const svc = mkService(db, redis, makeCache({ intervalMs: 100 }).cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS);
    expect(db.directQueries, '首跑仍在 10s（配置的是**间隔**，不是首跑延迟）').toHaveLength(4);
    await vi.advanceTimersByTimeAsync(99);
    expect(db.directQueries, '第 1 轮结束 + 99ms：第 2 轮还没到点').toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.directQueries, '第 2 轮触发点 = 第 1 轮结束 + 100（重排处现读的缓存注入值）').toHaveLength(8);

    svc.onApplicationShutdown();
  });

  it('重排现读（本片核心 ⚙️7）：一轮跑完 ⇒ 下一轮延迟 = 现读值；改值 ⇒ 再下一轮用新值', async () => {
    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    const { cache, reconcileIntervalMs } = makeCache();
    const svc = mkService(db, redis, cache);
    expect(
      reconcileIntervalMs,
      '构造期不得读间隔（旧形态 = 构造期读 env —— 「现读」的判别力靠这个前置态支撑）',
    ).not.toHaveBeenCalled();

    svc.onModuleInit(); // 快路径：hasSnapshot=true ⇒ 同帧打启动行（读 #1）+ 排首跑 10s
    expect(reconcileIntervalMs, '启动行恰读一次').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS); // 首跑跑完
    expect(db.directQueries).toHaveLength(4);
    expect(reconcileIntervalMs, '排期处恰再读一次（读 #2）').toHaveBeenCalledTimes(2);

    // 首跑收尾现读 = 默认 3600000 ⇒ 第 2 轮 @ +3600000。改值发生在其后 ⇒ 已排定的一轮不撤：
    reconcileIntervalMs.mockReturnValue(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(db.directQueries, '改值不撤已排定的一轮（+3000 时点第 2 轮仍未到）').toHaveLength(4);
    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS - 3_000);
    expect(
      db.directQueries,
      '第 2 轮触发点 = 第 1 轮结束 + 3600000（旧形态「构造期读一次」也能过这句——判别力在下一段）',
    ).toHaveLength(8);

    // 第 2 轮收尾现读 = 新值 3000 ⇒ 第 3 轮 @ +3000（改键自该轮收尾排期起生效）：
    await vi.advanceTimersByTimeAsync(2_999);
    expect(db.directQueries, '3000 改值后 +2999：第 3 轮未到点').toHaveLength(8);
    reconcileIntervalMs.mockReturnValue(7_000); // 第 3 轮未跑完：再改（影响第 3 轮收尾的现读）
    await vi.advanceTimersByTimeAsync(1);
    expect(
      db.directQueries,
      '第 3 轮触发点 = 第 2 轮结束 + 3000（现读新值 3000 —— 构造期读一次的实现这里会是 +3600000）',
    ).toHaveLength(12);

    // 第 3 轮收尾现读 = 7000 ⇒ 第 4 轮 @ +7000：
    await vi.advanceTimersByTimeAsync(6_999);
    expect(db.directQueries).toHaveLength(12);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.directQueries, '第 4 轮触发点 = 第 3 轮结束 + 7000（再次现读）').toHaveLength(16);

    svc.onApplicationShutdown();
  });

  it('首排动作三态：晚到（wait 后 resolve ⇒ 用缓存值）/超时（缺省）/超时后迟到 ⇒ 恰一次排期', async () => {
    // 态 1 · 晚到：hasSnapshot=false，快照在等待窗内就绪 ⇒ 续体用缓存值打行 + 排首跑。
    {
      const db = new FakeCurrencyDb();
      const { cache } = makeCache({ intervalMs: 3_000 });
      let resolveWait!: () => void;
      const wait = new Promise<void>((r) => (resolveWait = r));
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => wait;
      const svc = mkService(db, new FakeRedis(), cache);

      svc.onModuleInit();
      expect(
        startedLines(logSpy),
        '等待期：启动行还没打（打印唯一落点 = afterSnapshotReady）',
      ).toHaveLength(0);
      expect(vi.getTimerCount(), '等待路：有界等待定时器恰一枚').toBe(1);

      resolveWait(); // 快照就绪（早于超时）
      await vi.advanceTimersByTimeAsync(0); // 微任务冲刷：settle ⇒ afterSnapshotReady
      expect(startedLines(logSpy)).toHaveLength(1);
      expect(startedLines(logSpy)[0], '晚到路：interval = 缓存解析值（非缺省）').toContain(
        'interval 3000ms',
      );
      expect(vi.getTimerCount(), '败方定时器已清 + 首跑已排 = 恰一枚').toBe(1);

      await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS);
      expect(db.directQueries, '晚到路：首跑仍按 10s 常数排').toHaveLength(4);
      svc.onApplicationShutdown();
    }

    // 态 2 · 超时：等待窗（SNAPSHOT_BOOT_WAIT_MS）到点 ⇒ 按缺省解析先打行排期（降级拓扑；下一轮重排自愈）。
    {
      const db = new FakeCurrencyDb();
      const { cache } = makeCache(); // 缺省 3600000 = 缓存「快照不可用回落种子」的替身
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => new Promise<void>(() => {}); // 永不就绪
      const svc = mkService(db, new FakeRedis(), cache);

      svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_BOOT_WAIT_MS - 1);
      expect(startedLines(logSpy), '超时前 1ms：仍未打行排期（有界等待的上界）').toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(startedLines(logSpy), '超时到点：按缺省解析打行排期').toHaveLength(2);
      expect(startedLines(logSpy)[1]).toContain('interval 3600000ms');
      expect(vi.getTimerCount(), '等待定时器已消费 + 首跑在挂 = 恰一枚').toBe(1);

      await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS);
      expect(db.directQueries, '降级拓扑照样跑首跑').toHaveLength(4);
      svc.onApplicationShutdown();
    }

    // 态 3 · 超时后迟到（r1 🟠1 的要害形态）：once 闸让就绪路 no-op —— 否则双排期双链。
    {
      const db = new FakeCurrencyDb();
      const { cache } = makeCache({ intervalMs: 3_000 });
      let resolveWait!: () => void;
      const wait = new Promise<void>((r) => (resolveWait = r));
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => wait;
      const svc = mkService(db, new FakeRedis(), cache);

      svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_BOOT_WAIT_MS); // 超时路先赢（打行 + 排 10s 首跑）
      expect(startedLines(logSpy)).toHaveLength(3);
      expect(vi.getTimerCount(), '首跑已排 = 恰一枚').toBe(1);

      resolveWait(); // 快照 >10s 迟到
      await vi.advanceTimersByTimeAsync(0);
      expect(
        startedLines(logSpy),
        'once 闸：就绪路 no-op（双排期实现这里会打第二条启动行）',
      ).toHaveLength(3);
      expect(vi.getTimerCount(), 'once 闸：不双排期（双链实现这里是 2）').toBe(1);

      await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS);
      expect(db.directQueries, '恰一条链：10s 到点恰跑一轮（双链会跑两轮）').toHaveLength(4);
      expect(vi.getTimerCount(), '该轮收尾重排（现读 3000）= 恰一枚').toBe(1);
      svc.onApplicationShutdown();
    }
  });

  it('首排动作：续体关停闸（等待期间 shutdown ⇒ 零排期；getTimerCount()===0 终态）', async () => {
    const db = new FakeCurrencyDb();
    const { cache } = makeCache({ intervalMs: 3_000 });
    let resolveWait!: () => void;
    const wait = new Promise<void>((r) => (resolveWait = r));
    cache.hasSnapshot = () => false;
    cache.waitForFirstSnapshot = () => wait;
    const svc = mkService(db, new FakeRedis(), cache);

    svc.onModuleInit();
    expect(vi.getTimerCount(), '反空测：等待定时器在挂').toBe(1);

    svc.onApplicationShutdown(); // 等待期间关停
    resolveWait(); // 就绪路迟到：settle ⇒ afterSnapshotReady（关停闸在此拦住）
    await vi.advanceTimersByTimeAsync(0);

    expect(startedLines(logSpy), '关停闸：迟到的续体不得打启动行、不得排期').toHaveLength(0);
    expect(vi.getTimerCount(), '终态：胜方 settle 清掉等待定时器 + 零排期').toBe(0);
    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS + 1);
    expect(db.directQueries, '关停后零轮（无复活链）').toHaveLength(0);
  });

  it('启动行 interval 位 = 解析值（⚙️6 逐字；快路径同帧打印）', () => {
    const db = new FakeCurrencyDb();
    const { cache } = makeCache({ intervalMs: 3_000 });
    const svc = mkService(db, new FakeRedis(), cache);

    svc.onModuleInit();
    // 快路径「真同步」的证明方式 = 本测试全程不 await、不推进定时器：
    // `onModuleInit` 返回时启动行**已在 log spy 里**，首跑定时器**已挂上**（同帧解析+打+排）。
    const started = startedLines(logSpy);
    expect(started).toHaveLength(1);
    expect(started[0]).toBe(
      'Currency reconcile loop started (first run in 10000ms, interval 3000ms)',
    );
    expect(vi.getTimerCount(), '首跑定时器同帧排定').toBe(1);
    expect(db.directQueries, '排首轮 ≠ 跑首轮（同帧不得有查询）').toHaveLength(0);

    svc.onApplicationShutdown();
  });

  it('关停闸 + 串行无重入：在途一轮关停 ⇒ 迟到回执不再排下一轮（且一轮在途时绝不叠跑下一轮）', async () => {
    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    const svc = mkService(db, redis, makeCache({ intervalMs: 100 }).cache);
    svc.onModuleInit();

    const gate = db.holdNextDirectQuery();
    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS); // 第 1 轮在途（检查①挂起）
    expect(db.directQueries, '反空测：第 1 轮必须真的在途').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS);
    expect(db.directQueries, '自重排链 = 串行无重入：一轮在途期间不叠跑下一轮').toHaveLength(1);

    svc.onApplicationShutdown(); // 在途期间关停
    gate.resolve([]); // 迟到的回执（第 1 轮继续收尾：检查②/③ + 两 gauge 照跑完）
    await vi.advanceTimersByTimeAsync(0);
    expect(db.directQueries, '迟到回执照收尾（检查③ + 池/总和两 gauge 落账）').toHaveLength(4);

    expect(
      (svc as unknown as { timer: unknown }).timer,
      '关停后不得再排定时器（闸被删掉时这里会非 null）',
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS);
    expect(db.directQueries, '放行后不得再跑（无复活循环）').toHaveLength(4);
  });

  it('检查①：账实不符 ⇒ 逐行 error（ownerId/两值/差）+ gauge=行数；不自修；修回后下一轮归零', async () => {
    const db = new FakeCurrencyDb();
    // 漂移：balance 100 ≠ 流水合计 40（差 60）
    db.seedAccount('u-drift', 'user', 100);
    db.seedCommittedOp({ actionId: 'seed:drift', requestHash: 'h:drift' }, [
      { ownerId: 'u-drift', delta: 40, balanceAfter: 40 },
    ]);
    seedConsistent(db, 'u-ok', 30); // 对照：账实相符
    const redis = new FakeRedis();
    const svc = mkService(db, redis);

    const result = await svc.runReconcileOnce();

    expect(result.driftAccounts).toBe(1);
    expect(await metricValue(currencyReconcileDriftAccounts)).toBe(1);
    const drifts = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((msg) => msg.includes('currency reconcile drift'));
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain('ownerId=u-drift');
    expect(drifts[0]).toContain('balance=100');
    expect(drifts[0]).toContain('flowsTotal=40');
    expect(drifts[0]).toContain('diff=60');

    // 🔴 不自修（钱的事只报不改）：账户值一行未动、流水一行未加、**零事务**，本轮直读全是 SELECT。
    expect(db.accounts.get('u-drift')!.balance).toBe(100);
    expect(db.flows).toHaveLength(2); // 两条 seed 流水，未被增删
    expect(db.txLog, '对账绝不走事务（零写的更强判据）').toHaveLength(0);
    expect(db.directQueries.every((s) => s.sql.trimStart().startsWith('SELECT'))).toBe(true);

    // 修回（人工把账做平：balance 改回 40）⇒ 下一轮归零、不再响亮。
    db.accounts.get('u-drift')!.balance = 40;
    const second = await svc.runReconcileOnce();
    expect(second.driftAccounts).toBe(0);
    expect(await metricValue(currencyReconcileDriftAccounts)).toBe(0);
    expect(
      errorSpy.mock.calls.map((args) => String(args[0])).filter((msg) => msg.includes('currency reconcile drift')),
    ).toHaveLength(1);
  });

  it('检查②：缓存漂移（值不等/账户不存在/值损坏）⇒ DEL 键 + counter；相符键不动、「MySQL 有而缓存缺」不算', async () => {
    const db = new FakeCurrencyDb();
    seedConsistent(db, 'u-same', 100);
    seedConsistent(db, 'u-mismatch', 100);
    seedConsistent(db, 'u-garbage', 100);
    seedConsistent(db, 'u-nocache', 30); // MySQL 有而缓存缺：**不算**漂移
    const redis = new FakeRedis();
    redis.store.set(KEY('u-same'), '100'); // 相符
    redis.store.set(KEY('u-mismatch'), '999'); // 值不等
    redis.store.set(KEY('u-garbage'), 'not-a-number'); // 值损坏（值契约：十进制整数串）
    redis.store.set(KEY('u-ghost'), '5'); // 账户不存在也算漂移（幽灵键）
    const svc = mkService(db, redis);
    const driftBefore = await metricValue(currencyReconcileCacheDriftTotal);

    const result = await svc.runReconcileOnce();

    expect(result.cacheDriftDeleted).toBe(3);
    expect(redis.store.has(KEY('u-same')), '相符键不动').toBe(true);
    expect(redis.store.has(KEY('u-mismatch'))).toBe(false);
    expect(redis.store.has(KEY('u-garbage'))).toBe(false);
    expect(redis.store.has(KEY('u-ghost'))).toBe(false);
    expect(await metricValue(currencyReconcileCacheDriftTotal)).toBe(driftBefore + 3);
    // DEL 恰对漂移键发生（调用序列与判定集合一一对应）
    expect(redis.calls.filter((c) => c.op === 'del').map((c) => c.key).sort()).toEqual(
      [KEY('u-garbage'), KEY('u-ghost'), KEY('u-mismatch')].sort(),
    );
    // 逐键读 MySQL：只对被 SCAN 到的键（u-nocache 没键 ⇒ 不回源）；
    // 同形 SQL 还有**轮末池 gauge 读**（robot-pool —— 与逐键回源同一常量形态）。
    expect(
      db.directQueries
        .filter((s) => s.sql.startsWith('SELECT `balance`'))
        .map((s) => s.params[0])
        .sort(),
      '逐键回源 = 恰四个被缓存住的 ownerId + 池读一条',
    ).toEqual(['robot-pool', 'u-garbage', 'u-ghost', 'u-mismatch', 'u-same']);
    expect(redis.calls.filter((c) => c.op === 'scan')).toHaveLength(1);
  });

  it('检查②：SCAN 游标循环翻页（页大小 1 × 2 键 ⇒ 两页都处理）', async () => {
    const db = new FakeCurrencyDb();
    seedConsistent(db, 'u-1', 10);
    seedConsistent(db, 'u-2', 20);
    const redis = new FakeRedis();
    redis.store.set(KEY('u-1'), '10'); // 相符（第 1 页）
    redis.store.set(KEY('u-2'), '999'); // 漂移（第 2 页 —— 单发 SCAN 的实现看不到它）
    redis.scanPageSize = 1;
    const svc = mkService(db, redis);

    const result = await svc.runReconcileOnce();

    expect(redis.calls.filter((c) => c.op === 'scan'), '两页 = 两次 SCAN（游标循环）').toHaveLength(2);
    expect(result.cacheDriftDeleted).toBe(1);
    expect(redis.store.has(KEY('u-2'))).toBe(false);
    expect(redis.store.has(KEY('u-1'))).toBe(true);
  });

  it('检查③：孤儿赠送 COUNT DISTINCT ⇒ gauge；>0 记日志；非 signup 源 / users 行在的不计', async () => {
    const db = new FakeCurrencyDb();
    db.registeredUsers.add('u-member');
    // 非孤儿（users 行在；两条 signup 流水也只算 1 —— DISTINCT 面）
    db.seedAccount('u-member', 'user', 50);
    db.seedCommittedOp({ actionId: 'sg:m1', requestHash: 'h:m1', source: 'signup_grant' }, [
      { ownerId: 'u-member', delta: 30, balanceAfter: 30 },
      { ownerId: 'u-member', delta: 20, balanceAfter: 50 },
    ]);
    // 孤儿（两条 signup 流水 ⇒ DISTINCT 仍 1）
    db.seedAccount('u-orphan', 'user', 70);
    db.seedCommittedOp({ actionId: 'sg:o1', requestHash: 'h:o1', source: 'signup_grant' }, [
      { ownerId: 'u-orphan', delta: 40, balanceAfter: 40 },
    ]);
    db.seedCommittedOp({ actionId: 'sg:o2', requestHash: 'h:o2', source: 'signup_grant' }, [
      { ownerId: 'u-orphan', delta: 30, balanceAfter: 70 },
    ]);
    // 非 signup 源（admin_adjust）：不算孤儿（只诊断赠送）
    seedConsistent(db, 'u-other', 5);
    const redis = new FakeRedis();
    const svc = mkService(db, redis);

    const result = await svc.runReconcileOnce();

    expect(result.orphanSignupGrants).toBe(1);
    expect(await metricValue(currencyOrphanSignupGrants)).toBe(1);
    expect(
      warnSpy.mock.calls.map((args) => String(args[0])).some((msg) => msg.includes('orphan signup grants') && msg.includes('count=1')),
      '>0 必须留痕（只读诊断，warn）',
    ).toBe(true);

    // 修数据（登记 users 行）⇒ 下一轮归零、不再响亮
    db.registeredUsers.add('u-orphan');
    const second = await svc.runReconcileOnce();
    expect(second.orphanSignupGrants).toBe(0);
    expect(await metricValue(currencyOrphanSignupGrants)).toBe(0);
  });

  it('新 gauge（§11.1 逐字）：每轮末尾刷新池余额 + 机器人账户总和（LIKE bot-% 与 owner_type=robot 两侧过滤）', async () => {
    const db = new FakeCurrencyDb();
    db.seedAccount('robot-pool', 'robot', 5_000_000);
    db.seedAccount('bot-a', 'robot', 13_000);
    db.seedAccount('bot-b', 'robot', 12_000);
    db.seedAccount('robot-other', 'robot', 999); // 不算：非 bot- 前缀（池/别的 robot 户不进总和）
    db.seedAccount('bot-human', 'user', 777); // 不算：owner_type=user（同前缀也不收）
    db.seedAccount('u-normal', 'user', 50); // 不算
    const redis = new FakeRedis();
    const svc = mkService(db, redis);

    const result = await svc.runReconcileOnce();

    expect(result.robotPoolBalance).toBe(5_000_000);
    expect(result.robotAccountsBalanceSum).toBe(13_000 + 12_000);
    expect(await metricValue(currencyRobotPoolBalance)).toBe(5_000_000);
    expect(await metricValue(currencyRobotAccountsBalanceSum)).toBe(25_000);

    // 每轮刷新（不是只算一次）：余额变化 ⇒ 下一轮读数跟着变
    db.accounts.get('robot-pool')!.balance = 1_234_567;
    db.accounts.get('bot-a')!.balance = 0;
    const second = await svc.runReconcileOnce();
    expect(second.robotPoolBalance).toBe(1_234_567);
    expect(second.robotAccountsBalanceSum).toBe(0 + 12_000);
    expect(await metricValue(currencyRobotPoolBalance)).toBe(1_234_567);
    expect(await metricValue(currencyRobotAccountsBalanceSum)).toBe(12_000);
  });

  it('新 gauge：池未种子（账户行不存在）⇒ 0（不是缺指标/NaN —— CurrencyRobotPoolLow 规则要能命中 0）', async () => {
    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    const svc = mkService(db, redis);

    const result = await svc.runReconcileOnce();

    expect(result.robotPoolBalance).toBe(0);
    expect(result.robotAccountsBalanceSum).toBe(0);
    expect(await metricValue(currencyRobotPoolBalance)).toBe(0);
    expect(await metricValue(currencyRobotAccountsBalanceSum)).toBe(0);
  });

  it('指标：runs_total 每轮开始 +1（失败轮也计）；§2.12 表 7 条指标名齐（shared registry）', async () => {
    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    const svc = mkService(db, redis);
    const before = await metricValue(currencyReconcileRunsTotal);

    await svc.runReconcileOnce();
    expect(await metricValue(currencyReconcileRunsTotal), '成功轮 +1').toBe(before + 1);

    db.directFailuresRemaining = 1; // 检查①查询抛 ⇒ 失败轮
    await expect(svc.runReconcileOnce()).rejects.toThrow('db down');
    expect(await metricValue(currencyReconcileRunsTotal), '失败轮也 +1（「每轮开始」的字面语义）').toBe(before + 2);

    // 10 条指标名齐（货币片 7 + 金币场 3；名称逐字 = 判据的一半；落错 registry 由 shared 构造器纪律保证）
    const text = await metricsRegistry().metrics();
    for (const name of METRIC_NAMES) {
      expect(metricsRegistry().getSingleMetric(name), `${name} 不在 shared registry`).toBeDefined();
      expect(text, `registry 输出里没有 ${name} 的 TYPE 行`).toMatch(new RegExp(`^# TYPE ${name} `, 'm'));
    }
  });

  it('指标：启动置 0（「从未成功」）；含漂移轮的成功一轮 set = epoch 秒（漂移是检查结果不算失败）', async () => {
    currencyReconcileLastSuccessTimestampSeconds.set(123); // 模拟别处留下的旧值 —— init 必须归 0
    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    const svc = mkService(db, redis);
    svc.onModuleInit();
    expect(
      await metricValue(currencyReconcileLastSuccessTimestampSeconds),
      '「从未成功」= 0',
    ).toBe(0);
    svc.onApplicationShutdown();

    vi.setSystemTime(T0);
    db.seedAccount('u-drift', 'user', 100); // balance 100、无流水 ⇒ 账实漂移
    const result = await svc.runReconcileOnce();
    expect(result.driftAccounts).toBe(1);
    expect(
      await metricValue(currencyReconcileLastSuccessTimestampSeconds),
      '漂移轮照 set（漂移是「检查结果」不是失败）',
    ).toBe(T0 / 1000);
  });

  it('指标：查询抛错 ⇒ last_success 不 set；定时链下留 error 行且下一轮照跑', async () => {
    vi.setSystemTime(T0);
    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    const svc = mkService(db, redis, makeCache({ intervalMs: 100 }).cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS); // 第 1 轮成功（空库）
    const ts = await metricValue(currencyReconcileLastSuccessTimestampSeconds);
    expect(ts).toBe((T0 + CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS) / 1000);
    const runsBefore = await metricValue(currencyReconcileRunsTotal);

    db.directFailuresRemaining = 1;
    await vi.advanceTimersByTimeAsync(100); // 第 2 轮：检查①查询抛
    expect(
      errorSpy.mock.calls.some((args) => String(args[0]).includes('currency reconcile failed')),
      '失败轮留 error 行（timer 来源）',
    ).toBe(true);
    expect(
      await metricValue(currencyReconcileLastSuccessTimestampSeconds),
      '查询抛错 ⇒ 不 set（保留上一次成功时间戳，不擦不编）',
    ).toBe(ts);

    await vi.advanceTimersByTimeAsync(100); // 第 3 轮照跑（失败不终止循环）
    expect(await metricValue(currencyReconcileLastSuccessTimestampSeconds)).toBe((T0 + 10_000 + 200) / 1000);
    expect(await metricValue(currencyReconcileRunsTotal), '第 2/3 轮都计入 runs').toBe(runsBefore + 2);
    svc.onApplicationShutdown();
  });

  it('T8b · 一轮一层 trace：定时链下同一轮**所有**日志行同 traceId（跨层的一对：漂移行 + 失败行）', async () => {
    const db = new FakeCurrencyDb();
    // 检查① 真漂移（balance 100、零流水）⇒ 轮内**先**出一条 drift error 行。
    db.seedAccount('u-drift', 'user', 100);
    const redis = new FakeRedis();
    // 检查② 的 get 抛 ⇒ 该轮在漂移行**之后**失败（catch 行是轮内另一层出的行）。
    redis.store.set(KEY('u-down'), '5');
    redis.failKeys.add(KEY('u-down'));
    const svc = mkService(db, redis, makeCache({ intervalMs: 100 }).cache);
    svc.onModuleInit(); // 「loop started」走 beforeEach 的哑 spy（不进本用例的捕获面）

    // 捕获形态 = 现有夹具的最近变体：spy 的 mock 里读 ALS 当前上下文 —— 与
    // `redacting-logger.ts` 渲染行时 `currentTrace()` 的读点同一位置/同一时机，
    // 不改用 sink/overrideLogger（不为此大造夹具）。
    const lines: Array<{ msg: string; traceId: string | null | undefined; source: string | undefined }> = [];
    const record = (msg: unknown): void => {
      const ctx = currentTrace();
      lines.push({ msg: String(msg), traceId: ctx?.traceId, source: ctx?.source });
    };
    logSpy.mockImplementation(record);
    errorSpy.mockImplementation(record);

    // 第 1 轮：检查①漂移行（内层）→ 检查②抛 → 失败行（外层）—— 修复前这两行分属两个 traceId。
    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS);
    const round1 = [...lines];
    expect(round1, '反空测：一轮恰两行 —— 漂移行 + 失败行（跨层的一对）').toHaveLength(2);
    expect(round1[0]!.msg, '轮内先出检查①的漂移行').toContain('currency reconcile drift');
    expect(round1[1]!.msg, '失败行在漂移行之后（catch 层）').toContain('currency reconcile failed');
    expect(round1.every((l) => l.source === 'timer'), '来源如实 = timer（这一轮）').toBe(true);
    expect(round1.every((l) => typeof l.traceId === 'string' && l.traceId.length > 0), '每轮自建 id（不许 null/undefined）').toBe(true);
    const ids1 = new Set(round1.map((l) => l.traceId));
    expect(ids1.size, `一轮恰一个 traceId（收到：${[...ids1].join(' / ')}）`).toBe(1);

    // 第 2 轮：同形再失败 ⇒ 仍是「一轮一层」，且 id 是**这一轮**新自建的（不复用上一轮）。
    await vi.advanceTimersByTimeAsync(100);
    const round2 = lines.slice(round1.length);
    expect(round2.map((l) => l.msg).some((m) => m.includes('currency reconcile drift'))).toBe(true);
    expect(round2.map((l) => l.msg).some((m) => m.includes('currency reconcile failed'))).toBe(true);
    expect(new Set(round2.map((l) => l.traceId)).size, '第 2 轮同判据').toBe(1);
    expect(round2[0]!.traceId, '每轮自建：第 2 轮 id ≠ 第 1 轮 id').not.toBe(round1[0]!.traceId);

    // 第 3 轮：撤故障 ⇒ 成功轮（漂移行 + 摘要行）同 id（摘要行也须在同一个包裹里）。
    redis.failKeys.delete(KEY('u-down'));
    redis.store.delete(KEY('u-down'));
    await vi.advanceTimersByTimeAsync(100);
    const round3 = lines.slice(round1.length + round2.length);
    expect(round3.map((l) => l.msg).some((m) => m.includes('currency reconcile done')), '成功轮摘要').toBe(true);
    expect(new Set(round3.map((l) => l.traceId)).size, '成功轮同判据').toBe(1);

    svc.onApplicationShutdown();
  });

  it('同一计数器的第二写点（§2.12 表末行）：apply 写穿失败 ⇒ warn（cache_write_failed）+ counter inc', async () => {
    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    redis.failKeys.add(KEY('u-a')); // 注入 SET 抛
    const apply = new ApplyService(db.dataSource as unknown as DataSource, redis as unknown as Redis);
    const before = await metricValue(currencyReconcileCacheDriftTotal);

    const res = await apply.apply({
      actionId: 'admin:t8-writethrough',
      source: 'admin_adjust',
      actor: 'admin',
      reason: 'T8 写穿失败注入',
      entries: [{ ownerId: 'u-a', delta: 10 }],
    });

    expect(res.ok).toBe(true); // 不回滚（权威值在 MySQL 与响应里）
    expect(
      warnSpy.mock.calls.some((args) => String(args[0]).includes('cache_write_failed')),
    ).toBe(true);
    expect(await metricValue(currencyReconcileCacheDriftTotal)).toBe(before + 1);
  });
});
