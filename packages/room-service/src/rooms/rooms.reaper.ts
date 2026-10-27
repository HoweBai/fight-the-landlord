// packages/room-service/src/rooms/rooms.reaper.ts
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { runWithTrace } from '@fight-the-landlord/shared';
import { LeaderLease } from '../coordination/leader-lease.service';
import { RoomsService } from './rooms.service';
import { isWaitingExpired } from './rooms.timeout';
import { ConfigCacheService } from '../config/config-cache.service';

/**
 * **N31① + N31② / R523**：房间回收任务 —— 一次收两半。
 *
 * ① **N31①（终局无清理）**：`finished` / `cancelled` 的房间**立即回收**。
 *    旧实现全仓**没有任何删除点**（`grep -rnE "del\(.*room|removeRoom" packages/room-service/src` = 0 命中）
 *    ⇒ 打完的房间以 `finished · 3/3` 留在 `GET /api/rooms` 里**整整一小时**（只能说 `EXPIRE 3600`）。
 * ② **N31②（`isWaitingExpired` 零消费者）**：`waiting` 且越过 `timeoutAt`（§3.1）的房间回收
 *    —— `rooms.timeout.ts` 的那个纯函数由此得到**第一个（也是唯一）消费者**。
 *
 * ⚠️ **判据必须是绝对性质**：回收后 `EXISTS room:{code}` 与**两个派生键**都必须为 0。
 *    「房间总数变少了」这类**相对量**在共享 Redis 上必然假红（R243/R253 的教训：
 *    窗口内任何第三方写入都会让它红，而它对本条要抓的「键还在」完全免疫）。
 * ⚠️ `playing` 的房间**即使** `timeoutAt` 已过也**不得**回收 —— `isWaitingExpired` 用**状态**做判据
 *    （`updateStatus()` 离开 `waiting` 时把 `timeoutAt` 归零，但**不得依赖那个 0**）。
 * ⚠️ 单房间失败只记 error、**继续扫下一个**：一条坏数据不该让整轮回收停摆。
 */
@Injectable()
export class RoomsReaperTask implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RoomsReaperTask.name);

  /** 多副本：定时回调边界的单实例门（属性注入，保持构造签名不变）。 */
  @Optional() @Inject(LeaderLease) private readonly leader: LeaderLease | null = null;
  private leaderGate(): Promise<boolean> {
    return this.leader ? this.leader.isLeader() : Promise.resolve(true);
  }
  /**
   * 回收循环的定时器。片⑦ T7 起是 **`setTimeout` 自重排链**（不再是 `setInterval`；
   * 周期来自 `configCache.cycleMs('room.reapIntervalMs')` —— env 常量 `REAP_INTERVAL_MS`
   * 已退役）。
   */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸（照 `ConfigCacheService` 的成例）：在途一轮的迟到自重排不得复活循环。 */
  private shuttingDown = false;

  constructor(
    private readonly rooms: RoomsService,
    private readonly configCache: ConfigCacheService,
  ) {}

  onModuleInit(): void {
    this.startReapLoop();
  }

  /**
   * 起回收循环。片⑦ T7：`setInterval` → **`setTimeout` 自重排链**（同构模板见
   * `rooms.autostart.ts` / `match.service.ts`）。口径（M-6/C9）：**当前一轮按旧值跑完 ⇒
   * 其后按新值排下一轮** —— 周期在**排下一轮时**从 `configCache.cycleMs()` 现读。
   */
  startReapLoop(): void {
    if (this.timer) return;
    this.scheduleNext();
    this.logger.log(
      `Room reap loop started (interval: ${this.configCache.cycleMs('room.reapIntervalMs')}ms)`,
    );
  }

  /** 排下一轮（周期**现读** —— C9 的口径落点）。 */
  private scheduleNext(): void {
    this.timer = setTimeout(() => this.runOnce(), this.configCache.cycleMs('room.reapIntervalMs'));
  }

  /**
   * 一轮（既有定时回调体原文：ALS 包裹 + 轮级 catch；末尾接自重排）。
   *
   * **R1107 / 复核⑭**：**轮级 catch**（`Room reap failed`）也必须有来源 —— 它由
   * 定时回调直接注册，不在 `reapOnce` 的 ALS 之内 ⇒ 不包就会落在
   * `bootstrap`（**假话**：这行恰恰说明**一轮定时回收**失败了）。
   *
   * `traceId: null` 是**接受的取舍**（spec §6 已登记）：这一层看不到内层工作单元
   *（`reapOnce` 自建）的 id；替代方案要给工作方法加签名参数，代价大于收益。
   */
  private runOnce(): void {
    runWithTrace({ traceId: null, source: 'timer' }, () => {
      void this.leaderGate()
        .then((ok) => (ok ? this.reapOnce() : undefined))
        .catch((err) => this.logger.error(`Room reap failed: ${String(err)}`))
        .finally(() => {
          // 🔴 关停闸：在途一轮的迟到回执不得在关停后再排定时器（T6 修复轮的同一纪律）。
          if (!this.shuttingDown) this.scheduleNext();
        });
    });
  }

  /**
   * 立即回收一轮（测试与运维用，不等下一个周期）。返回被回收的房间号（升序稳定）。
   *
   * **R1107 / 判据 11**：定时器起的一轮**不是**「没有来源」—— 它以「**这一轮**扫描」
   * 为来源 ⇒ 每轮**自建**一个 traceId 并带 `source: 'timer'`（spec §3 载体表的「定时器」行）。
   * ALS 里什么都没有时（进程启动早期这类**真**无来源）才降级成 `traceId: null` + `bootstrap`
   * —— 「无来源不编造」的反面同样成立：**有**来源也不许装作没有。
   *
   * 包裹点选在**方法体外层**（方法体逐字搬进 `reapOnceInner`）：`startReapLoop` 的周期
   * 回调与测试/运维的手动调用都经由 `reapOnce` ⇒ 两条路径共用同一条链。搬家只搬顺序
   * （早返回、单房间 try-catch 一律照旧），**不改任何判定逻辑**。
   */
  async reapOnce(now: number = Date.now()): Promise<string[]> {
    return runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => this.reapOnceInner(now));
  }

  /** ALS 包裹外的那一层：与 `reapOnce` 同一实现，逐字搬自原方法体。 */
  private async reapOnceInner(now: number): Promise<string[]> {
    // ⚠️ 必须用 `listForReap()` 而**不是** `findAll()`：后者刻意把 `cancelled` 排除在对外列表外
    //    ⇒ 用它做枚举会让 `cancelled` 房间**永远扫不到**（而且它对外不可见，属隐形堆积）。
    //    这是本片执行期实测发现的设计交互（见计划 R530）。
    const rooms = await this.rooms.listForReap();
    const reaped: string[] = [];
    for (const room of rooms) {
      const terminal = room.status === 'finished' || room.status === 'cancelled';
      if (!terminal && !isWaitingExpired(room, now)) continue;
      try {
        await this.rooms.deleteRoom(room.code);
        reaped.push(room.code);
      } catch (err) {
        this.logger.error(`Failed to reap room ${room.code}: ${String(err)}`);
      }
    }
    if (reaped.length > 0) {
      this.logger.log(`Reaped ${reaped.length} room(s): ${reaped.join(', ')}`);
    }
    return reaped;
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
