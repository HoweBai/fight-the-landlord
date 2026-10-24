// packages/user-service/src/records/records-cleanup.service.ts
import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runWithTrace } from '@fight-the-landlord/shared';
import {
  ConfigCacheService,
  RECORDS_CLEANUP_DEFAULT_INTERVAL_MS,
  SNAPSHOT_BOOT_WAIT_MS,
} from '../config/config-cache.service';
import {
  recordsCleanupFailuresTotal,
  recordsCleanupLastSuccessTimestampSeconds,
  recordsRowsDeletedTotal,
  recordsTableBytes,
} from './records.metrics';

/** 默认清理间隔（规格 §2.5：1h）—— 唯一真源已迁 `ConfigCacheService`（本片 T4）；此处 re-export 保引用面。 */
export { RECORDS_CLEANUP_DEFAULT_INTERVAL_MS };
/** 启动后首轮延迟（规格 §2.5：30s；配置面只改**间隔**，不改它）。 */
export const RECORDS_CLEANUP_FIRST_RUN_DELAY_MS = 30_000;
/** 批删每批上限（设计 D5：`LIMIT 1000`）。 */
export const RECORDS_CLEANUP_BATCH_SIZE = 1_000;

/** 一天毫秒（cutoff 换算；不做日期串解析 —— 全链 epoch ms 口径）。 */
const DAY_MS = 86_400_000;

/** 一轮的删除读数（日志之外的机械回执；测试与运维用）。 */
export interface RecordsCleanupRoundResult {
  recordsDeleted: number;
  playersDeleted: number;
}

/**
 * 保留期清理（记录片 T7 / 规格 §2.5 / 设计 D5）：按 `record.retentionDays`（配置中心第 10 键，
 * 缓存缺省 365）删掉两表里 `ended_at` 越界的旧行。
 *
 * ─── 节奏（规格 §2.5 逐字写死；本片 ⚙️5–⚙️7：间隔 = 配置第 40 键 `record.cleanupIntervalMs`）──────
 *  - 默认间隔 **1h**（缺键/坏值/快照整体不可用 ⇒ 回落种子常数 —— 唯一真源 = `ConfigCacheService`）；
 *    **启动后 30s 首轮**（常数，不受配置影响）。间隔**排期处现读**
 *    （`resolveIntervalMs()` ⇒ `configCache.recordsCleanupIntervalMs()`）——
 *    旧 env 注入面 `RECORDS_CLEANUP_INTERVAL_MS` 已退役（本片 ⚙️8）。
 *  - 🔴 **自调度自重排**（`setTimeout` → 一轮跑完再排下一轮）：**当前一轮按旧值跑完 ⇒
 *    其后按现读的缓存值排期**（已排定的一轮不撤；改键最坏在「本间隔 + 新间隔」内生效 ——
 *    `setInterval` 无法承载「重排现读」的口径）。
 *  - 🔴 **首排动作**（本片 ⚙️5）：`onModuleInit` **同步返回**；`hasSnapshot()` 就绪 ⇒ 同帧
 *    解析+打+排；未就绪 ⇒ 有界等待 `race(首快照, SNAPSHOT_BOOT_WAIT_MS)` —— 两路经 **once 闸**
 *    汇入 `afterSnapshotReady()`（至多一次：超时后快照迟到 ⇒ 就绪路 no-op，败方定时器清除），
 *    超时路按缺省解析先排期、下一轮重排自愈。等待发生在**排期面**（不阻塞容器就绪）。
 *  - ⚠️ 配置的是**间隔**，不是首轮延迟：首轮恒在启动 30s 后（规格 §2.5 的两个数字是两条独立事实；
 *    短间隔的真栈用例（C8）在容器启动 ≤30s 内即可观察到第一轮）。
 *
 * ─── 删除语义（设计 D5）──────────────────────────────────────────────────
 *  - **cutoff = now − retentionDays 天**，`ended_at < cutoff` **严格小于**才删（未满保留期一行不动）。
 *  - **批删**：每表 `DELETE … WHERE ended_at < ? LIMIT 1000` 循环，直到一批删不满 1000 为止
 *    （长事务 = 锁与复制延迟的放大器；批删把它压到单批量级）。两表**各自**成环
 *    （无外键约束，`ended_at` 在 players 上是冗余列 —— 见迁移 DDL 注释）。
 *  - **players 先、records 后**：读取面（`RecordsService`）从 players 侧 JOIN 出发 ⇒ 先删 players
 *    的窗口里旧记录行**不可达**（不会出现「记录可见但 players 只回 0/1 条」的残缺页）；
 *    反序则可能短暂可见残缺页。两表都在同一轮内处理，最终一致。
 *  - 🔴 **多实例登记**（设计 D5）：DELETE 幂等、per-实例读缓存互不干扰（无需锁/选举）；
 *    极端下两实例同轮批删同一区间 ⇒ 后到者 affected 变少 —— 无副作用（先例形态见
 *    `rooms.start.ts` 的 startRoom 头注）。
 *
 * ─── 日志（九字段 NDJSON 信封由 shared 统一承载）────────────────────────────
 *  每轮一条 `records cleanup done: … deletedRecords=… deletedPlayers=… durationMs=…`
 *  （零删除轮也留一条**心跳** —— 否则「1h 一轮的循环活着没有」无法从日志判读）；
 *  一轮抛 ⇒ **error 行**且循环继续（失败不终止；下一轮照排）。来源 `source: 'timer'` +
 *  每轮自建 traceId（「这一轮」就是来源；`bootstrap` 不得当兜底用）。
 *
 * ─── 指标（监控片 T6 / 规格 §2.2；定义见 `records.metrics.ts`）────────────────
 *  四个写点（= RecordsCleanupStalled / RecordsCleanupFailing 两条规则的读面）：
 *   - `onModuleInit` **先置** `records_cleanup_last_success_timestamp_seconds = 0`
 *     （「从未成功」也命中告警）**再**排首轮；
 *   - 成功分支（`runCleanupInner` 尾）：set 时间戳（秒）+ `records_rows_deleted_total.inc(recordsDeleted)`
 *     + `records_table_bytes`（`information_schema` 两表 DATA+INDEX 求和——**采样失败仅 WARN，
 *     绝不影响清理本身**，值保留上一次）；
 *   - 失败 catch（`runRound`）：`records_cleanup_failures_total.inc()`（失败轮**不擦**成功时间戳）。
 */
@Injectable()
export class RecordsCleanupService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RecordsCleanupService.name);
  /** 自重排定时器（`setTimeout` 链；片⑦ 三处循环的同款形态）。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸（照 `ConfigCacheService` / `rooms.reaper.ts` 的成例）：在途一轮的迟到自重排不得复活循环。 */
  private shuttingDown = false;

  constructor(
    /** ⚠️ `DataSource` 是**值导入** + 显式 `@Inject`（DI 陷阱纪律；本仓既有惯例）。 */
    @Inject(DataSource) private readonly dataSource: DataSource,
    private readonly configCache: ConfigCacheService,
  ) {}

  onModuleInit(): void {
    // 监控片 T6：**先置 0**（「从未成功」语义 —— 首启 / 一直失败都要被
    // RecordsCleanupStalled 命中）**再**进首排动作（本片 ⚙️5；排首轮在其内）。顺序即语义，别对调。
    recordsCleanupLastSuccessTimestampSeconds.set(0);
    this.bootFirstScheduling();
  }

  /**
   * 首排动作（本片 ⚙️5，D2；`onModuleInit` **同步返回**，此处不阻塞容器就绪）：
   *
   * - **快路径（真同步）**：`hasSnapshot()` 就绪 ⇒ 同帧解析+打启动行+排首轮（不经 await/微任务）；
   * - **有界等待**：未就绪 ⇒ `race(首快照, SNAPSHOT_BOOT_WAIT_MS)` —— 超时/就绪两路经 **once 闸
   *   `settle`** 汇入（先到先赢、后到 no-op、败方定时器清除）。🔴 不可放宽：没有它，「超时后
   *   快照迟到」会二次排期（双链 —— `onApplicationShutdown` 只清得掉一个句柄，另一条链复活）；
   * - 降级拓扑（配置服务不可用）：≤10s 后按缺省解析先打行排期，下一轮重排自愈。
   */
  private bootFirstScheduling(): void {
    if (this.configCache.hasSnapshot()) {
      this.afterSnapshotReady(); // 快路径：同帧（真同步）
      return;
    }
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.afterSnapshotReady();
    };
    const timeout = setTimeout(settle, SNAPSHOT_BOOT_WAIT_MS);
    void this.configCache.waitForFirstSnapshot().then(settle, settle);
  }

  /**
   * 首排动作**唯一落点**（快/超时/就绪 三路共用；once 闸保证至多一次 —— 见 `bootFirstScheduling`）。
   * 续体先查关停闸（照关停闸纪律）：关停发生在等待期间 ⇒ 迟到的续体不得打行/排期。
   * 解析（`resolveIntervalMs()`，与重排处同一入口）⇒ 打启动行（⚙️6 逐字，interval 位 = 解析值）
   * ⇒ 排首轮（`RECORDS_CLEANUP_FIRST_RUN_DELAY_MS` 常数 —— **配置的是间隔，不是首轮延迟**）。
   */
  private afterSnapshotReady(): void {
    if (this.shuttingDown) return;
    this.logger.log(
      `Records cleanup loop started (first run in ${RECORDS_CLEANUP_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveIntervalMs()}ms)`,
    );
    this.scheduleNext(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS);
  }

  /** 间隔解析（本片 ⚙️7）：启动行与重排处**同一入口**；内部 = 缓存键级 getter（现读）。 */
  private resolveIntervalMs(): number {
    return this.configCache.recordsCleanupIntervalMs();
  }

  /** 排下一轮（30s 首轮常数 / 其后间隔 = 重排处现读 —— 见类注的「配置的是间隔」）。 */
  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => this.runRound(), delayMs);
  }

  /**
   * 定时器起的一轮：ALS 包裹（自建 id + `timer` 来源）→ 跑 → 成败都留痕 → 关停闸后自重排。
   * 轮级 catch 也在同一个包裹里 ⇒ 它的来源同样是「这一轮」（不是无来源的兜底）。
   */
  private runRound(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      void this.runCleanupInner()
        .catch((err: unknown) => {
          // 监控片 T6：失败轮恰一次 inc（与成功分支互斥；时间戳不擦）。
          recordsCleanupFailuresTotal.inc();
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.error(`records cleanup failed: ${reason}`);
        })
        .finally(() => {
          // 🔴 关停闸：在途一轮的迟到回执不得在关停后再排定时器（否则循环在关停后「复活」）；
          // 间隔在**重排处现读**（本片 ⚙️7：改键自该轮收尾排期起生效）。
          if (!this.shuttingDown) this.scheduleNext(this.resolveIntervalMs());
        });
    });
  }

  /**
   * 立即清理一轮（**测试注入 now / 运维手动触发**用，不等下一个周期）。
   *
   * `now` 是**唯一**的时间输入（cutoff = `now − retentionDays` 天）—— 时钟注入点；
   * 测试用固定 `now` 逐毫秒钉边界（真定时链由 fake timers 驱动，见 `records-cleanup.test.ts`）。
   */
  async runCleanupOnce(now: number = Date.now()): Promise<RecordsCleanupRoundResult> {
    return runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => this.runCleanupInner(now));
  }

  /**
   * 一轮的实体（两条入口共用）。**每轮开始时**现读缓存（`retentionDays()`）——
   * 「改键 ⇒ 下一轮 cutoff 变」的落点（C8 的单测半边）。
   */
  private async runCleanupInner(now: number = Date.now()): Promise<RecordsCleanupRoundResult> {
    const retentionDays = this.configCache.retentionDays();
    const cutoff = new Date(now - retentionDays * DAY_MS);
    const startedAtMs = Date.now();

    // 先玩家、后父行（两组各自成对；pdk 表的 `ended_at` 是 BIGINT 毫秒，直接传 number）。
    const playersDeleted =
      (await this.deleteBatches('game_record_players', cutoff)) +
      (await this.deleteBatches('game_record_players_pdk', cutoff.getTime()));
    const recordsDeleted =
      (await this.deleteBatches('game_records', cutoff)) +
      (await this.deleteBatches('game_records_pdk', cutoff.getTime()));

    const durationMs = Date.now() - startedAtMs;
    this.logger.log(
      `records cleanup done: retentionDays=${retentionDays} cutoffMs=${cutoff.getTime()} ` +
        `deletedPlayers=${playersDeleted} deletedRecords=${recordsDeleted} durationMs=${durationMs}`,
    );
    // 监控片 T6：成功分支（时间戳先行 —— 它的可达性不依赖后面的采样）。
    recordsCleanupLastSuccessTimestampSeconds.set(Date.now() / 1000);
    recordsRowsDeletedTotal.inc(recordsDeleted);
    await this.sampleTableBytes();
    return { recordsDeleted, playersDeleted };
  }

  /** 采样覆盖的两张表（与 `deleteBatches` 的表名逐字一致；DDL 见记录迁移注释）。 */
  private static readonly SAMPLED_TABLES = [
    'game_records',
    'game_record_players',
    'game_records_pdk',
    'game_record_players_pdk',
  ] as const;

  /**
   * 监控片 T6：`information_schema` 两表 `DATA_LENGTH + INDEX_LENGTH` 求和 ⇒ `records_table_bytes`。
   *
   * 🔴 **采样失败绝不影响清理本身**：一切异常在内部吞掉记 WARN（读数缺席 ≠ 清理失败 ——
   * 清理由上面已落账；失败时 gauge 保留上一次的值，宁可陈旧也不擦成 0）。
   */
  private async sampleTableBytes(): Promise<void> {
    try {
      const rows = await this.dataSource.query<Array<{ bytes?: number | string }>>(
        'SELECT COALESCE(SUM(`DATA_LENGTH` + `INDEX_LENGTH`), 0) AS bytes ' +
          'FROM information_schema.TABLES ' +
          'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?)',
        [...RecordsCleanupService.SAMPLED_TABLES],
      );
      // 驱动对 SUM(BIGINT) 会回字符串（mysql2 的 Decimal）⇒ Number() 归一；
      // 形状异常（NaN）宁可保留旧值也不写脏数。
      const bytes = Number(rows?.[0]?.bytes ?? 0);
      if (Number.isFinite(bytes)) {
        recordsTableBytes.set(bytes);
      } else {
        this.logger.warn(
          `records table bytes sampling got a non-numeric value (${String(rows?.[0]?.bytes)}); keeping the previous value`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`records table bytes sampling failed (ignored): ${reason}`);
    }
  }

  /**
   * 单表批删循环：`DELETE … WHERE ended_at < ? LIMIT 1000`，直到一批**删不满 1000** 为止
   * （返回本表删除总数）。
   *
   * - 表名来自**代码内字面量联合**（不是外部输入 ⇒ 无注入面）；`LIMIT` 是常量内插。
   * - `affectedRows` 缺失（驱动形态漂移）⇒ 记 0 视作「本批不满」**停止**：最坏是**欠删**，
   *   下一轮（1h 后）继续收敛 —— 绝不为补齐计数冒死循环的风险。
   */
  private async deleteBatches(
    table: 'game_record_players' | 'game_records' | 'game_record_players_pdk' | 'game_records_pdk',
    cutoff: Date | number,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const res = (await this.dataSource.query(
        `DELETE FROM \`${table}\` WHERE \`ended_at\` < ? LIMIT ${RECORDS_CLEANUP_BATCH_SIZE}`,
        [cutoff],
      )) as { affectedRows?: number };
      const affected = Number(res?.affectedRows ?? 0);
      total += affected;
      if (affected < RECORDS_CLEANUP_BATCH_SIZE) return total;
    }
  }

  onApplicationShutdown(): void {
    // 🔴 第一行置闸：在途一轮的 `.finally` 据此不再排新定时器（同款闸的先例见片⑦ 三处循环）。
    this.shuttingDown = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
