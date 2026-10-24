// packages/robot-service/src/robot/robot.reclaim.task.ts
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { runWithTrace } from '@fight-the-landlord/shared';
import { RobotPool } from './robot.pool';
// ⚠️ **值导入**（DI 陷阱纪律）：容器要按类型解析构造参数。
import { ConfigCacheService } from '../config/config-cache.service';

/**
 * §9.6 的**定期回收任务**：回收 `idleSince` 超过 10 分钟且房间已不存在的空闲机器人。
 *
 * ⚠️ 「对局中的机器人**不得**回收」这条判定在 `RobotPool.reclaimIdle()` 里
 * （`room:{roomCode}` 仍存在 ⇒ 留着），本类只负责**节奏**。
 *
 * ─── 片⑦ E5（design D3；同 T7 模板）──────────────────────────────────────
 * 周期不再来自 env 常量（`ROBOT_RECLAIM_INTERVAL_MS` 已退役）—— 改读
 * `configCache.reclaimIntervalMs()`；`setInterval` → `setTimeout` **自重排链**
 * （C9 口径：**当前一轮按旧值跑完 ⇒ 其后按新值排下一轮** —— 周期在排下一轮时现读）；
 * 带**关停闸**（在途一轮的迟到回执不得在关停后复活循环 —— 与 `ConfigCacheService`
 * 同款的两半判据）。
 */
@Injectable()
export class RobotReclaimTask implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RobotReclaimTask.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸（照 `ConfigCacheService`/`RoomsReaperTask` 的成例）。 */
  private shuttingDown = false;

  constructor(
    private readonly pool: RobotPool,
    private readonly configCache: ConfigCacheService,
  ) {}

  onModuleInit(): void {
    this.startReclaimLoop();
  }

  startReclaimLoop(): void {
    if (this.timer) return;
    this.scheduleNext();
    this.logger.log(
      `Idle robot reclaim loop started (interval: ${this.configCache.reclaimIntervalMs()}ms)`,
    );
  }

  /** 排下一轮（周期**现读** —— C9 的口径落点）。 */
  private scheduleNext(): void {
    this.timer = setTimeout(() => this.runOnce(), this.configCache.reclaimIntervalMs());
  }

  /**
   * 一轮（既有定时回调体原文：ALS 包裹 + 轮级 catch；末尾接自重排）。
   *
   * **R1107 / 复核⑭**：本循环也是**定时器驱动**的一轮工作（spec §3 载体表的「定时器」行）。
   * 与 `RoomsReaperTask` / `RoomsAutostartTask` 的包法**同形但包裹点在回调体**：那里一轮的
   * 工作在**可被直接调用的工作方法**里（自包），而这里的工作**就在回调里**（直接调
   * `pool.reclaimIdle()`，不经任务类自己的方法）⇒ 一轮工作与**轮级 catch**
   * （`Idle reclaim failed`）**共用同一个 id**（每轮自建 traceId + `source: 'timer'`）。
   *
   * ⚠️ **不**改 `robot.pool.ts`：它是库，被测试/运维直接调用，定时器语义不属于它
   *（手动半边 `reclaimOnce()` 是它的薄别名 —— 不在本循环的包裹范围内）。
   */
  private runOnce(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      void this.pool
        .reclaimIdle()
        .catch((err) => this.logger.error(`Idle reclaim failed: ${String(err)}`))
        .finally(() => {
          // 🔴 关停闸：在途一轮的迟到回执不得在关停后再排定时器（T6 修复轮的同一纪律）。
          if (!this.shuttingDown) this.scheduleNext();
        });
    });
  }

  /** 立即跑一次（测试与运维用，不等下一个周期）。 */
  async reclaimOnce(): Promise<string[]> {
    return this.pool.reclaimIdle();
  }

  onApplicationShutdown(): void {
    // 🔴 第一行置闸：在途一轮的 `.finally` 据此不再排新定时器（否则循环会在关停后复活）。
    this.shuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
