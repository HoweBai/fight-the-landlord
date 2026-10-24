// packages/room-service/src/metrics/room-metrics.service.ts
import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { runWithTrace } from '@fight-the-landlord/shared';
import { Redis } from 'ioredis';
import { roomsActive } from './room.metrics';

/** 采样周期（规格 §2.2：15s）。 */
export const ROOM_METRICS_SAMPLE_INTERVAL_MS = 15_000;

/**
 * room-service 的业务采样器（监控片 · 规格 §2.2：只采 `rooms_active`）。
 *
 * ⚠️ **只采这一个**：本片其余 room 指标各有自己的写点，本服务**不**代劳 ——
 * `ws_connections`/`games_ended_total` 在网关（事件驱动）、`match_queue_length`
 * 挂在匹配扫描环（同一条 config 发条）、`games_started_total` 在开局返回点。
 *
 * ─── 口径（规格 §2.2 行 + Y5）────────────────────────────────────────────
 *  `SCAN room:*` 聚合（游标式，**禁 `KEYS`** —— `rooms.service.ts` 的既有纪律），
 *  **排除派生键**（`room:{code}:seats` / `:cardcount` / `:bots`：`MATCH room:*` 会把
 *  它们一并扫出来）。判别与 `rooms.service.ts` 的 `scanAllRooms()` 逐字同形：
 *  `room:` 之后的尾段含 `:` 即派生键。**全栈口径**：SCAN 是 Redis 键空间聚合
 *  ⇒ 现部署（单实例）下与全局等价（多实例下仍报全栈值，见 HELP）。
 *
 * ─── 节奏（照 `records-cleanup.service.ts` 的 setTimeout 链成例）────────────
 *  15s 自重排；**关停闸**拦住「在途一轮的迟到自重排」（否则 `clearTimeout` 只清得住
 *  已存在的那一个，循环会在关停后「复活」）。
 */
@Injectable()
export class RoomMetricsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RoomMetricsService.name);
  /** 自重排定时器（`setTimeout` 链；片⑦ 三处循环的同款形态）。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸（照 `ConfigCacheService` / `records-cleanup.service.ts` 的成例）。 */
  private shuttingDown = false;

  constructor(private readonly redis: Redis) {}

  onModuleInit(): void {
    this.scheduleNext();
    this.logger.log(
      `Room metrics sampler started (interval: ${ROOM_METRICS_SAMPLE_INTERVAL_MS}ms)`,
    );
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => this.runRound(), ROOM_METRICS_SAMPLE_INTERVAL_MS);
  }

  /**
   * 定时器起的一轮：ALS 包裹（自建 id + `source: 'timer'`）→ 采样 → 关停闸后自重排。
   * 成功路径**不打日志**（15s 一条会淹掉日志面）；失败行落在这一轮的上下文里。
   */
  private runRound(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      void this.sampleOnce()
        .catch((err: unknown) => this.logger.error(`Room metrics sample failed: ${String(err)}`))
        .finally(() => {
          // 🔴 关停闸：在途一轮的迟到回执不得在关停后再排定时器。
          if (!this.shuttingDown) this.scheduleNext();
        });
    });
  }

  /** 采样一次（测试与运维手动触发用，不等下一个周期）。 */
  async sampleOnce(): Promise<void> {
    let cursor = '0';
    let count = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'room:*', 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        // 排除 room:{code}:seats / :cardcount / :bots 这类派生键（与 rooms.service 同形）
        if (key.slice('room:'.length).includes(':')) continue;
        count += 1;
      }
    } while (cursor !== '0');
    roomsActive.set(count);
  }

  onApplicationShutdown(): void {
    // 🔴 第一行置闸（同款闸的先例见片⑦ 三处循环与 records-cleanup）。
    this.shuttingDown = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
