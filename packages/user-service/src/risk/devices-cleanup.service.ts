// packages/user-service/src/risk/devices-cleanup.service.ts
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
  RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS,
  SNAPSHOT_BOOT_WAIT_MS,
} from '../config/config-cache.service';

/** 默认清理间隔（规格 §2.8「设备清理」行：1h）—— 唯一真源已迁 `ConfigCacheService`（本片 T4）；此处 re-export 保引用面。 */
export { RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS };
/** 启动后首轮延迟（规格 §2.8：30s；配置面只改**间隔**，不改它）。 */
export const RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS = 30_000;
/** 批删每批上限（规格 §2.8：`LIMIT 1000`）。 */
export const RISK_DEVICES_CLEANUP_BATCH_SIZE = 1_000;

/** 一天毫秒（cutoff 换算；不做日期串解析 —— 全链 epoch ms 口径）。 */
const DAY_MS = 86_400_000;

/** 一轮的删除读数（日志之外的机械回执；测试与运维用）。 */
export interface RiskDevicesCleanupRoundResult {
  devicesDeleted: number;
}

/**
 * 设备记录保留期清理（风控片 T4 / 规格 §2.8「设备清理」行 / 设计 §5.6）：按
 * `risk.deviceRetentionDays`（配置中心第 25 键，缓存缺省 365）删掉 `user_devices` 里
 * `last_seen_at` 越界的旧行。
 *
 * ─── 节奏（骨架逐字照 `records-cleanup.service.ts` 先例；本片 ⚙️5–⚙️7：
 *     间隔 = 配置第 39 键 `risk.devicesCleanupIntervalMs`）──────────────────────
 *  - 默认间隔 **1h**（缺键/坏值/快照整体不可用 ⇒ 回落种子常数 —— 唯一真源 =
 *    `ConfigCacheService`）；**启动后 30s 首轮**（常数，不受配置影响）。间隔**排期处现读**
 *    （`resolveIntervalMs()` ⇒ `configCache.devicesCleanupIntervalMs()`）——
 *    旧 env 注入面 `RISK_DEVICES_CLEANUP_INTERVAL_MS` 已退役（本片 ⚙️8）。
 *  - 🔴 **自调度自重排**（`setTimeout` → 一轮跑完再排下一轮）：**当前一轮按旧值跑完 ⇒
 *    其后按现读的缓存值排期**（已排定的一轮不撤；改键最坏在「本间隔 + 新间隔」内生效 ——
 *    `setInterval` 无法承载「重排现读」的口径）。
 *  - 🔴 **首排动作**（本片 ⚙️5）：`onModuleInit` **同步返回**；`hasSnapshot()` 就绪 ⇒ 同帧
 *    解析+打+排；未就绪 ⇒ 有界等待 `race(首快照, SNAPSHOT_BOOT_WAIT_MS)` —— 两路经 **once 闸**
 *    汇入 `afterSnapshotReady()`（至多一次：超时后快照迟到 ⇒ 就绪路 no-op，败方定时器清除），
 *    超时路按缺省解析先排期、下一轮重排自愈。等待发生在**排期面**（不阻塞容器就绪）。
 *  - ⚠️ 配置的是**间隔**，不是首轮延迟：首轮恒在启动 30s 后。
 *
 * ─── 删除语义（规格 §2.8 逐字）────────────────────────────────────────────
 *  - **cutoff = now − riskDeviceRetentionDays 天**，`last_seen_at < cutoff` **严格小于**
 *    才删（未满保留期一行不动）。
 *  - **批删**：`DELETE FROM user_devices WHERE last_seen_at < ? LIMIT 1000` 循环，直到
 *    一批**删不满 1000** 为止（= 表里已没有出界行，收口于 0 行）——长事务 = 锁与复制
 *    延迟的放大器，批删把它压到单批量级。
 *  - **多实例登记**（同 `records-cleanup.service.ts` / 设计 D5）：DELETE 幂等、per-实例
 *    读缓存互不干扰（无需锁/选举）；极端下两实例同轮批删同一区间 ⇒ 后到者 affected
 *    变少 —— 无副作用。
 *
 * ─── 日志（九字段 NDJSON 信封由 shared 统一承载）────────────────────────────
 *  每轮一条 `risk devices cleanup done: … deletedDevices=… durationMs=…`
 *  （零删除轮也留一条**心跳**）；一轮抛 ⇒ **error 行**且循环继续（失败不终止；下一轮照排）。
 *  来源 `source: 'timer'` + 每轮自建 traceId（`bootstrap` 不得当兜底用）。
 *
 * ⚠️ **本任务不挂指标**（风控四指标里没有清理项；`risk.metrics.ts` 的写点在 T5/T6）。
 */
@Injectable()
export class DevicesCleanupService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DevicesCleanupService.name);
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
    // ⚠️ 本循环**无「先置 0」动作**（风控四指标里没有清理项）—— 直接进首排动作（本片 ⚙️5；
    // 排首轮+启动行在其内）。原 onModuleInit 只有排期+日志，此处**未新增**任何动作。
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
   * ⇒ 排首轮（`RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS` 常数 —— **配置的是间隔，不是首轮延迟**）。
   */
  private afterSnapshotReady(): void {
    if (this.shuttingDown) return;
    this.logger.log(
      `Risk devices cleanup loop started (first run in ${RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveIntervalMs()}ms)`,
    );
    this.scheduleNext(RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS);
  }

  /** 间隔解析（本片 ⚙️7）：启动行与重排处**同一入口**；内部 = 缓存键级 getter（现读）。 */
  private resolveIntervalMs(): number {
    return this.configCache.devicesCleanupIntervalMs();
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
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.error(`risk devices cleanup failed: ${reason}`);
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
   * `now` 是**唯一**的时间输入（cutoff = `now − riskDeviceRetentionDays` 天）—— 时钟
   * 注入点；测试用固定 `now` 逐毫秒钉边界（真定时链由 fake timers 驱动）。
   */
  async runCleanupOnce(now: number = Date.now()): Promise<RiskDevicesCleanupRoundResult> {
    return runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => this.runCleanupInner(now));
  }

  /**
   * 一轮的实体（两条入口共用）。**每轮开始时**现读缓存（`riskDeviceRetentionDays()`）——
   * 「改键 ⇒ 下一轮 cutoff 变」的落点（C20 的单测半边）。
   */
  private async runCleanupInner(now: number = Date.now()): Promise<RiskDevicesCleanupRoundResult> {
    const retentionDays = this.configCache.riskDeviceRetentionDays();
    const cutoff = new Date(now - retentionDays * DAY_MS);
    const startedAtMs = Date.now();

    const devicesDeleted = await this.deleteBatches(cutoff);

    const durationMs = Date.now() - startedAtMs;
    this.logger.log(
      `risk devices cleanup done: retentionDays=${retentionDays} cutoffMs=${cutoff.getTime()} ` +
        `deletedDevices=${devicesDeleted} durationMs=${durationMs}`,
    );
    return { devicesDeleted };
  }

  /**
   * 批删循环：`DELETE FROM user_devices WHERE last_seen_at < ? LIMIT 1000`，直到一批
   * **删不满 1000** 为止（返回本表删除总数）。
   *
   * - 表名/列名是代码内字面量（不是外部输入 ⇒ 无注入面）；`LIMIT` 是常量内插。
   * - `affectedRows` 缺失（驱动形态漂移）⇒ 记 0 视作「本批不满」**停止**：最坏是**欠删**，
   *   下一轮（1h 后）继续收敛 —— 绝不为补齐计数冒死循环的风险（同 records 先例）。
   */
  private async deleteBatches(cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const res = (await this.dataSource.query(
        `DELETE FROM user_devices WHERE last_seen_at < ? LIMIT ${RISK_DEVICES_CLEANUP_BATCH_SIZE}`,
        [cutoff],
      )) as { affectedRows?: number };
      const affected = Number(res?.affectedRows ?? 0);
      total += affected;
      if (affected < RISK_DEVICES_CLEANUP_BATCH_SIZE) return total;
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
