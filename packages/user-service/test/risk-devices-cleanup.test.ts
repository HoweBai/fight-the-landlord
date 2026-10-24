/**
 * `DevicesCleanupService` 的行为面 —— 风控片 T4 / 规格 §2.8「设备清理」行 / 设计 §5.6
 * （C20 的清理半边）；本片 T7：间隔 = 配置第 39 键 `risk.devicesCleanupIntervalMs`
 * （**排期处现读**）+ 首排动作（⚙️5–⚙️7）：user-service 的第二条**自调度清理**
 * （设备记录保留期到了删旧行）。
 *
 * ─── 夹具（两件，形态照 `records-cleanup.test.ts` 成例）──────────────────────
 *  - **假 DB**：仿真 `DELETE … WHERE last_seen_at < ? LIMIT 1000` 的真语义（过滤 +
 *    每批至多 1000 + `affectedRows` 回执）——cutoff 边界、批删循环全在「库行为」这层；
 *    按序打桩会把断言退化成「实现调了几次」。真 InnoDB 的最终证据在 T13 真栈回归。
 *  - **假时钟**：vitest fake timers 驱动自重排链（30s 首轮 / 重排现读 / 首排等待 / 关停闸）；
 *    删除语义用例直接 `runCleanupOnce(T0)` **注入 now**（cutoff 逐毫秒的确定性）。
 *
 * ─── 覆盖（brief Step 1；env 注入族已迁移为假缓存注入）──────────────────────
 *  ① 节奏：启动后 30s 首轮；随后按缓存现读值自重排（边界两侧）
 *  ② 重排现读（本片核心 ⚙️7）：一轮跑完 ⇒ 下一轮延迟 = 现读值；改值 ⇒ 再下一轮用新值
 *  ③ 首排动作（本片 ⚙️5/⚙️6）：快路径同帧 / 晚到用缓存值 / 超时按缺省 /
 *     超时后迟到恰一次排期 / 等待期间关停零排期 / 启动行 interval 位 = 解析值
 *  ④ 删除语义：cutoff 边界逐毫秒（`<` 才删）+ >1000 行批删循环（每条带 LIMIT 1000）
 *  ⑤ cutoff 现读：改缓存 getter ⇒ 下一轮 cutoff 变（每轮读一次，不是构造时读一次）
 *  ⑥ 关停闸：在途一轮时关停 ⇒ 迟到回执不再排下一轮、放行后不再跑
 *  ⑦ 日志/失败面：每轮一条心跳（零删除也留）；一轮抛 ⇒ error 行且循环继续
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger, type LogRecord } from '@fight-the-landlord/shared';
import {
  DevicesCleanupService,
  RISK_DEVICES_CLEANUP_BATCH_SIZE,
  RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS,
  RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS,
} from '../src/risk/devices-cleanup.service';
import { SNAPSHOT_BOOT_WAIT_MS, type ConfigCacheService } from '../src/config/config-cache.service';

const DAY_MS = 86_400_000;
/** 固定时间轴原点（删除语义用例的 `now` 注入；不随真实时钟漂移）。 */
const T0 = Date.parse('2026-10-05T12:00:00.000Z');

interface Statement {
  sql: string;
  params: unknown[];
}

interface DeviceRow {
  last_seen_at: Date;
}

/** 本实现的删除语句形状（批大小 `LIMIT` 在末尾；规格 §2.8 的裸 SQL 逐字）。 */
const DELETE_RE = /^DELETE FROM user_devices WHERE last_seen_at < \? LIMIT (\d+)$/;

/** 单表最小仿真：删前 n 个命中行、回 `{ affectedRows: 命中数 }`；`holdNextQuery` = 在途一轮注入面。 */
class FakeCleanupDb {
  rows: DeviceRow[] = [];
  /** **全部**语句的观测面（cutoff 参数 / 批大小 / 批数全靠它）。 */
  statements: Statement[] = [];
  /** > 0 ⇒ 该次 query 直接 reject（每次消一个）。 */
  failuresRemaining = 0;
  /** 非 null ⇒ 下一条 query 挂起（返回该 promise），由用例放行。 */
  private held: Promise<unknown> | null = null;

  holdNextQuery(): { resolve: (value: unknown) => void } {
    let resolve!: (value: unknown) => void;
    this.held = new Promise((r) => (resolve = r));
    return { resolve };
  }

  dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.statements.push({ sql, params });
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        return Promise.reject(new Error('db down（仿真）'));
      }
      if (this.held !== null) {
        const held = this.held;
        this.held = null;
        return held;
      }
      const m = DELETE_RE.exec(sql);
      if (!m) return Promise.reject(new Error(`FakeCleanupDb 未识别的 SQL：${sql}`));
      const affected = this.deleteOld((params[0] as Date).getTime(), Number(m[1]));
      return Promise.resolve({ affectedRows: affected });
    },
  };

  /** `DELETE … WHERE last_seen_at < cutoff LIMIT n`：删**前 n 个**命中行。 */
  private deleteOld(cutoffMs: number, limit: number): number {
    const removed = new Set(
      this.rows.filter((r) => r.last_seen_at.getTime() < cutoffMs).slice(0, limit),
    );
    if (removed.size > 0) this.rows = this.rows.filter((r) => !removed.has(r));
    return removed.size;
  }
}

/**
 * 假 ConfigCache（getter 是 `vi.fn`，用例可以改值模拟「改键 + 缓存已刷新」；
 * 接口四件套 = 本片 T7 起循环消费面：`riskDeviceRetentionDays` / `devicesCleanupIntervalMs` /
 * 首排两把手 `hasSnapshot`（就绪）/ `waitForFirstSnapshot`（已 resolve）—— 形态照
 * `records-cleanup.test.ts` 的 `makeCache`）。
 */
function makeCache(opts: { days?: number; intervalMs?: number }): {
  cache: ConfigCacheService;
  riskDeviceRetentionDays: ReturnType<typeof vi.fn>;
  devicesCleanupIntervalMs: ReturnType<typeof vi.fn>;
} {
  const riskDeviceRetentionDays = vi.fn(() => opts.days ?? 365);
  const devicesCleanupIntervalMs = vi.fn(() => opts.intervalMs ?? 3_600_000);
  const cache = {
    riskDeviceRetentionDays,
    devicesCleanupIntervalMs,
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
  } as unknown as ConfigCacheService;
  return { cache, riskDeviceRetentionDays, devicesCleanupIntervalMs };
}

describe('DevicesCleanupService（风控片 T4：设备记录保留期清理）', () => {
  let captured: ReturnType<typeof createCapturingSink>;

  beforeEach(() => {
    captured = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'user-service' }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    Logger.overrideLogger(new Logger()); // 进程级开关，用后必须还原
    vi.useRealTimers();
  });

  it('节奏：启动后 30s 首轮；随后按缓存现读的 1h 默认自重排（advance 边界两侧）', async () => {
    // 规格 §2.8「设备清理」行 + section 骨架写死的三个常数本身就是判据的一半
    // （`RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS` 现为 `config-cache.service` 的 re-export
    // —— 引用面不变）。
    expect(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS).toBe(30_000);
    expect(RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS).toBe(3_600_000);
    expect(RISK_DEVICES_CLEANUP_BATCH_SIZE).toBe(1000);

    const db = new FakeCleanupDb();
    db.rows.push({ last_seen_at: new Date(Date.now() - 400 * DAY_MS) });
    const { cache } = makeCache({ days: 365 });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS - 1);
    expect(db.statements, '29.999s 时点：首轮还没到').toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.statements, '首轮真的跑了').toHaveLength(1);
    expect(db.rows, '400 天旧行被删（默认保留 365 天）').toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS - 1);
    expect(db.statements, '默认间隔 = 1h（未到点：不排第 2 轮）').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.statements).toHaveLength(2); // 第 2 轮

    svc.onApplicationShutdown();
  });

  it('假缓存注入：devicesCleanupIntervalMs=100 ⇒ 第 2 轮触发点 = 第 1 轮结束 + 100（+99 不触发）', async () => {
    const db = new FakeCleanupDb();
    const { cache } = makeCache({ days: 365, intervalMs: 100 });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS);
    expect(db.statements, '首轮仍在 30s（配置的是**间隔**，不是首轮延迟）').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(db.statements, '第 1 轮结束 + 99ms：第 2 轮还没到点').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.statements, '第 2 轮触发点 = 第 1 轮结束 + 100（重排处现读的缓存注入值）').toHaveLength(2);

    svc.onApplicationShutdown();
  });

  it('重排现读（本片核心 ⚙️7）：一轮跑完 ⇒ 下一轮延迟 = 现读值；改值 ⇒ 再下一轮用新值', async () => {
    const db = new FakeCleanupDb();
    const { cache, devicesCleanupIntervalMs } = makeCache({ days: 365 });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);
    expect(
      devicesCleanupIntervalMs,
      '构造期不得读间隔（旧形态 = 构造期读 env —— 「现读」的判别力靠这个前置态支撑）',
    ).not.toHaveBeenCalled();

    svc.onModuleInit(); // 快路径：hasSnapshot=true ⇒ 同帧打启动行（读 #1）+ 排首轮 30s
    expect(devicesCleanupIntervalMs, '启动行恰读一次').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS); // 首轮跑完
    expect(db.statements).toHaveLength(1);
    expect(devicesCleanupIntervalMs, '排期处恰再读一次（读 #2）').toHaveBeenCalledTimes(2);

    // 首轮收尾现读 = 默认 3600000 ⇒ 第 2 轮 @ +3600000。改值发生在其后 ⇒ 已排定的一轮不撤：
    devicesCleanupIntervalMs.mockReturnValue(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(db.statements, '改值不撤已排定的一轮（+3000 时点第 2 轮仍未到）').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000 - 3_000);
    expect(
      db.statements,
      '第 2 轮触发点 = 第 1 轮结束 + 3600000（旧形态「构造期读一次」也能过这句——判别力在下一段）',
    ).toHaveLength(2);

    // 第 2 轮收尾现读 = 新值 3000 ⇒ 第 3 轮 @ +3000（改键自该轮收尾排期起生效）：
    await vi.advanceTimersByTimeAsync(2_999);
    expect(db.statements, '3000 改值后 +2999：第 3 轮未到点').toHaveLength(2);
    devicesCleanupIntervalMs.mockReturnValue(7_000); // 第 3 轮未跑完：再改（影响第 3 轮收尾的现读）
    await vi.advanceTimersByTimeAsync(1);
    expect(
      db.statements,
      '第 3 轮触发点 = 第 2 轮结束 + 3000（现读新值 3000 —— 构造期读一次的实现这里会是 +3600000）',
    ).toHaveLength(3);

    // 第 3 轮收尾现读 = 7000 ⇒ 第 4 轮 @ +7000：
    await vi.advanceTimersByTimeAsync(6_999);
    expect(db.statements).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.statements, '第 4 轮触发点 = 第 3 轮结束 + 7000（再次现读）').toHaveLength(4);

    svc.onApplicationShutdown();
  });

  it('首排动作三态：晚到（wait 后 resolve ⇒ 用缓存值）/超时（缺省）/超时后迟到 ⇒ 恰一次排期', async () => {
    const startedLines = (): LogRecord[] =>
      captured.records.filter((r) => r.msg.includes('Risk devices cleanup loop started'));

    // 态 1 · 晚到：hasSnapshot=false，快照在等待窗内就绪 ⇒ 续体用缓存值打行 + 排首轮。
    {
      const db = new FakeCleanupDb();
      const { cache } = makeCache({ intervalMs: 3_000 });
      let resolveWait!: () => void;
      const wait = new Promise<void>((r) => (resolveWait = r));
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => wait;
      const svc = new DevicesCleanupService(db.dataSource as never, cache);

      svc.onModuleInit();
      expect(startedLines(), '等待期：启动行还没打（打印唯一落点 = afterSnapshotReady）').toHaveLength(0);
      expect(vi.getTimerCount(), '等待路：有界等待定时器恰一枚').toBe(1);

      resolveWait(); // 快照就绪（早于超时）
      await vi.advanceTimersByTimeAsync(0); // 微任务冲刷：settle ⇒ afterSnapshotReady
      expect(startedLines()).toHaveLength(1);
      expect(startedLines()[0]!.msg, '晚到路：interval = 缓存解析值（非缺省）').toContain(
        'interval 3000ms',
      );
      expect(vi.getTimerCount(), '败方定时器已清 + 首轮已排 = 恰一枚').toBe(1);

      db.rows.push({ last_seen_at: new Date(Date.now() - 400 * DAY_MS) });
      await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS);
      expect(db.statements, '晚到路：首轮仍按 30s 常数排').toHaveLength(1);
      svc.onApplicationShutdown();
    }

    // 态 2 · 超时：等待窗（SNAPSHOT_BOOT_WAIT_MS）到点 ⇒ 按缺省解析先打行排期（降级拓扑；下一轮重排自愈）。
    {
      const db = new FakeCleanupDb();
      const { cache } = makeCache({}); // 缺省 3600000 = 缓存「快照不可用回落种子」的替身
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => new Promise<void>(() => {}); // 永不就绪
      const svc = new DevicesCleanupService(db.dataSource as never, cache);

      svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_BOOT_WAIT_MS - 1);
      expect(startedLines(), '超时前 1ms：仍未打行排期（有界等待的上界）').toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(startedLines(), '超时到点：按缺省解析打行排期').toHaveLength(2);
      expect(startedLines()[1]!.msg).toContain('interval 3600000ms');
      expect(vi.getTimerCount(), '等待定时器已消费 + 首轮在挂 = 恰一枚').toBe(1);

      db.rows.push({ last_seen_at: new Date(Date.now() - 400 * DAY_MS) });
      await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS);
      expect(db.statements, '降级拓扑照样跑首轮').toHaveLength(1);
      svc.onApplicationShutdown();
    }

    // 态 3 · 超时后迟到（r1 🟠1 的要害形态）：once 闸让就绪路 no-op —— 否则双排期双链。
    {
      const db = new FakeCleanupDb();
      const { cache } = makeCache({ intervalMs: 3_000 });
      let resolveWait!: () => void;
      const wait = new Promise<void>((r) => (resolveWait = r));
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => wait;
      const svc = new DevicesCleanupService(db.dataSource as never, cache);

      svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_BOOT_WAIT_MS); // 超时路先赢（打行 + 排 30s 首轮）
      expect(startedLines()).toHaveLength(3);
      expect(vi.getTimerCount(), '首轮已排 = 恰一枚').toBe(1);

      resolveWait(); // 快照 >10s 迟到
      await vi.advanceTimersByTimeAsync(0);
      expect(
        startedLines(),
        'once 闸：就绪路 no-op（双排期实现这里会打第二条启动行）',
      ).toHaveLength(3);
      expect(vi.getTimerCount(), 'once 闸：不双排期（双链实现这里是 2）').toBe(1);

      db.rows.push({ last_seen_at: new Date(Date.now() - 400 * DAY_MS) });
      await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS);
      expect(db.statements, '恰一条链：30s 到点恰跑一轮（双链会跑两轮）').toHaveLength(1);
      expect(vi.getTimerCount(), '该轮收尾重排（现读 3000）= 恰一枚').toBe(1);
      svc.onApplicationShutdown();
    }
  });

  it('首排动作：续体关停闸（等待期间 shutdown ⇒ 零排期；getTimerCount()===0 终态）', async () => {
    const db = new FakeCleanupDb();
    const { cache } = makeCache({ intervalMs: 3_000 });
    let resolveWait!: () => void;
    const wait = new Promise<void>((r) => (resolveWait = r));
    cache.hasSnapshot = () => false;
    cache.waitForFirstSnapshot = () => wait;
    const svc = new DevicesCleanupService(db.dataSource as never, cache);

    svc.onModuleInit();
    expect(vi.getTimerCount(), '反空测：等待定时器在挂').toBe(1);

    svc.onApplicationShutdown(); // 等待期间关停
    resolveWait(); // 就绪路迟到：settle ⇒ afterSnapshotReady（关停闸在此拦住）
    await vi.advanceTimersByTimeAsync(0);

    expect(
      captured.records.filter((r) => r.msg.includes('Risk devices cleanup loop started')),
      '关停闸：迟到的续体不得打启动行、不得排期',
    ).toHaveLength(0);
    expect(vi.getTimerCount(), '终态：胜方 settle 清掉等待定时器 + 零排期').toBe(0);
    await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS + 1);
    expect(db.statements, '关停后零轮（无复活链）').toHaveLength(0);
  });

  it('启动行 interval 位 = 解析值（⚙️6 逐字；快路径同帧打印）', () => {
    const db = new FakeCleanupDb();
    const { cache } = makeCache({ intervalMs: 3_000 });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);

    svc.onModuleInit();
    // 快路径「真同步」的证明方式 = 本测试全程不 await、不推进定时器：
    // `onModuleInit` 返回时启动行**已在 sink 里**，首轮定时器**已挂上**（同帧解析+打+排）。
    const started = captured.records.filter((r) => r.msg.includes('Risk devices cleanup loop started'));
    expect(started).toHaveLength(1);
    expect(started[0]!.msg).toBe(
      'Risk devices cleanup loop started (first run in 30000ms, interval 3000ms)',
    );
    expect(vi.getTimerCount(), '首轮定时器同帧排定').toBe(1);
    expect(db.statements, '排首轮 ≠ 跑首轮（同帧不得有查询）').toHaveLength(0);

    svc.onApplicationShutdown();
  });

  it('旧行删 / 界内留：cutoff 边界逐毫秒（`last_seen_at < cutoff` 才删——未满保留期一行不动）', async () => {
    const db = new FakeCleanupDb();
    const days = 30;
    const cut = T0 - days * DAY_MS;
    for (const at of [cut - 1, cut, cut + 1, T0]) db.rows.push({ last_seen_at: new Date(at) });
    const { cache } = makeCache({ days });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);

    const result = await svc.runCleanupOnce(T0); // now 注入：边界确定性

    expect(result).toEqual({ devicesDeleted: 1 });
    expect(db.rows.map((r) => r.last_seen_at.getTime())).toEqual([cut, cut + 1, T0]);
    // 机制证据：cutoff 参数 = now − riskDeviceRetentionDays 天（逐毫秒相等）。
    expect(db.statements[0]!.params[0]).toEqual(new Date(cut));
    // 裸 SQL 逐字（规格 §2.8；LIMIT 在末尾——批大小内插）。
    expect(db.statements[0]!.sql).toBe('DELETE FROM user_devices WHERE last_seen_at < ? LIMIT 1000');
  });

  it('批删：>1000 行走 LIMIT 1000 循环（剥到不满一批停；界内新行原样保留）', async () => {
    const db = new FakeCleanupDb();
    const old = T0 - 3 * DAY_MS;
    for (let i = 0; i < 2500; i += 1) db.rows.push({ last_seen_at: new Date(old - i) });
    for (let i = 0; i < 5; i += 1) db.rows.push({ last_seen_at: new Date(T0) }); // 新行：批删不许碰
    const { cache } = makeCache({ days: 1 });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);

    const result = await svc.runCleanupOnce(T0);

    expect(result).toEqual({ devicesDeleted: 2500 });
    expect(db.rows, '界内新行原样保留').toHaveLength(5);
    // 批数 = ceil(2500/1000) = 3 —— 单发 DELETE（无循环）在这条用例上红。
    expect(db.statements).toHaveLength(3);
    for (const s of db.statements) {
      expect(s.sql, '每条 DELETE 都必须带批大小（否则一次删光 = 长事务）').toMatch(/LIMIT 1000$/);
      expect(s.params[0]).toEqual(new Date(T0 - DAY_MS)); // 同一 cutoff
    }
  });

  it('cutoff 现读配置（C20）：改 getter 值 ⇒ 下一轮生效（100 天旧行先存活、改 30 天后被删）', async () => {
    const db = new FakeCleanupDb();
    db.rows.push({ last_seen_at: new Date(T0 - 100 * DAY_MS) });
    const { cache, riskDeviceRetentionDays } = makeCache({ days: 365 });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);

    await svc.runCleanupOnce(T0); // 第 1 轮：保留 365 天 ⇒ 100 天旧行**界内**，不被删
    expect(db.rows).toHaveLength(1);
    expect(riskDeviceRetentionDays).toHaveBeenCalledTimes(1); // 每轮读缓存（不是构造时读一次）
    expect(db.statements[0]!.params[0]).toEqual(new Date(T0 - 365 * DAY_MS));

    riskDeviceRetentionDays.mockReturnValue(30); // 改键 + 缓存已刷新（缓存侧由 config-cache.test.ts 钉）
    await svc.runCleanupOnce(T0); // 第 2 轮：同一 now、cutoff 变了 ⇒ 该行出界
    expect(db.rows).toHaveLength(0);
    expect(riskDeviceRetentionDays).toHaveBeenCalledTimes(2);
    expect(db.statements[1]!.params[0]).toEqual(new Date(T0 - 30 * DAY_MS));
  });

  it('日志：每轮一条心跳（删除行数 + 保留天数 + 耗时；timer 来源 + 自建 id）——零删除轮也留', async () => {
    const db = new FakeCleanupDb();
    db.rows.push({ last_seen_at: new Date(Date.now() - 400 * DAY_MS) });
    const { cache } = makeCache({ days: 365 });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS);
    const rounds = (): LogRecord[] =>
      captured.records.filter((r) => r.msg.includes('risk devices cleanup done'));
    expect(rounds()).toHaveLength(1);
    const line = rounds()[0]!;
    expect(line.level).toBe('log');
    expect(line.source).toBe('timer'); // 定时器起的一轮 ⇒ 来源如实（不是 bootstrap）
    expect(line.traceId).not.toBeNull(); // 每轮自建 id
    expect(line.msg).toContain('deletedDevices=1');
    expect(line.msg).toMatch(/durationMs=\d+/);
    expect(line.msg).toContain('retentionDays=365');

    await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS); // 第 2 轮：零删除
    expect(rounds(), '零删除轮也留一条心跳（否则 1h 一轮的循环「活着没有」无法从日志判读）').toHaveLength(2);
    expect(rounds()[1]!.msg).toContain('deletedDevices=0');

    svc.onApplicationShutdown();
  });

  it('失败姿态：一轮抛 ⇒ error 行（timer 来源）且循环继续（下一轮照排、照删）', async () => {
    const db = new FakeCleanupDb();
    db.rows.push({ last_seen_at: new Date(Date.now() - 400 * DAY_MS) });
    db.failuresRemaining = 1;
    const { cache } = makeCache({ days: 365, intervalMs: 100 });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS);
    const errors = captured.records.filter((r) => r.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toContain('risk devices cleanup failed');
    expect(errors[0]!.source).toBe('timer');
    expect(errors[0]!.traceId).not.toBeNull();
    expect(db.rows, '第 1 轮失败：一行未删').toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(db.rows, '第 2 轮照常跑（失败不终止循环）').toHaveLength(0);

    svc.onApplicationShutdown();
  });

  it('关停闸：第 1 轮在途时关停 ⇒ 迟到的回执不再排下一轮（片⑦ T6/T7 的同款闸）', async () => {
    const db = new FakeCleanupDb();
    const { cache } = makeCache({ days: 365, intervalMs: 100 });
    const svc = new DevicesCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    const gate = db.holdNextQuery();
    await vi.advanceTimersByTimeAsync(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS); // 第 1 轮在途（挂起）
    expect(db.statements, '反空测：第 1 轮必须真的在途').toHaveLength(1);

    svc.onApplicationShutdown(); // 在途期间关停
    gate.resolve({ affectedRows: 0 }); // 迟到的回执（第 1 轮结束）
    await vi.advanceTimersByTimeAsync(0);
    const settled = db.statements.length; // 本轮自己的收尾已落

    expect(
      (svc as unknown as { timer: unknown }).timer,
      '关停后不得再排定时器（闸被删掉时这里会非 null）',
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS);
    expect(db.statements, '放行后不得再跑（无复活循环）').toHaveLength(settled);
  });
});
