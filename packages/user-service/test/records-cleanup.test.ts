/**
 * `RecordsCleanupService` 的行为面 —— 记录片 T7 / 规格 §2.5 / §3 C8（单测半边）/ 设计 D5；
 * 本片 T5：间隔 = 配置第 40 键 `record.cleanupIntervalMs`（**排期处现读**）+ 首排动作（⚙️5–⚙️7）：
 * user-service 的**自调度清理**（保留期到了删两表旧行）。
 *
 * ─── 夹具（两件，形态照 T4/T6 成例）──────────────────────────────────────
 *  - **假 DB**：不是「按调用序返回剧本」的桩 —— 它仿真 `DELETE … WHERE ended_at < ?
 *    LIMIT 1000` 的**真语义**（过滤 + 每批至多 1000 + `affectedRows` 回执），因为本任务的
 *    承重语义（cutoff 边界、批删循环、两表各自成环）全在「库行为」这一层；按序打桩会把
 *    断言退化成「实现调了几次」。真 InnoDB 的最终证据在 T9 conformance（C8 真栈半边）。
 *  - **假时钟**：vitest fake timers 驱动自重排链（30s 首轮 / 重排现读 / 首排等待 / 关停闸）；
 *    删除语义用例直接 `runCleanupOnce(T0)` **注入 now**（边界逐毫秒的确定性）。
 *
 * ─── 覆盖（brief Step 1；env 注入族已迁移为假缓存注入）──────────────────────
 *  ① 节奏：启动后 30s 首轮；随后按缓存现读值自重排（边界两侧）
 *  ② 重排现读（本片核心 ⚙️7）：一轮跑完 ⇒ 下一轮延迟 = 现读值；改值 ⇒ 再下一轮用新值
 *  ③ 首排动作（本片 ⚙️5/⚙️6）：快路径同帧 / 晚到用缓存值 / 超时按缺省 /
 *     超时后迟到恰一次排期 / 等待期间关停零排期 / 启动行 interval 位 = 解析值
 *  ④ 删除语义：旧行删 / 界内留（cutoff 边界逐毫秒）；>1000 行批删（两表各自成环）
 *  ⑤ C8 半边：改缓存值 ⇒ 下一轮 cutoff 变（100 天旧行先存活、后出界被删）
 *  ⑥ 日志（九字段行含删除行数 + 耗时；timer 来源 + 自建 id）、失败姿态、关停闸
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  createCapturingSink,
  createRedactingLogger,
  metricsRegistry,
  type LogRecord,
} from '@fight-the-landlord/shared';
import {
  RecordsCleanupService,
  RECORDS_CLEANUP_BATCH_SIZE,
  RECORDS_CLEANUP_DEFAULT_INTERVAL_MS,
  RECORDS_CLEANUP_FIRST_RUN_DELAY_MS,
} from '../src/records/records-cleanup.service';
import {
  recordsCleanupLastSuccessTimestampSeconds,
  recordsTableBytes,
} from '../src/records/records.metrics';
import { SNAPSHOT_BOOT_WAIT_MS, type ConfigCacheService } from '../src/config/config-cache.service';

const DAY_MS = 86_400_000;
/** 固定时间轴原点（删除语义用例的 `now` 注入；不随真实时钟漂移）。 */
const T0 = Date.parse('2026-10-03T12:00:00.000Z');

interface Statement {
  sql: string;
  params: unknown[];
}

interface CleanupRow {
  ended_at: Date;
}

/** 本实现的删除语句形状（批大小 `LIMIT` 在末尾；表名二选一）。 */
const DELETE_RE = /^DELETE FROM `(game_record_players|game_records|game_record_players_pdk|game_records_pdk)` WHERE `ended_at` < \? LIMIT (\d+)$/;

/**
 * 两表的**最小仿真**：`DELETE … WHERE ended_at < ? LIMIT n` ⇒ 删前 n 个命中行、回
 * `{ affectedRows: 命中数 }`。`holdNextQuery()` / `failuresRemaining` 是两条注入面
 * （在途一轮 / 失败姿态）。
 */
class FakeCleanupDb {
  records: CleanupRow[] = [];
  players: CleanupRow[] = [];
  /** S7.2：pdk 两表（`ended_at` 是 BIGINT 毫秒；仿真里同样用 Date 存毫秒值便于复用断言）。 */
  pdkRecords: CleanupRow[] = [];
  pdkPlayers: CleanupRow[] = [];
  /** **全部**语句的观测面（cutoff 参数 / 批大小 / 批数全靠它）。 */
  statements: Statement[] = [];
  /** > 0 ⇒ 该次 query 直接 reject（每次消一个）。 */
  failuresRemaining = 0;
  /** T6：`information_schema` 采样的回执值（两表 DATA+INDEX 之和的替身）。 */
  tableBytes = 4096;
  /** T6：true ⇒ 采样查询直接 reject（「查询失败不得影响清理本身」的用例）。 */
  failTableBytes = false;
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
      // 监控片 T6：成功轮末尾的 information_schema 采样（`records_table_bytes`）。
      if (sql.includes('information_schema.TABLES')) {
        if (this.failTableBytes) return Promise.reject(new Error('information_schema 不可用（仿真）'));
        return Promise.resolve([{ bytes: this.tableBytes }]);
      }
      const m = DELETE_RE.exec(sql);
      if (!m) return Promise.reject(new Error(`FakeCleanupDb 未识别的 SQL：${sql}`));
      const which =
        m[1] === 'game_records'
          ? 'records'
          : m[1] === 'game_record_players'
            ? 'players'
            : m[1] === 'game_records_pdk'
              ? 'pdkRecords'
              : 'pdkPlayers';
      const cutoffMs =
        params[0] instanceof Date ? params[0].getTime() : Number(params[0]);
      const affected = this.deleteOld(which, cutoffMs, Number(m[2]));
      return Promise.resolve({ affectedRows: affected });
    },
  };

  /** `DELETE … WHERE ended_at < cutoff LIMIT n`：删**前 n 个**命中行。 */
  private deleteOld(
    which: 'records' | 'players' | 'pdkRecords' | 'pdkPlayers',
    cutoffMs: number,
    limit: number,
  ): number {
    const rows = this[which];
    const removed = new Set(rows.filter((r) => r.ended_at.getTime() < cutoffMs).slice(0, limit));
    if (removed.size > 0) this[which] = rows.filter((r) => !removed.has(r));
    return removed.size;
  }
}

/**
 * 假 ConfigCache（getter 是 `vi.fn`，用例可以改值模拟「改键 + 缓存已刷新」；
 * 接口四件套 = 本片 T5 起循环消费面：`retentionDays` / `recordsCleanupIntervalMs` / 首排两把手）。
 */
function makeCache(opts: { days?: number; intervalMs?: number }) {
  const retentionDays = vi.fn(() => opts.days ?? 365);
  const recordsCleanupIntervalMs = vi.fn(() => opts.intervalMs ?? 3_600_000);
  const cache = {
    retentionDays,
    recordsCleanupIntervalMs,
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
  } as unknown as ConfigCacheService;
  return { cache, retentionDays, recordsCleanupIntervalMs };
}

/** 本表收到过的 DELETE 语句（按发生顺序）。 */
const deletesFor = (db: FakeCleanupDb, table: 'game_records' | 'game_record_players') =>
  db.statements.filter((s) => s.sql.startsWith(`DELETE FROM \`${table}\``));

/**
 * 监控片 T6：从 shared registry 的**文本输出**读一条**无标签**指标的当前值
 * （名称写错/落错 registry ⇒ 抛错，绝不静默回 0 假绿）。
 */
async function simpleMetric(name: string): Promise<number> {
  const text = await metricsRegistry().metrics();
  const m = new RegExp(`^${name} (-?[\\d.eE+]+)$`, 'm').exec(text);
  if (!m) throw new Error(`registry 输出里没有 ${name}（指标名写错或没落进 shared registry？）`);
  return Number(m[1]);
}

/** A1：带标签指标读数（缺序列 ⇒ 0）。 */
async function labeledMetricByGame(name: string, labels: Record<string, string>): Promise<number> {
  const text = await metricsRegistry().metrics();
  const hit = text.split('\n').find((line) => line.startsWith(`${name}{`) &&
    Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`)));
  return hit ? Number(hit.slice(hit.lastIndexOf(' ') + 1)) : 0;
}

describe('RecordsCleanupService（记录片 T7：保留期清理）', () => {
  let captured: ReturnType<typeof createCapturingSink>;

  beforeEach(() => {
    captured = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'user-service' }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    Logger.overrideLogger(new Logger()); // M4：进程级开关，用后必须还原
    vi.useRealTimers();
  });

  it('节奏：启动后 30s 首轮；随后按缓存现读的 1h 默认自重排（advance 边界两侧）', async () => {
    // 设计 D5 的节奏**写死**（规格 §2.5 逐字）：常量的值本身就是判据的一半
    // （`RECORDS_CLEANUP_DEFAULT_INTERVAL_MS` 现为 `config-cache.service` 的 re-export —— 引用面不变）。
    expect(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS).toBe(30_000);
    expect(RECORDS_CLEANUP_DEFAULT_INTERVAL_MS).toBe(3_600_000);

    const db = new FakeCleanupDb();
    db.records.push({ ended_at: new Date(Date.now() - 400 * DAY_MS) });
    db.players.push({ ended_at: new Date(Date.now() - 400 * DAY_MS) });
    const { cache } = makeCache({ days: 365 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS - 1);
    expect(db.statements, '29.999s 时点：首轮还没到').toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(deletesFor(db, 'game_record_players')).toHaveLength(1); // 首轮真的跑了（两表各一批）
    expect(deletesFor(db, 'game_records')).toHaveLength(1);
    expect(db.records, '400 天旧行被删（默认保留 365 天）').toHaveLength(0);
    expect(db.players).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_DEFAULT_INTERVAL_MS - 1);
    expect(deletesFor(db, 'game_records'), '默认间隔 = 1h（未到点：不排第 2 轮）').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deletesFor(db, 'game_records')).toHaveLength(2); // 第 2 轮

    svc.onApplicationShutdown();
  });

  it('假缓存注入：recordsCleanupIntervalMs=100 ⇒ 第 2 轮触发点 = 第 1 轮结束 + 100（+99 不触发）', async () => {
    const db = new FakeCleanupDb();
    const { cache } = makeCache({ days: 365, intervalMs: 100 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS);
    expect(
      deletesFor(db, 'game_records'),
      '首轮仍在 30s（配置的是**间隔**，不是首轮延迟）',
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(deletesFor(db, 'game_records'), '第 1 轮结束 + 99ms：第 2 轮还没到点').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      deletesFor(db, 'game_records'),
      '第 2 轮触发点 = 第 1 轮结束 + 100（重排处现读的缓存注入值）',
    ).toHaveLength(2);

    svc.onApplicationShutdown();
  });

  it('重排现读（本片核心 ⚙️7）：一轮跑完 ⇒ 下一轮延迟 = 现读值；改值 ⇒ 再下一轮用新值', async () => {
    const db = new FakeCleanupDb();
    const { cache, recordsCleanupIntervalMs } = makeCache({ days: 365 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);
    expect(
      recordsCleanupIntervalMs,
      '构造期不得读间隔（旧形态 = 构造期读 env —— 「现读」的判别力靠这个前置态支撑）',
    ).not.toHaveBeenCalled();

    svc.onModuleInit(); // 快路径：hasSnapshot=true ⇒ 同帧打启动行（读 #1）+ 排首轮 30s
    expect(recordsCleanupIntervalMs, '启动行恰读一次').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS); // 首轮跑完
    expect(deletesFor(db, 'game_records')).toHaveLength(1);
    expect(recordsCleanupIntervalMs, '排期处恰再读一次（读 #2）').toHaveBeenCalledTimes(2);

    // 首轮收尾现读 = 默认 3600000 ⇒ 第 2 轮 @ +3600000。改值发生在其后 ⇒ 已排定的一轮不撤：
    recordsCleanupIntervalMs.mockReturnValue(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(
      deletesFor(db, 'game_records'),
      '改值不撤已排定的一轮（+3000 时点第 2 轮仍未到）',
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000 - 3_000);
    expect(
      deletesFor(db, 'game_records'),
      '第 2 轮触发点 = 第 1 轮结束 + 3600000（旧形态「构造期读一次」也能过这句——判别力在下一段）',
    ).toHaveLength(2);

    // 第 2 轮收尾现读 = 新值 3000 ⇒ 第 3 轮 @ +3000（改键自该轮收尾排期起生效）：
    await vi.advanceTimersByTimeAsync(2_999);
    expect(deletesFor(db, 'game_records'), '3000 改值后 +2999：第 3 轮未到点').toHaveLength(2);
    recordsCleanupIntervalMs.mockReturnValue(7_000); // 第 3 轮未跑完：再改（影响第 3 轮收尾的现读）
    await vi.advanceTimersByTimeAsync(1);
    expect(
      deletesFor(db, 'game_records'),
      '第 3 轮触发点 = 第 2 轮结束 + 3000（现读新值 3000 —— 构造期读一次的实现这里会是 +3600000）',
    ).toHaveLength(3);

    // 第 3 轮收尾现读 = 7000 ⇒ 第 4 轮 @ +7000：
    await vi.advanceTimersByTimeAsync(6_999);
    expect(deletesFor(db, 'game_records')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(deletesFor(db, 'game_records'), '第 4 轮触发点 = 第 3 轮结束 + 7000（再次现读）').toHaveLength(4);

    svc.onApplicationShutdown();
  });

  it('首排动作三态：晚到（wait 后 resolve ⇒ 用缓存值）/超时（缺省）/超时后迟到 ⇒ 恰一次排期', async () => {
    const startedLines = (): LogRecord[] =>
      captured.records.filter((r) => r.msg.includes('Records cleanup loop started'));

    // 态 1 · 晚到：hasSnapshot=false，快照在等待窗内就绪 ⇒ 续体用缓存值打行 + 排首轮。
    {
      const db = new FakeCleanupDb();
      const { cache } = makeCache({ intervalMs: 3_000 });
      let resolveWait!: () => void;
      const wait = new Promise<void>((r) => (resolveWait = r));
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => wait;
      const svc = new RecordsCleanupService(db.dataSource as never, cache);

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

      db.records.push({ ended_at: new Date(Date.now() - 400 * DAY_MS) });
      await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS);
      expect(deletesFor(db, 'game_records'), '晚到路：首轮仍按 30s 常数排').toHaveLength(1);
      svc.onApplicationShutdown();
    }

    // 态 2 · 超时：等待窗（SNAPSHOT_BOOT_WAIT_MS）到点 ⇒ 按缺省解析先打行排期（降级拓扑；下一轮重排自愈）。
    {
      const db = new FakeCleanupDb();
      const { cache } = makeCache({}); // 缺省 3600000 = 缓存「快照不可用回落种子」的替身
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => new Promise<void>(() => {}); // 永不就绪
      const svc = new RecordsCleanupService(db.dataSource as never, cache);

      svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_BOOT_WAIT_MS - 1);
      expect(startedLines(), '超时前 1ms：仍未打行排期（有界等待的上界）').toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(startedLines(), '超时到点：按缺省解析打行排期').toHaveLength(2);
      expect(startedLines()[1]!.msg).toContain('interval 3600000ms');
      expect(vi.getTimerCount(), '等待定时器已消费 + 首轮在挂 = 恰一枚').toBe(1);

      db.records.push({ ended_at: new Date(Date.now() - 400 * DAY_MS) });
      await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS);
      expect(deletesFor(db, 'game_records'), '降级拓扑照样跑首轮').toHaveLength(1);
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
      const svc = new RecordsCleanupService(db.dataSource as never, cache);

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

      db.records.push({ ended_at: new Date(Date.now() - 400 * DAY_MS) });
      await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS);
      expect(deletesFor(db, 'game_records'), '恰一条链：30s 到点恰跑一轮（双链会跑两轮）').toHaveLength(1);
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
    const svc = new RecordsCleanupService(db.dataSource as never, cache);

    svc.onModuleInit();
    expect(vi.getTimerCount(), '反空测：等待定时器在挂').toBe(1);

    svc.onApplicationShutdown(); // 等待期间关停
    resolveWait(); // 就绪路迟到：settle ⇒ afterSnapshotReady（关停闸在此拦住）
    await vi.advanceTimersByTimeAsync(0);

    expect(
      captured.records.filter((r) => r.msg.includes('Records cleanup loop started')),
      '关停闸：迟到的续体不得打启动行、不得排期',
    ).toHaveLength(0);
    expect(vi.getTimerCount(), '终态：胜方 settle 清掉等待定时器 + 零排期').toBe(0);
    await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS + 1);
    expect(db.statements, '关停后零轮（无复活链）').toHaveLength(0);
  });

  it('启动行 interval 位 = 解析值（⚙️6 逐字；快路径同帧打印）', () => {
    const db = new FakeCleanupDb();
    const { cache } = makeCache({ intervalMs: 3_000 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);

    svc.onModuleInit();
    // 快路径「真同步」的证明方式 = 本测试全程不 await、不推进定时器：
    // `onModuleInit` 返回时启动行**已在 sink 里**，首轮定时器**已挂上**（同帧解析+打+排）。
    const started = captured.records.filter((r) => r.msg.includes('Records cleanup loop started'));
    expect(started).toHaveLength(1);
    expect(started[0]!.msg).toBe(
      'Records cleanup loop started (first run in 30000ms, interval 3000ms)',
    );
    expect(vi.getTimerCount(), '首轮定时器同帧排定').toBe(1);
    expect(db.statements, '排首轮 ≠ 跑首轮（同帧不得有查询）').toHaveLength(0);

    svc.onApplicationShutdown();
  });

  it('旧行删 / 界内留：cutoff 边界逐毫秒（`ended_at < cutoff` 才删——未满保留期一行不动）', async () => {
    const db = new FakeCleanupDb();
    const days = 2;
    const cut = T0 - days * DAY_MS;
    for (const at of [cut - 1, cut, cut + 1, T0]) {
      db.records.push({ ended_at: new Date(at) });
      db.players.push({ ended_at: new Date(at) });
    }
    const { cache } = makeCache({ days });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);

    const result = await svc.runCleanupOnce(T0); // now 注入：边界确定性

    expect(result).toEqual({ recordsDeleted: 1, playersDeleted: 1 });
    expect(db.records.map((r) => r.ended_at.getTime())).toEqual([cut, cut + 1, T0]);
    expect(db.players.map((r) => r.ended_at.getTime())).toEqual([cut, cut + 1, T0]);
    // 机制证据：cutoff 参数 = now − retentionDays 天（逐毫秒相等）。
    expect(db.statements[0]!.params[0]).toEqual(new Date(cut));
  });

  it('批删：>1000 行走 LIMIT 1000 循环（两表各自成环；剥到不满一批停）', async () => {
    const db = new FakeCleanupDb();
    const old = T0 - 3 * DAY_MS;
    for (let i = 0; i < 1501; i += 1) db.records.push({ ended_at: new Date(old - i) });
    for (let i = 0; i < 2500; i += 1) db.players.push({ ended_at: new Date(old - i) });
    for (let i = 0; i < 5; i += 1) {
      db.records.push({ ended_at: new Date(T0) }); // 新行：批删不许碰
      db.players.push({ ended_at: new Date(T0) });
    }
    const { cache } = makeCache({ days: 1 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);

    const result = await svc.runCleanupOnce(T0);

    expect(result).toEqual({ recordsDeleted: 1501, playersDeleted: 2500 });
    expect(db.records, '界内新行原样保留').toHaveLength(5);
    expect(db.players).toHaveLength(5);
    // 批数 = ceil（1501/1000）= 2、ceil（2500/1000）= 3 —— 单发 DELETE（无循环）在 2500 那张表上红。
    expect(deletesFor(db, 'game_records')).toHaveLength(2);
    expect(deletesFor(db, 'game_record_players')).toHaveLength(3);
    expect(RECORDS_CLEANUP_BATCH_SIZE).toBe(1000);
    // T6 起成功轮末尾还有一条 information_schema 采样语句（`records_table_bytes`）⇒
    // 本循环只对**删除语句**断言「带批大小 + 同 cutoff」（原「全部语句」口径随之放宽）。
    for (const s of [...deletesFor(db, 'game_records'), ...deletesFor(db, 'game_record_players')]) {
      expect(s.sql, '每条 DELETE 都必须带批大小（否则一次删光 = 长事务）').toMatch(/LIMIT 1000$/);
      expect(s.params[0]).toEqual(new Date(T0 - DAY_MS)); // 两表同 cutoff
    }
  });

  it('C8 半边 · 改缓存值 ⇒ 下一轮 cutoff 变：100 天旧行在 365 天保留期下存活、改 30 天后下一轮删', async () => {
    const db = new FakeCleanupDb();
    db.records.push({ ended_at: new Date(T0 - 100 * DAY_MS) });
    db.players.push({ ended_at: new Date(T0 - 100 * DAY_MS) });
    const { cache, retentionDays } = makeCache({ days: 365 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);

    await svc.runCleanupOnce(T0); // 第 1 轮：保留 365 天 ⇒ 100 天旧行**界内**，不被删
    expect(db.records).toHaveLength(1);
    expect(retentionDays).toHaveBeenCalledTimes(1); // 每轮读缓存（不是构造时读一次）
    expect(deletesFor(db, 'game_records')[0]!.params[0]).toEqual(new Date(T0 - 365 * DAY_MS));

    retentionDays.mockReturnValue(30); // 改键 + 缓存已刷新（缓存侧由 config-cache.test.ts 钉）
    await svc.runCleanupOnce(T0); // 第 2 轮：同一 now、cutoff 变了 ⇒ 该行出界
    expect(db.records).toHaveLength(0);
    expect(db.players).toHaveLength(0);
    expect(retentionDays).toHaveBeenCalledTimes(2);
    expect(deletesFor(db, 'game_records')[1]!.params[0]).toEqual(new Date(T0 - 30 * DAY_MS));
  });

  it('日志：每轮一条九字段行（删除行数 + 耗时；timer 来源 + 自建 id）—— 零删除轮也留心跳', async () => {
    const db = new FakeCleanupDb();
    db.records.push({ ended_at: new Date(Date.now() - 400 * DAY_MS) });
    const { cache } = makeCache({ days: 365 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS);
    const rounds = (): LogRecord[] =>
      captured.records.filter((r) => r.msg.includes('records cleanup done'));
    expect(rounds()).toHaveLength(1);
    const line = rounds()[0]!;
    expect(line.level).toBe('log');
    expect(line.source).toBe('timer'); // 定时器起的一轮 ⇒ 来源如实（不是 bootstrap）
    expect(line.traceId).not.toBeNull(); // 每轮自建 id
    expect(line.msg).toContain('deletedRecords=1');
    expect(line.msg).toContain('deletedPlayers=0');
    expect(line.msg).toMatch(/durationMs=\d+/);
    expect(line.msg).toContain('retentionDays=365');

    await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_DEFAULT_INTERVAL_MS); // 第 2 轮：零删除
    expect(rounds(), '零删除轮也留一条心跳（否则 1h 一轮的循环「活着没有」无法从日志判读）').toHaveLength(2);
    expect(rounds()[1]!.msg).toContain('deletedRecords=0');

    svc.onApplicationShutdown();
  });

  it('失败姿态：一轮抛 ⇒ error 行（timer 来源）且循环继续（下一轮照排、照删）', async () => {
    const db = new FakeCleanupDb();
    db.records.push({ ended_at: new Date(Date.now() - 400 * DAY_MS) });
    db.failuresRemaining = 1;
    const { cache } = makeCache({ days: 365, intervalMs: 100 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS);
    const errors = captured.records.filter((r) => r.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toContain('records cleanup failed');
    expect(errors[0]!.source).toBe('timer');
    expect(errors[0]!.traceId).not.toBeNull();
    expect(db.records, '第 1 轮失败：一行未删').toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(db.records, '第 2 轮照常跑（失败不终止循环）').toHaveLength(0);

    svc.onApplicationShutdown();
  });

  it('关停闸：第 1 轮在途时关停 ⇒ 迟到的回执不再排下一轮（片⑦ T6/T7 的同款闸）', async () => {
    const db = new FakeCleanupDb();
    const { cache } = makeCache({ days: 365, intervalMs: 100 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);
    svc.onModuleInit();

    const gate = db.holdNextQuery();
    await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS); // 第 1 轮在途（挂起）
    expect(db.statements, '反空测：第 1 轮必须真的在途').toHaveLength(1);

    svc.onApplicationShutdown(); // 在途期间关停
    gate.resolve({ affectedRows: 0 }); // 迟到的回执（第 1 轮结束）
    await vi.advanceTimersByTimeAsync(0);
    const settled = db.statements.length; // 本轮自己的收尾查询已落

    expect(
      (svc as unknown as { timer: unknown }).timer,
      '关停后不得再排定时器（闸被删掉时这里会非 null）',
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * RECORDS_CLEANUP_DEFAULT_INTERVAL_MS);
    expect(db.statements, '放行后不得再跑（无复活循环）').toHaveLength(settled);
  });

  /**
   * 监控片 T6（规格 §2.2 的四行 / C12 单测半边）：四指标写点。
   *
   * ⚠️ 指标是模块级单例（与 shared registry 同一份）：跨用例累计 ⇒ 计数断言一律
   * 「前值 + Δ」；两个 gauge 用显式 `set/reset` 构造前置状态（用例内注释说明）。
   */
  describe('监控片 T6：记录清理四指标', () => {
    it('T6①：成功一轮 ⇒ last_success = 成功时刻（秒）且 rows_deleted 计数 = 返回值', async () => {
      const db = new FakeCleanupDb();
      db.records.push({ ended_at: new Date(T0 - 400 * DAY_MS) });
      db.records.push({ ended_at: new Date(T0 - 401 * DAY_MS) });
      const { cache } = makeCache({ days: 365 });
      const svc = new RecordsCleanupService(db.dataSource as never, cache);
      vi.setSystemTime(T0); // 时钟注入贯穿「成功时间戳」的判据（== T0/1000，逐秒相等）
      const before = await labeledMetricByGame('records_rows_deleted_total', { game_type: 'doudizhu' });

      const result = await svc.runCleanupOnce(T0);

      expect(result.recordsDeleted).toBe(2);
      expect(await simpleMetric('records_cleanup_last_success_timestamp_seconds')).toBe(T0 / 1000);
      expect(await labeledMetricByGame('records_rows_deleted_total', { game_type: 'doudizhu' })).toBe(before + 2);
    });

    it('T6②：从未成功（onModuleInit 后未跑轮）⇒ last_success 置 0（C12 初值语义）', async () => {
      recordsCleanupLastSuccessTimestampSeconds.set(123); // 模拟「别处留下的旧值」——init 必须把它归 0
      const db = new FakeCleanupDb();
      const { cache } = makeCache({ days: 365 });
      const svc = new RecordsCleanupService(db.dataSource as never, cache);

      svc.onModuleInit();

      expect(
        await simpleMetric('records_cleanup_last_success_timestamp_seconds'),
        '「从未成功」= 0 ⇒ RecordsCleanupStalled 规则（time() - 值 > 7200）必然命中',
      ).toBe(0);
      svc.onApplicationShutdown();
    });

    it('T6③：失败一轮 ⇒ failures +1 且 last_success 保持不变（两轮都走计时环）', async () => {
      const db = new FakeCleanupDb();
      db.records.push({ ended_at: new Date(T0 - 400 * DAY_MS) });
      const { cache } = makeCache({ days: 365, intervalMs: 100 });
      const svc = new RecordsCleanupService(db.dataSource as never, cache);
      vi.setSystemTime(T0);
      svc.onModuleInit();

      await vi.advanceTimersByTimeAsync(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS); // 首轮成功
      const ts = await simpleMetric('records_cleanup_last_success_timestamp_seconds');
      expect(ts).toBe((T0 + RECORDS_CLEANUP_FIRST_RUN_DELAY_MS) / 1000);

      const beforeFailures = await simpleMetric('records_cleanup_failures_total');
      db.failuresRemaining = 1;
      await vi.advanceTimersByTimeAsync(100); // 第 2 轮失败（注入间隔 100ms）

      expect(await simpleMetric('records_cleanup_failures_total')).toBe(beforeFailures + 1);
      expect(
        await simpleMetric('records_cleanup_last_success_timestamp_seconds'),
        '失败轮不得擦掉成功时间戳（否则 RecordsCleanupStalled 无法判读「多久没成功」）',
      ).toBe(ts);
      svc.onApplicationShutdown();
    });

    it('T6④：table_bytes 采样查询抛 ⇒ 清理仍完整返回（仅 WARN；时间戳/删除计数照写、旧值保留）', async () => {
      const db = new FakeCleanupDb();
      db.records.push({ ended_at: new Date(T0 - 400 * DAY_MS) });
      db.players.push({ ended_at: new Date(T0 - 400 * DAY_MS) });
      db.failTableBytes = true;
      const { cache } = makeCache({ days: 365 });
      const svc = new RecordsCleanupService(db.dataSource as never, cache);
      vi.setSystemTime(T0);
      recordsTableBytes.set(777); // 上一次采样值：本次采样失败不得擦（≈ carry-forward）
      const beforeDeleted = await labeledMetricByGame('records_rows_deleted_total', { game_type: 'doudizhu' });

      const result = await svc.runCleanupOnce(T0);

      expect(result).toEqual({ recordsDeleted: 1, playersDeleted: 1 });
      expect(db.records, '删除照常完成').toHaveLength(0);
      expect(db.players).toHaveLength(0);
      expect(await simpleMetric('records_table_bytes'), '采样失败：保留旧值').toBe(777);
      expect(await simpleMetric('records_cleanup_last_success_timestamp_seconds')).toBe(T0 / 1000);
      expect(await labeledMetricByGame('records_rows_deleted_total', { game_type: 'doudizhu' })).toBe(beforeDeleted + 1);
      const warns = captured.records.filter((r) => r.level === 'warn');
      expect(
        warns.some((r) => r.msg.includes('records table bytes sampling failed')),
        '采样失败必须留痕（WARN），否则「读数为什么是旧值」无从判读',
      ).toBe(true);
    });

    it('T6⑤：采样成功 ⇒ table_bytes = 回执值；语句形状自证（information_schema + DATA/INDEX + 两表）', async () => {
      const db = new FakeCleanupDb();
      db.tableBytes = 5_242_880;
      const { cache } = makeCache({ days: 365 });
      const svc = new RecordsCleanupService(db.dataSource as never, cache);

      await svc.runCleanupOnce(T0);

      expect(await simpleMetric('records_table_bytes')).toBe(5_242_880);
      const sample = db.statements.find((s) => s.sql.includes('information_schema'));
      expect(sample?.sql, '两列都要进求和（只查 DATA_LENGTH = 漏索引体积）').toContain('DATA_LENGTH');
      expect(sample?.sql).toContain('INDEX_LENGTH');
      expect(sample?.params, '四张表（ddz + pdk 各两表，RH1-a）').toEqual([
        'game_records',
        'game_record_players',
        'game_records_pdk',
        'game_record_players_pdk',
      ]);
    });
  });
});

describe('A1：记录清理按玩法计数', () => {
  it('pdk 0 行也写序列', async () => {
    const db = new FakeCleanupDb();
    db.records.push({ ended_at: new Date(T0 - 400 * DAY_MS) });
    db.records.push({ ended_at: new Date(T0 - 401 * DAY_MS) });
    const { cache } = makeCache({ days: 365 });
    const svc = new RecordsCleanupService(db.dataSource as never, cache);
    const beforeDdz = await labeledMetricByGame('records_rows_deleted_total', { game_type: 'doudizhu' });
    const beforePdk = await labeledMetricByGame('records_rows_deleted_total', { game_type: 'paodekuai' });

    await svc.runCleanupOnce(T0);

    expect(await labeledMetricByGame('records_rows_deleted_total', { game_type: 'doudizhu' })).toBe(beforeDdz + 2);
    expect(await labeledMetricByGame('records_rows_deleted_total', { game_type: 'paodekuai' })).toBe(beforePdk);
    const text = await metricsRegistry().metrics();
    expect(
      text,
      'pdk 0 行也必须显式写出 0 序列（否则「分玩法可见」在无 pdk 清理时不成立）',
    ).toContain('records_rows_deleted_total{game_type="paodekuai"} 0');
  });
});
