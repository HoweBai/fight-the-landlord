// packages/room-service/src/rooms/rooms.autostart.ts
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { runWithTrace } from '@fight-the-landlord/shared';
import { RoomsService, type Room } from './rooms.service';
import { RoomStartService } from './rooms.start';
import { ConfigCacheService } from '../config/config-cache.service';

/**
 * **手动房间的自动开局扫描器**（本片 · spec §2.1 / §3.3 / R901）。
 *
 * 为什么是**扫描**而不是「建房时挂一个 `setTimeout`」：
 *  - 每房间的定时器在**进程重启**时会静默丢失（房间从此卡死）；
 *  - 与既有的两条循环（匹配 5s / 回收 60s）形成第三套调度，重启后行为不一致。
 * ⇒ 照 `RoomsReaperTask` 的成例：`OnModuleInit` 起循环，重启后下一轮自然捡起来。
 *
 * **它自己不做任何开局/补位**：一律委托 `RoomStartService.startRoom` —— 那是两条路径
 * 共用的唯一开局链（`playing` 的写入点因此只有一处，见 R909/R915）。
 *
 * 判据只有两条（用户裁决）：
 *  - **满座 ⇒ 立刻开**（不等死线）；
 *  - **缺人且已越死线 ⇒ 开**（`startRoom` 内部先补机器人）。
 */
@Injectable()
export class RoomsAutostartTask implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RoomsAutostartTask.name);
  /**
   * 扫描循环的定时器。片⑦ T7 起是 **`setTimeout` 自重排链**（不再是 `setInterval`；
   * 周期来自 `configCache.cycleMs('room.autostartIntervalMs')` —— env 常量
   * `AUTOSTART_SCAN_INTERVAL_MS` 已退役）。
   */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸（照 `ConfigCacheService` 的成例）：在途一轮的迟到自重排不得复活循环。 */
  private shuttingDown = false;

  constructor(
    private readonly rooms: RoomsService,
    private readonly roomStart: RoomStartService,
    private readonly configCache: ConfigCacheService,
  ) {}

  onModuleInit(): void {
    this.startScanLoop();
  }

  onApplicationShutdown(): void {
    // 🔴 第一行置闸：在途一轮的 `.finally` 据此不再排新定时器（否则循环会在关停后复活）。
    this.shuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 起扫描循环。片⑦ T7：`setInterval` → **`setTimeout` 自重排链**（同构模板见
   * `rooms.reaper.ts` / `match.service.ts`）。口径（M-6/C9）：**当前一轮按旧值跑完 ⇒
   * 其后按新值排下一轮** —— 周期在**排下一轮时**从 `configCache.cycleMs()` 现读。
   */
  startScanLoop(): void {
    if (this.timer) return;
    this.scheduleNext();
    this.logger.log(
      `Autostart scan loop started (interval: ${this.configCache.cycleMs('room.autostartIntervalMs')}ms)`,
    );
  }

  /** 排下一轮（周期**现读** —— C9 的口径落点）。 */
  private scheduleNext(): void {
    this.timer = setTimeout(() => this.runOnce(), this.configCache.cycleMs('room.autostartIntervalMs'));
  }

  /**
   * 一轮（既有定时回调体原文：ALS 包裹 + 轮级 catch；末尾接自重排）。
   *
   * **R1107 / 复核⑭**：**轮级 catch**（`Autostart scan failed`）也必须有来源 —— 它由
   * 定时回调直接注册，不在 `scanOnce` 的 ALS 之内 ⇒ 不包就会落在
   * `bootstrap`（**假话**：这行恰恰说明**一轮定时扫描**失败了）。
   *
   * `traceId: null` 是**接受的取舍**（spec §6 已登记）：这一层看不到内层工作单元
   *（`scanOnce` 自建）的 id；替代方案要给工作方法加签名参数，代价大于收益。
   */
  private runOnce(): void {
    runWithTrace({ traceId: null, source: 'timer' }, () => {
      void this.scanOnce()
        .catch((err) => this.logger.error(`Autostart scan failed: ${String(err)}`))
        .finally(() => {
          // 🔴 关停闸：在途一轮的迟到回执不得在关停后再排定时器（T6 修复轮的同一纪律）。
          if (!this.shuttingDown) this.scheduleNext();
        });
    });
  }

  /**
   * 立刻扫一轮（测试与联调用，不等下一个周期）。
   *
   * **R1107 / 判据 11**：与 `RoomsReaperTask.reapOnce` **同形** —— 一轮 = 一个自建 traceId
   * + `source: 'timer'`（定时器起的一轮不是「没有来源」，而是以「**这一轮**扫描」为来源）。
   * 包裹点在**方法体外层**（方法体逐字搬进 `scanOnceInner`），`startScanLoop` 的周期回调
   * 与手动调用因此共用同一条链；搬家不改任何判定逻辑。
   */
  async scanOnce(): Promise<void> {
    return runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => this.scanOnceInner());
  }

  /** ALS 包裹外的那一层：与 `scanOnce` 同一实现，逐字搬自原方法体。 */
  private async scanOnceInner(): Promise<void> {
    const rooms = await this.rooms.findAll();
    for (const room of rooms) {
      try {
        if (await this.shouldStart(room)) {
          await this.roomStart.startRoom(room.code, { strict: true });
        }
      } catch (err) {
        // 单个房间失败**不得**拖垮整轮（一条坏数据不该让其余房间永远开不了局）
        this.logger.error(`Autostart failed for room ${room.code}: ${String(err)}`);
      }
    }
  }

  /**
   * 这个房间该开了吗？
   *
   * ⚠️ **只认「有补位死线」的房间**：死线是**手动房**独有的标记
   *（`POST /api/rooms` 建房时写下、占用变化时重抽）。匹配路径的房间没有它 ——
   * 那条链由 `MatchService` 自己驱动（§8.2/§8.4），**不能**被本扫描器碰，
   * 否则会与匹配的 30 秒窗口打架。
   */
  private async shouldStart(room: Room): Promise<boolean> {
    if (room.status !== 'waiting') return false; // 幂等：已经开着的房间不再碰
    if (room.players.length === 0) return false; // 空房：没人在等，开了也没意义

    const fillAt = await this.rooms.readFillDeadline(room.code);
    if (fillAt === null) return false; // 不是手动房（没有死线）

    // 满座 ⇒ 立刻开（用户裁决：房间满即开局，**不再**等死线）
    if (room.players.length >= room.maxPlayers) return true;
    // 缺人 ⇒ 等死线（时钟由 `RoomsService` 注入，判据才可判）
    return this.rooms.now() >= fillAt;
  }
}
